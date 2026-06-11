/**
 * Incremental Embedding Refresh Tracker
 *
 * Background polling loop that detects stale/missing embeddings and
 * refreshes them in small batches. Uses setTimeout chains for natural
 * backpressure instead of setInterval.
 */

import { randomUUID } from "node:crypto";
import type { PipelineEmbeddingTrackerConfig } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceExceptHash, syncVecInsert, vectorToBlob } from "./db-helpers";
import { listStaleEmbeddingRows } from "./embedding-coverage";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmbeddingTrackerStats {
	readonly running: boolean;
	readonly processed: number;
	readonly failed: number;
	readonly skippedCycles: number;
	readonly lastCycleAt: string | null;
	readonly queueDepth: number;
}

export interface EmbeddingTrackerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
	getStats(): EmbeddingTrackerStats;
}

// ---------------------------------------------------------------------------
// Stale embedding row shape
// ---------------------------------------------------------------------------

interface StaleRow {
	readonly id: string;
	readonly content: string;
	readonly contentHash: string;
	readonly currentModel: string | null;
}

interface FailureState {
	readonly count: number;
	readonly retryAt: number;
}

type FailureMap = Map<string, FailureState>;

interface CycleSuccess {
	readonly row: StaleRow;
	readonly vector: readonly number[];
	readonly contentHash: string;
}

interface CycleResult {
	readonly queueDepth: number;
	readonly failed: number;
	readonly results: readonly CycleSuccess[];
}

export function computeEmbeddingRetryBackoffMs(count: number, pollMs: number): number {
	if (count <= 1) return Math.max(pollMs * 5, 60_000);
	if (count === 2) return Math.max(pollMs * 25, 5 * 60_000);
	if (count === 3) return Math.max(pollMs * 150, 30 * 60_000);
	return Math.max(pollMs * 300, 60 * 60_000);
}

function failureKey(row: StaleRow, model: string): string {
	return `${row.id}:${row.contentHash}:${model}`;
}

function clearRowFailures(failures: FailureMap, row: StaleRow, model: string): void {
	const prefix = `${row.id}:`;
	for (const key of failures.keys()) {
		if (!key.startsWith(prefix)) continue;
		if (!key.endsWith(`:${model}`)) continue;
		failures.delete(key);
	}
}

export async function processEmbeddingCycle(
	rows: readonly StaleRow[],
	failures: FailureMap,
	embeddingCfg: EmbeddingConfig,
	pollMs: number,
	fetchEmbeddingFn: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	now: number = Date.now(),
): Promise<CycleResult> {
	const readyRows = rows.filter((row) => {
		const state = failures.get(failureKey(row, embeddingCfg.model));
		if (!state) return true;
		return state.retryAt <= now;
	});

	const results: CycleSuccess[] = [];
	let failed = 0;

	for (const row of readyRows) {
		const key = failureKey(row, embeddingCfg.model);
		const vec = await fetchEmbeddingFn(row.content, embeddingCfg);
		if (vec !== null) {
			clearRowFailures(failures, row, embeddingCfg.model);
			results.push({ row, vector: vec, contentHash: row.contentHash });
			continue;
		}

		failed++;
		const next = (failures.get(key)?.count ?? 0) + 1;
		const wait = computeEmbeddingRetryBackoffMs(next, pollMs);
		failures.set(key, {
			count: next,
			retryAt: now + wait,
		});
		logger.warn("embedding-tracker", "Embedding refresh failed, suppressing retries", {
			memoryId: row.id,
			contentHash: row.contentHash,
			attempt: next,
			retryAfterMs: wait,
		});
	}

	return {
		queueDepth: readyRows.length,
		failed,
		results,
	};
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function startEmbeddingTracker(
	accessor: DbAccessor,
	embeddingCfg: EmbeddingConfig,
	trackerCfg: PipelineEmbeddingTrackerConfig,
	fetchEmbeddingFn: (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>,
	checkProviderFn: (cfg: EmbeddingConfig) => Promise<{ available: boolean }>,
): EmbeddingTrackerHandle {
	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlightPromise: Promise<void> | null = null;

	let processed = 0;
	let failed = 0;
	let skippedCycles = 0;
	let lastCycleAt: string | null = null;
	let lastQueueDepth = 0;
	const failures = new Map<string, FailureState>();

	async function tick(): Promise<void> {
		if (!running) return;

		try {
			// 1. Check provider health (uses existing 30s cache)
			const health = await checkProviderFn(embeddingCfg);
			if (!health.available) {
				skippedCycles++;
				return;
			}

			// 2. Query stale/missing embeddings (read-only)
			const staleRows = accessor.withReadDb((db) => {
				return listStaleEmbeddingRows(db, embeddingCfg.model, trackerCfg.batchSize) as StaleRow[];
			});
			const cycle = await processEmbeddingCycle(staleRows, failures, embeddingCfg, trackerCfg.pollMs, fetchEmbeddingFn);

			lastQueueDepth = cycle.queueDepth;
			lastCycleAt = new Date().toISOString();

			failed += cycle.failed;

			if (cycle.results.length === 0) return;

			// 4. Batch write in a single write transaction
			accessor.withWriteTx((db) => {
				for (const { row, vector, contentHash } of cycle.results) {
					// Delete stale embeddings for this source
					syncVecDeleteBySourceExceptHash(db, "memory", row.id, contentHash);

					// Upsert embedding row
					const embId = randomUUID();
					db.prepare(
						`INSERT INTO embeddings
						   (id, source_type, source_id, content_hash, vector, dimensions, chunk_text, created_at)
						 VALUES (?, 'memory', ?, ?, ?, ?, ?, datetime('now'))
						 ON CONFLICT(content_hash) DO UPDATE SET
						   vector = excluded.vector,
						   dimensions = excluded.dimensions,
						   chunk_text = excluded.chunk_text,
						   created_at = excluded.created_at`,
					).run(embId, row.id, contentHash, vectorToBlob(vector), vector.length, row.content);

					// Sync vec table -- grab the actual id (may be existing on conflict)
					const actualRow = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
						| { id: string }
						| undefined;

					if (actualRow) {
						syncVecInsert(db, actualRow.id, vector);
					}

					// Update embedding_model on the memory row
					db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(embeddingCfg.model, row.id);

					processed++;
				}
			});

			logger.debug("embedding-tracker", `Refreshed ${cycle.results.length} embeddings`);
		} catch (err) {
			logger.warn("embedding-tracker", "Cycle error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	function schedule(): void {
		if (!running) return;
		timer = setTimeout(async () => {
			const p = tick();
			inFlightPromise = p;
			await p;
			inFlightPromise = null;
			schedule();
		}, trackerCfg.pollMs);
	}

	// Kick off the first tick after an initial delay
	schedule();

	logger.info("embedding-tracker", `Started (poll=${trackerCfg.pollMs}ms, batch=${trackerCfg.batchSize})`);

	return {
		get running() {
			return running;
		},
		getStats(): EmbeddingTrackerStats {
			return {
				running,
				processed,
				failed,
				skippedCycles,
				lastCycleAt,
				queueDepth: lastQueueDepth,
			};
		},
		async stop(): Promise<void> {
			running = false;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			if (inFlightPromise) {
				await inFlightPromise;
			}
			logger.info("embedding-tracker", "Stopped");
		},
	};
}

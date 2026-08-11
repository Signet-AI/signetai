/**
 * Incremental Embedding Refresh Tracker
 *
 * Background polling loop that detects stale/missing embeddings and
 * refreshes them in small batches. Uses setTimeout chains for natural
 * backpressure instead of setInterval.
 */

import { randomUUID } from "node:crypto";
import type { PipelineEmbeddingTrackerConfig, PipelineRepairConfig } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceExceptHash, syncVecInsert, vectorToBlob } from "./db-helpers";
import { listStaleEmbeddingRows } from "./embedding-coverage";
import { isActiveEmbeddingConfig } from "./embedding-index-state";
import {
	acquireEmbeddingRepairLease,
	computeRetryBackoffMs,
	finishEmbeddingRepairLease,
	loadEmbeddingRepairFailures,
} from "./embedding-repair-state";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import { isSystemPressureHigh } from "./system-pressure";

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
	readonly failedRows: readonly StaleRow[];
	readonly results: readonly CycleSuccess[];
}

export function computeEmbeddingRetryBackoffMs(count: number, pollMs: number): number {
	return computeRetryBackoffMs(count, pollMs);
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
	const failedRows: StaleRow[] = [];
	let failed = 0;

	for (const row of readyRows) {
		const key = failureKey(row, embeddingCfg.model);
		let vec: number[] | null = null;
		try {
			vec = await fetchEmbeddingFn(row.content, embeddingCfg);
		} catch (error) {
			logger.warn("embedding-tracker", "Embedding refresh request failed", {
				memoryId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (vec !== null) {
			clearRowFailures(failures, row, embeddingCfg.model);
			results.push({ row, vector: vec, contentHash: row.contentHash });
			continue;
		}

		failed++;
		failedRows.push(row);
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
		failedRows,
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
	repairCfg: PipelineRepairConfig,
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
		if (isSystemPressureHigh()) {
			skippedCycles++;
			return;
		}

		try {
			// 1. Check provider health (uses existing 30s cache)
			const health = await checkProviderFn(embeddingCfg);
			if (!health.available) {
				skippedCycles++;
				return;
			}

			// 2. Query stale/missing embeddings (read-only), then merge durable
			// failure backoff so restarting the daemon cannot immediately replay a
			// poison row against the provider.
			const now = Date.now();
			const staleRows = accessor.withReadDb((db) => {
				return listStaleEmbeddingRows(
					db,
					embeddingCfg.model,
					trackerCfg.batchSize,
					new Date(now).toISOString(),
				) as StaleRow[];
			});
			const persistedFailures = loadEmbeddingRepairFailures(
				accessor,
				staleRows.map((row) => ({ id: row.id, contentHash: row.contentHash })),
				embeddingCfg.model,
			);
			for (const [key, state] of persistedFailures) {
				failures.set(key, { count: state.attempts, retryAt: state.retryAt });
			}
			const readyRows = staleRows.filter((row) => {
				const state = failures.get(failureKey(row, embeddingCfg.model));
				return state === undefined || state.retryAt <= now;
			});
			lastQueueDepth = readyRows.length;
			lastCycleAt = new Date(now).toISOString();
			if (readyRows.length === 0) return;

			// The durable lease counts a batch before provider calls. A crash or a
			// second daemon therefore consumes the same budget instead of replaying
			// work indefinitely after each restart.
			const admission = acquireEmbeddingRepairLease(
				accessor,
				repairCfg.reembedCooldownMs,
				repairCfg.reembedHourlyBudget,
				now,
			);
			if (!admission.allowed || admission.lease === undefined) {
				skippedCycles++;
				return;
			}

			try {
				const cycle = await processEmbeddingCycle(
					readyRows,
					failures,
					embeddingCfg,
					trackerCfg.pollMs,
					fetchEmbeddingFn,
					now,
				);
				failed += cycle.failed;

				// Re-check pressure after the async embedding work — the event loop
				// may have degraded during the awaits above. The lease still closes so
				// another process cannot pick up the same batch concurrently.
				if (isSystemPressureHigh()) {
					skippedCycles++;
					finishEmbeddingRepairLease(accessor, admission.lease, {
						successful: [],
						failed: cycle.failedRows,
						model: embeddingCfg.model,
						pollMs: trackerCfg.pollMs,
						error: "system pressure became high before embedding persistence",
					});
					return;
				}

				let applied = false;
				if (cycle.results.length > 0) {
					// Batch write in a single write transaction. A promotion may commit
					// while this batch is encoding, so never let a tracker closed over
					// the previous generation overwrite its vectors.
					applied = accessor.withWriteTx((db) => {
						if (!isActiveEmbeddingConfig(db, embeddingCfg)) return false;
						for (const { row, vector, contentHash } of cycle.results) {
							syncVecDeleteBySourceExceptHash(db, "memory", row.id, contentHash);
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
							const actualRow = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
								| { id: string }
								| undefined;
							if (actualRow) syncVecInsert(db, actualRow.id, vector);
							db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(embeddingCfg.model, row.id);
							processed++;
						}
						return true;
					});
				}

				finishEmbeddingRepairLease(accessor, admission.lease, {
					successful: applied ? cycle.results.map(({ row }) => ({ id: row.id, contentHash: row.contentHash })) : [],
					failed: cycle.failedRows.map((row) => ({ id: row.id, contentHash: row.contentHash })),
					model: embeddingCfg.model,
					pollMs: trackerCfg.pollMs,
					...(applied || cycle.results.length === 0 ? {} : { error: "embedding profile changed before persistence" }),
				});
				logger.debug("embedding-tracker", `Refreshed ${applied ? cycle.results.length : 0} embeddings`);
			} catch (error) {
				finishEmbeddingRepairLease(accessor, admission.lease, {
					successful: [],
					failed: [],
					model: embeddingCfg.model,
					pollMs: trackerCfg.pollMs,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
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

/**
 * Incremental Embedding Refresh Tracker
 *
 * Background polling loop that detects stale/missing embeddings and
 * refreshes them in small batches. Uses setTimeout chains for natural
 * backpressure instead of setInterval.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { PipelineEmbeddingTrackerConfig } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { syncVecDeleteBySourceExceptHash, syncVecInsert, vectorToBlob } from "./db-helpers";
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
				return db
					.prepare(
						`SELECT m.id, m.content, m.content_hash AS contentHash,
						        m.embedding_model AS currentModel
						 FROM memories m
						 LEFT JOIN embeddings e
						   ON e.source_type = 'memory' AND e.source_id = m.id
						 WHERE m.is_deleted = 0
						   AND (
						     e.id IS NULL
						     OR e.content_hash <> m.content_hash
						     OR (m.embedding_model IS NOT NULL
						         AND m.embedding_model <> ?)
						   )
						 ORDER BY m.updated_at DESC
						 LIMIT ?`,
					)
					.all(embeddingCfg.model, trackerCfg.batchSize) as StaleRow[];
			});

			lastQueueDepth = staleRows.length;
			lastCycleAt = new Date().toISOString();

			if (staleRows.length === 0) return;

			// 3. Fetch embeddings sequentially (outside transaction, 30s timeout each)
			const results: Array<{
				readonly row: StaleRow;
				readonly vector: readonly number[];
				readonly contentHash: string;
			}> = [];

			for (const row of staleRows) {
				if (!running) break;
				const vec = await fetchEmbeddingFn(row.content, embeddingCfg);
				if (vec !== null) {
					const hash = createHash("sha256").update(row.content).digest("hex");
					results.push({ row, vector: vec, contentHash: hash });
				} else {
					failed++;
				}
			}

			if (results.length === 0) return;

			// 4. Batch write in a single write transaction
			accessor.withWriteTx((db) => {
				for (const { row, vector, contentHash } of results) {
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

			logger.debug("embedding-tracker", `Refreshed ${results.length} embeddings`);
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

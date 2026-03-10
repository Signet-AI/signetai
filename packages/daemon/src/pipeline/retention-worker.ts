/**
 * Retention worker: purges expired data in safe order.
 *
 * Purge order (spec section 32.5 D2.3):
 *   1. Graph links (memory_entity_mentions for deleted memories)
 *   2. Embeddings for deleted memories
 *   3. Tombstones (hard-delete soft-deleted memories past retention;
 *      FTS cleanup is handled by the memories_ad trigger)
 *   4. History events past retention window
 *   5. Completed jobs past retention window
 *   6. Dead-letter jobs past retention window
 *
 * Runs on a configurable interval. Each purge step is a separate
 * short transaction to avoid holding write locks.
 */

import type { DbAccessor, WriteDb } from "../db-accessor";

/** Typed shape of a row fetched from the memories table for cold archival. */
interface MemoryRow {
	readonly id: unknown;
	readonly type: unknown;
	readonly category: unknown;
	readonly content: unknown;
	readonly confidence: unknown;
	readonly importance: unknown;
	readonly source_id: unknown;
	readonly source_type: unknown;
	readonly tags: unknown;
	readonly who: unknown;
	readonly why: unknown;
	readonly project: unknown;
	readonly content_hash: unknown;
	readonly normalized_content: unknown;
	readonly extraction_status: unknown;
	readonly embedding_model: unknown;
	readonly extraction_model: unknown;
	readonly update_count: unknown;
	readonly created_at: unknown;
	readonly agent_id: unknown;
	readonly [key: string]: unknown;
}
import { countChanges, syncVecDeleteByEmbeddingIds } from "../db-helpers";
import { logger } from "../logger";
import { purgeOldTrainingPairs } from "../predictor-training-pairs";
import { txDecrementEntityMentions } from "./graph-transactions";

export interface RetentionConfig {
	/** How often to run the retention sweep (ms) */
	readonly intervalMs: number;
	/** Soft-deleted memories: ms before hard purge (default 30 days) */
	readonly tombstoneRetentionMs: number;
	/** History events: ms before purge (default 180 days) */
	readonly historyRetentionMs: number;
	/** Completed jobs: ms before purge (default 14 days) */
	readonly completedJobRetentionMs: number;
	/** Dead-letter jobs: ms before purge (default 30 days) */
	readonly deadJobRetentionMs: number;
	/** Max rows to purge per step per sweep (backpressure) */
	readonly batchLimit: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
	intervalMs: 6 * 60 * 60 * 1000, // 6 hours
	tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
	historyRetentionMs: 180 * 24 * 60 * 60 * 1000,
	completedJobRetentionMs: 14 * 24 * 60 * 60 * 1000,
	deadJobRetentionMs: 30 * 24 * 60 * 60 * 1000,
	batchLimit: 500,
};

export interface RetentionHandle {
	stop(): void;
	readonly running: boolean;
	/** Run a single sweep immediately (for testing) */
	sweep(): RetentionSweepResult;
}

export interface RetentionSweepResult {
	graphLinksPurged: number;
	entitiesOrphaned: number;
	embeddingsPurged: number;
	tombstonesPurged: number;
	historyPurged: number;
	completedJobsPurged: number;
	deadJobsPurged: number;
	trainingPairsPurged: number;
}

function purgeGraphLinks(
	db: WriteDb,
	cutoff: string,
	limit: number,
): { mentionsPurged: number; entitiesOrphaned: number } {
	// Find tombstoned memory IDs past retention
	const expiredIds = db
		.prepare(
			`SELECT id FROM memories
			 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
			 LIMIT ?`,
		)
		.all(cutoff, limit) as Array<{ id: string }>;

	if (expiredIds.length === 0) return { mentionsPurged: 0, entitiesOrphaned: 0 };

	const placeholders = expiredIds.map(() => "?").join(", ");
	const ids = expiredIds.map((r) => r.id);

	// Capture affected entity IDs before deleting mention links
	const affectedEntities = db
		.prepare(
			`SELECT DISTINCT entity_id FROM memory_entity_mentions
			 WHERE memory_id IN (${placeholders})`,
		)
		.all(...ids) as Array<{ entity_id: string }>;

	const result = db
		.prepare(
			`DELETE FROM memory_entity_mentions
			 WHERE memory_id IN (${placeholders})`,
		)
		.run(...ids);
	const mentionsPurged = countChanges(result);

	// Decrement entity mention counts and clean orphans
	const entityIds = affectedEntities.map((r) => r.entity_id);
	const { entitiesOrphaned } = txDecrementEntityMentions(db, { entityIds });

	return { mentionsPurged, entitiesOrphaned };
}

function purgeEmbeddings(db: WriteDb, cutoff: string, limit: number): number {
	const expiredIds = db
		.prepare(
			`SELECT id FROM memories
			 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
			 LIMIT ?`,
		)
		.all(cutoff, limit) as Array<{ id: string }>;

	if (expiredIds.length === 0) return 0;

	const placeholders = expiredIds.map(() => "?").join(", ");
	const ids = expiredIds.map((r) => r.id);

	// Sync vec_embeddings before deleting from embeddings
	const embRows = db
		.prepare(
			`SELECT id FROM embeddings
			 WHERE source_type = 'memory' AND source_id IN (${placeholders})`,
		)
		.all(...ids) as Array<{ id: string }>;
	syncVecDeleteByEmbeddingIds(
		db,
		embRows.map((r) => r.id),
	);

	const result = db
		.prepare(
			`DELETE FROM embeddings
			 WHERE source_type = 'memory' AND source_id IN (${placeholders})`,
		)
		.run(...ids);
	return countChanges(result);
}

/**
 * Archive memories to the cold tier before hard-deleting them.
 *
 * Copies the memory rows into `memories_cold` with the given reason.
 * Uses INSERT OR IGNORE so re-archiving the same ID is a no-op.
 * Gracefully skips if the cold table doesn't exist yet (migration
 * may not have run).
 */
export function archiveToCold(
	db: WriteDb,
	memoryIds: ReadonlyArray<string>,
	reason: string,
	coldSourceId?: string,
): void {
	if (memoryIds.length === 0) return;

	// Check if memories_cold table exists (migration may not have run yet)
	const tableExists = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_cold'`)
		.get();
	if (!tableExists) {
		logger.warn("retention", "memories_cold table missing — skipping archival (run migrations)", {
			count: memoryIds.length,
		});
		return;
	}

	const placeholders = memoryIds.map(() => "?").join(", ");
	const now = new Date().toISOString();

	// Fetch full rows so we can store a complete JSON snapshot (truly lossless —
	// captures all columns regardless of future schema additions).
	const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...memoryIds) as MemoryRow[];

	// Each archival event gets a fresh archive_id so multiple snapshots for the
	// same memory (e.g. supersession then purge) are preserved independently.
	const stmt = db.prepare(`
		INSERT INTO memories_cold (
			archive_id, memory_id, type, category, content, confidence, importance,
			source_id, source_type, tags, who, why, project,
			content_hash, normalized_content, extraction_status,
			embedding_model, extraction_model, update_count,
			original_created_at, archived_at, archived_reason,
			cold_source_id, agent_id, original_row_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	for (const row of rows) {
		stmt.run(
			crypto.randomUUID(),
			row.id,
			row.type,
			row.category,
			row.content,
			row.confidence,
			row.importance,
			row.source_id,
			row.source_type,
			row.tags,
			row.who,
			row.why,
			row.project,
			row.content_hash,
			row.normalized_content,
			row.extraction_status,
			row.embedding_model,
			row.extraction_model,
			row.update_count,
			row.created_at,
			now,
			reason,
			coldSourceId ?? null,
			typeof row.agent_id === "string" ? row.agent_id : "default",
			JSON.stringify(row),
		);
	}
}

function purgeTombstones(db: WriteDb, cutoff: string, limit: number): number {
	const expiredIds = db
		.prepare(
			`SELECT id FROM memories
			 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
			 LIMIT ?`,
		)
		.all(cutoff, limit) as Array<{ id: string }>;

	if (expiredIds.length === 0) return 0;

	const placeholders = expiredIds.map(() => "?").join(", ");
	const ids = expiredIds.map((r) => r.id);

	// Archive to cold tier before deleting
	archiveToCold(db, ids, "retention_decay");

	// Hard-delete the memory rows; the memories_ad trigger handles FTS cleanup.
	// We count selected IDs rather than .changes because FTS triggers inflate it.
	db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);

	return expiredIds.length;
}

function purgeHistory(db: WriteDb, cutoff: string, limit: number): number {
	const result = db
		.prepare(
			`DELETE FROM memory_history
			 WHERE created_at < ?
			 LIMIT ?`,
		)
		.run(cutoff, limit);
	return countChanges(result);
}

function purgeCompletedJobs(db: WriteDb, cutoff: string, limit: number): number {
	const result = db
		.prepare(
			`DELETE FROM memory_jobs
			 WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?
			 LIMIT ?`,
		)
		.run(cutoff, limit);
	return countChanges(result);
}

function purgeDeadJobs(db: WriteDb, cutoff: string, limit: number): number {
	const result = db
		.prepare(
			`DELETE FROM memory_jobs
			 WHERE status = 'dead' AND failed_at IS NOT NULL AND failed_at < ?
			 LIMIT ?`,
		)
		.run(cutoff, limit);
	return countChanges(result);
}

function runSweep(accessor: DbAccessor, cfg: RetentionConfig): RetentionSweepResult {
	const now = Date.now();
	const tombstoneCutoff = new Date(now - cfg.tombstoneRetentionMs).toISOString();
	const historyCutoff = new Date(now - cfg.historyRetentionMs).toISOString();
	const completedJobCutoff = new Date(now - cfg.completedJobRetentionMs).toISOString();
	const deadJobCutoff = new Date(now - cfg.deadJobRetentionMs).toISOString();

	// Step 1: graph links for expired tombstones + entity decrement
	const graphResult = accessor.withWriteTx((db) => purgeGraphLinks(db, tombstoneCutoff, cfg.batchLimit));
	const graphLinksPurged = graphResult.mentionsPurged;
	const entitiesOrphaned = graphResult.entitiesOrphaned;

	// Step 2: embeddings for expired tombstones
	const embeddingsPurged = accessor.withWriteTx((db) => purgeEmbeddings(db, tombstoneCutoff, cfg.batchLimit));

	// Step 3: hard-delete tombstoned rows (FTS cleanup via memories_ad trigger)
	const tombstonesPurged = accessor.withWriteTx((db) => purgeTombstones(db, tombstoneCutoff, cfg.batchLimit));

	// Step 4: old history events
	const historyPurged = accessor.withWriteTx((db) => purgeHistory(db, historyCutoff, cfg.batchLimit));

	// Step 5: completed jobs
	const completedJobsPurged = accessor.withWriteTx((db) => purgeCompletedJobs(db, completedJobCutoff, cfg.batchLimit));

	// Step 6: dead-letter jobs
	const deadJobsPurged = accessor.withWriteTx((db) => purgeDeadJobs(db, deadJobCutoff, cfg.batchLimit));

	// Step 7: old predictor training pairs (90-day retention)
	const trainingPairsPurged = purgeOldTrainingPairs(accessor, 90);

	return {
		graphLinksPurged,
		entitiesOrphaned,
		embeddingsPurged,
		tombstonesPurged,
		historyPurged,
		completedJobsPurged,
		deadJobsPurged,
		trainingPairsPurged,
	};
}

export function startRetentionWorker(accessor: DbAccessor, cfg: RetentionConfig = DEFAULT_RETENTION): RetentionHandle {
	let running = true;
	let timer: ReturnType<typeof setInterval> | null = null;

	function doSweep(): RetentionSweepResult {
		const result = runSweep(accessor, cfg);
		const total =
			result.graphLinksPurged +
			result.entitiesOrphaned +
			result.embeddingsPurged +
			result.tombstonesPurged +
			result.historyPurged +
			result.completedJobsPurged +
			result.deadJobsPurged +
			result.trainingPairsPurged;

		if (total > 0) {
			logger.info("retention", "Sweep completed", result);
		}
		return result;
	}

	timer = setInterval(() => {
		if (!running) return;
		try {
			doSweep();
		} catch (e) {
			logger.warn("retention", "Sweep error", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}, cfg.intervalMs);

	logger.info("retention", "Worker started", {
		intervalMs: cfg.intervalMs,
		tombstoneDays: Math.round(cfg.tombstoneRetentionMs / 86400000),
		historyDays: Math.round(cfg.historyRetentionMs / 86400000),
	});

	return {
		get running() {
			return running;
		},
		stop() {
			running = false;
			if (timer) clearInterval(timer);
			logger.info("retention", "Worker stopped");
		},
		sweep: doSweep,
	};
}

/**
 * Startup recovery: automatically clean accumulated crash-loop damage.
 *
 * Under the #1059 death spiral, a daemon that keeps getting SIGKILLed
 * accumulates state that makes the next restart worse: dead jobs pile up,
 * the embeddings_staging buffer grows without draining, and orphaned passes
 * linger. This module runs on every startup (after migrations, before workers
 * start) and cleans that damage automatically — no manual intervention.
 *
 * IMPORTANT: this module is fully synchronous. It must not yield to the event
 * loop (no await, no setTimeout). The reason: during boot, module-level plugin
 * initialization and route registration schedule async operations. If this
 * recovery yields between DB batches, those pending operations run and can
 * touch the DB, conflicting with the write connection and causing
 * "database is locked" crashes. There is nothing to yield TO during boot
 * (no HTTP server, no workers, no competing load).
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";

export interface StartupRecoveryReport {
	readonly walCheckpointed: boolean;
	readonly deadJobsPurged: number;
	readonly stagingRowsCleaned: number;
	readonly orphanedPassesSwept: number;
	readonly durationMs: number;
}

const DEAD_JOB_RETENTION_DAYS = 7;
const BATCH_SIZE = 500;
const JOB_MAX_TOTAL = 50_000;
const STAGING_MAX_TOTAL = 200_000;

/**
 * Synchronous bounded batch drain. No yielding, no pressure checks.
 * Used only during startup recovery where nothing competes for the event loop.
 */
function drainBatchesSync<Item>(
	accessor: DbAccessor,
	fetchBatch: (db: ReadDb, limit: number) => readonly Item[] | null,
	processBatch: (db: WriteDb, items: readonly Item[]) => void,
	maxTotal: number,
): number {
	let processed = 0;
	while (processed < maxTotal) {
		const remaining = maxTotal - processed;
		const limit = Math.min(BATCH_SIZE, remaining);
		const batch = accessor.withReadDb((db) => fetchBatch(db, limit));
		if (!batch || batch.length === 0) break;
		accessor.withWriteTx((db) => processBatch(db, batch));
		processed += batch.length;
	}
	return processed;
}

/**
 * Run startup recovery. Called synchronously after migrations complete and
 * before background workers start. Safe to call on every boot — it is
 * idempotent (a clean workspace cleans nothing; a crash-damaged one heals).
 */
export function runStartupRecovery(accessor: DbAccessor): StartupRecoveryReport {
	const startedAt = Date.now();
	logger.info("startup-recovery", "Running startup recovery");

	let walCheckpointed = false;

	// 1. WAL checkpoint — flush accumulated WAL pages into the main DB file.
	try {
		accessor.checkpointWal();
		walCheckpointed = true;
	} catch (err) {
		logger.warn("startup-recovery", "WAL checkpoint failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 2. Purge old dead jobs.
	const cutoff = new Date(Date.now() - DEAD_JOB_RETENTION_DAYS * 86_400_000).toISOString();
	let deadJobsPurged = 0;
	try {
		deadJobsPurged = drainBatchesSync(
			accessor,
			(db: ReadDb, limit: number) =>
				db
					.prepare(
						`SELECT id FROM memory_jobs
						 WHERE status = 'dead' AND created_at < ?
						 LIMIT ?`,
					)
					.all(cutoff, limit) as Array<{ id: string }>,
			(db: WriteDb, batch: readonly { id: string }[]) => {
				if (batch.length === 0) return;
				const placeholders = batch.map(() => "?").join(",");
				db.prepare(`DELETE FROM memory_jobs WHERE id IN (${placeholders})`).run(...batch.map((b) => b.id));
			},
			JOB_MAX_TOTAL,
		);
	} catch (err) {
		logger.warn("startup-recovery", "Dead job purge failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 3. Clean stale embeddings_staging rows — but ONLY when no embedding
	// index migration is in progress. During a 'building' state, staging rows
	// are migration progress, not redundant data.
	let stagingRowsCleaned = 0;
	try {
		const migrationInProgress = accessor.withReadDb((db) => {
			const tableExists = db
				.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_state'")
				.get() as { n: number } | undefined;
			if (!tableExists?.n) return false;
			const state = db.prepare("SELECT state FROM embedding_index_state WHERE id = 1").get() as { state: string } | undefined;
			return state?.state === "building";
		});

		if (migrationInProgress) {
			logger.info("startup-recovery", "Skipping staging cleanup — embedding index migration in progress");
		} else {
			stagingRowsCleaned = drainBatchesSync(
				accessor,
				(db: ReadDb, limit: number) => {
					const tableExists = db
						.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'embeddings_staging'")
						.get() as { n: number } | undefined;
					if (!tableExists?.n) return null;
					return db
						.prepare(
							`SELECT s.id FROM embeddings_staging s
							 WHERE EXISTS (
							   SELECT 1 FROM embeddings e WHERE e.content_hash = s.content_hash
							 )
							 LIMIT ?`,
						)
						.all(limit) as Array<{ id: string }>;
				},
				(db: WriteDb, batch: readonly { id: string }[]) => {
					if (batch.length === 0) return;
					const placeholders = batch.map(() => "?").join(",");
					db.prepare(`DELETE FROM embeddings_staging WHERE id IN (${placeholders})`).run(...batch.map((b) => b.id));
				},
				STAGING_MAX_TOTAL,
			);
		}
	} catch (err) {
		logger.warn("startup-recovery", "Staging cleanup failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 4. Sweep orphaned dreaming passes.
	let orphanedPassesSwept = 0;
	try {
		orphanedPassesSwept = accessor.withWriteTx((db) => {
			const tableExists = db
				.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_passes'")
				.get() as { n: number };
			if (tableExists?.n === 0) return 0;
			const result = db
				.prepare(
					`UPDATE dreaming_passes
					 SET status = 'failed', completed_at = datetime('now'),
					     error = 'Orphaned by daemon restart (startup recovery)'
					 WHERE status = 'running'`,
				)
				.run();
			return result.changes;
		});
	} catch (err) {
		logger.warn("startup-recovery", "Orphaned pass sweep failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const durationMs = Date.now() - startedAt;
	const report: StartupRecoveryReport = {
		walCheckpointed,
		deadJobsPurged,
		stagingRowsCleaned,
		orphanedPassesSwept,
		durationMs,
	};

	const totalCleaned = deadJobsPurged + stagingRowsCleaned + orphanedPassesSwept;
	if (totalCleaned > 0 || !walCheckpointed) {
		logger.info("startup-recovery", "Recovery complete", { ...report });
	} else {
		logger.debug("startup-recovery", "Recovery complete (workspace was clean)", { durationMs });
	}

	return report;
}

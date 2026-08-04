/**
 * Startup recovery: automatically clean accumulated crash-loop damage.
 *
 * Under the #1059 death spiral, a daemon that keeps getting SIGKILLed
 * accumulates state that makes the next restart worse: dead jobs pile up,
 * the embeddings_staging buffer grows without draining, and the WAL swells
 * without checkpointing. This module runs on every startup (after migrations,
 * before workers start) and cleans that damage automatically — bounded,
 * pressure-aware, no manual intervention required.
 *
 * Each cleanup runs in bounded batches via {@link drainWriteBatches}, yielding
 * to the event loop between batches and pausing if the system is under
 * pressure. This module is itself immune to the death spiral it cleans up.
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { type DrainResult, drainWriteBatches } from "./yielding-writes";

export interface StartupRecoveryReport {
	readonly walCheckpointed: boolean;
	readonly deadJobsPurged: number;
	readonly stagingRowsCleaned: number;
	readonly orphanedPassesSwept: number;
	readonly durationMs: number;
}

const DEAD_JOB_RETENTION_DAYS = 7;
const STAGING_BATCH_SIZE = 500;
const STAGING_MAX_TOTAL = 200_000;
const JOB_BATCH_SIZE = 500;
const JOB_MAX_TOTAL = 50_000;

/**
 * Run startup recovery. Called once after migrations complete and before
 * background workers start. Safe to call on every boot — it is idempotent
 * (a clean workspace cleans nothing; a crash-damaged workspace heals).
 */
export async function runStartupRecovery(accessor: DbAccessor): Promise<StartupRecoveryReport> {
	const startedAt = Date.now();
	logger.info("startup-recovery", "Running startup recovery");

	let walCheckpointed = false;

	// 1. WAL checkpoint — flush accumulated WAL pages into the main DB file.
	// Under a crash loop, the WAL grows without checkpointing (153M observed
	// in production). A large WAL slows every read and increases memory use.
	// Must run on the write connection outside a transaction (readonly
	// connections get SQLITE_IOERR_WRITE, and BEGIN IMMEDIATE conflicts).
	try {
		accessor.checkpointWal();
		walCheckpointed = true;
	} catch (err) {
		logger.warn("startup-recovery", "WAL checkpoint failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 2. Purge old dead jobs — crash loops leave thousands of dead extract/
	// document/summary jobs that serve no purpose and inflate diagnostics.
	const cutoff = new Date(Date.now() - DEAD_JOB_RETENTION_DAYS * 86_400_000).toISOString();
	let deadJobResult: DrainResult = { processed: 0, batches: 0, paused: 0, stopped: "exhausted" };
	try {
		deadJobResult = await drainWriteBatches(
			accessor,
			(db: ReadDb, limit: number) =>
				db
					.prepare(
						`SELECT id FROM memory_jobs
						 WHERE status = 'dead' AND created_at < ?
						 ORDER BY created_at
						 LIMIT ?`,
					)
					.all(cutoff, limit) as Array<{ id: string }>,
			(db: WriteDb, batch: readonly { id: string }[]) => {
				if (batch.length === 0) return;
				const placeholders = batch.map(() => "?").join(",");
				db.prepare(`DELETE FROM memory_jobs WHERE id IN (${placeholders})`).run(...batch.map((b) => b.id));
			},
			{ label: "dead-job-purge", maxPerTx: JOB_BATCH_SIZE, maxTotal: JOB_MAX_TOTAL, skipPressure: true },
		);
	} catch (err) {
		logger.warn("startup-recovery", "Dead job purge failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 3. Clean stale embeddings_staging rows — but ONLY when no embedding
	// index migration is in progress. embeddings_staging is written by the
	// embedding index migration to hold new-model vectors; during a 'building'
	// state, those rows are migration progress, not redundant data. Deleting
	// them would discard all migration work and force a full re-encode.
	let stagingResult: DrainResult = { processed: 0, batches: 0, paused: 0, stopped: "exhausted" };
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
			stagingResult = await drainWriteBatches(
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
				{ label: "staging-cleanup", maxPerTx: STAGING_BATCH_SIZE, maxTotal: STAGING_MAX_TOTAL, skipPressure: true },
			);
		}
	} catch (err) {
		logger.warn("startup-recovery", "Staging cleanup failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// 4. Sweep orphaned dreaming passes (status = 'running' from a crash).
	// The dreaming worker already does this, but running it here too ensures
	// the passes table is clean before the worker starts.
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
		deadJobsPurged: deadJobResult.processed,
		stagingRowsCleaned: stagingResult.processed,
		orphanedPassesSwept,
		durationMs,
	};

	const totalCleaned = report.deadJobsPurged + report.stagingRowsCleaned + report.orphanedPassesSwept;
	if (totalCleaned > 0 || !walCheckpointed) {
		logger.info("startup-recovery", "Recovery complete", { ...report });
	} else {
		logger.debug("startup-recovery", "Recovery complete (workspace was clean)", { durationMs });
	}

	return report;
}

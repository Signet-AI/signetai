/**
 * Startup recovery: automatically clean accumulated crash-loop damage.
 *
 * Recovery is scheduled without blocking daemon readiness. Each database batch
 * is admitted through the async accessor and yields between batches, so a large
 * backlog remains resumable while HTTP and worker traffic continue to run.
 */

import type { DatabaseIntegrityStatus } from "./database-integrity";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { recoverStaleLeases } from "./pipeline/stale-leases";

export interface StartupRecoveryReport {
	readonly recoveryPhase: "draining" | "complete";
	readonly walCheckpointed: boolean;
	readonly databaseIntegrity: DatabaseIntegrityStatus;
	readonly documentLeasesRecovered: number;
	readonly deadJobsPurged: number;
	readonly stagingRowsCleaned: number;
	readonly orphanedPassesSwept: number;
	readonly acpDeliveriesReconciled: number;
	readonly durationMs: number;
}

const DEAD_JOB_RETENTION_DAYS = 7;
const BATCH_SIZE = 500;
const JOB_MAX_TOTAL = 50_000;
const STAGING_MAX_TOTAL = 200_000;
const ACP_PENDING_GRACE_MS = 30_000;

const PENDING_INTEGRITY: DatabaseIntegrityStatus = {
	checkedAt: "",
	state: "unknown",
	phase: "pending",
	quickCheck: { ok: false, messages: ["not checked"] },
	telemetryCheck: { ok: false, messages: ["not checked"] },
	rebuiltIndexes: [],
	durationMs: 0,
	repairGuidance: null,
};

let activeRecovery: Promise<StartupRecoveryReport> | null = null;
let lastCompletedRecovery: StartupRecoveryReport | null = null;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function writeBatch<Result>(accessor: DbAccessor, processBatch: (db: WriteDb) => Result): Promise<Result> {
	if (accessor.withWriteTxAsync) return accessor.withWriteTxAsync(processBatch);
	return accessor.withWriteTx(processBatch);
}

/**
 * Drain a bounded number of rows through async accessor jobs.
 *
 * The SQLite statements themselves remain short synchronous calls inside the
 * accessor. The async queue and macrotask yield are the important boundary:
 * no startup caller waits for the complete backlog, and no batch can starve
 * the event loop indefinitely.
 */
async function drainBatchesAsync<Item>(
	accessor: DbAccessor,
	fetchBatch: (db: ReadDb, limit: number) => readonly Item[] | null,
	processBatch: (db: WriteDb, items: readonly Item[]) => void,
	maxTotal: number,
	label: string,
): Promise<number> {
	let processed = 0;
	let batches = 0;
	while (processed < maxTotal) {
		const limit = Math.min(BATCH_SIZE, maxTotal - processed);
		const batch = await accessor.withReadDbAsync(async (db) => fetchBatch(db, limit));
		if (!batch || batch.length === 0) return processed;
		await writeBatch(accessor, (db) => processBatch(db, batch));
		processed += batch.length;
		batches++;
		await yieldToEventLoop();
	}
	logger.warn("startup-recovery", `${label} reached its bounded startup cap`, {
		processed,
		maxTotal,
		batches,
	});
	return processed;
}

// cross-agent currently exposes only a synchronous helper. Keep this recovery
// write on the async queue instead of reintroducing a synchronous bootstrap call.
async function reconcileAcpDeliveriesAsync(accessor: DbAccessor, nowMs = Date.now()): Promise<number> {
	const now = new Date(nowMs).toISOString();
	const pendingCutoff = new Date(nowMs - ACP_PENDING_GRACE_MS).toISOString();
	return writeBatch(
		accessor,
		(db) =>
			db
				.prepare(
					`UPDATE cross_agent_messages
				 SET delivery_state = 'indeterminate', delivery_status = 'queued',
				     delivery_error = CASE
				       WHEN delivery_state = 'in_flight' THEN 'ACP relay interrupted; remote outcome is unknown'
				       ELSE 'ACP relay was queued but never started'
				     END,
				     delivery_lease_token = NULL, delivery_lease_expires_at = NULL,
				     delivery_updated_at = ?
				 WHERE delivery_path = 'acp'
				   AND ((delivery_state = 'in_flight' AND delivery_lease_expires_at <= ?)
				     OR (delivery_state = 'pending' AND delivery_updated_at <= ?))`,
				)
				.run(now, now, pendingCutoff).changes,
	);
}

function pendingReport(): StartupRecoveryReport {
	return {
		recoveryPhase: "draining",
		walCheckpointed: false,
		databaseIntegrity: PENDING_INTEGRITY,
		documentLeasesRecovered: 0,
		deadJobsPurged: 0,
		stagingRowsCleaned: 0,
		orphanedPassesSwept: 0,
		acpDeliveriesReconciled: 0,
		durationMs: 0,
	};
}

/**
 * Run the complete recovery job and resolve when the bounded pass finishes.
 * Tests and explicit lifecycle callers can await this function. The daemon
 * uses runStartupRecovery() below so readiness never waits for the pass.
 */
export function runStartupRecoveryAsync(accessor: DbAccessor): Promise<StartupRecoveryReport> {
	if (activeRecovery !== null) return activeRecovery;
	const run = runStartupRecoveryInternal(accessor);
	const trackedRun = run.then((report) => {
		lastCompletedRecovery = report;
		return report;
	});
	activeRecovery = trackedRun;
	const clear = (): void => {
		if (activeRecovery === trackedRun) activeRecovery = null;
	};
	trackedRun.then(clear, clear);
	return trackedRun;
}

/** Return the current startup drain without starting a second recovery pass. */
export function getStartupRecoveryCompletion(): Promise<StartupRecoveryReport> {
	if (activeRecovery !== null) return activeRecovery;
	return Promise.resolve(lastCompletedRecovery ?? pendingReport());
}

async function runStartupRecoveryInternal(accessor: DbAccessor): Promise<StartupRecoveryReport> {
	const startedAt = Date.now();
	logger.info("startup-recovery", "Running startup recovery asynchronously");

	let documentLeasesRecovered = 0;
	try {
		const now = new Date().toISOString();
		documentLeasesRecovered = await writeBatch(accessor, (db) => {
			// The daemon lock is held before recovery starts, so these leases belong
			// to a process that is no longer alive.
			const recovered = recoverStaleLeases(db, { now, jobType: "document_ingest" });
			if (recovered.dead > 0) {
				db.prepare(
					`UPDATE documents
					 SET status = 'failed',
					     error = COALESCE(error, ?),
					     updated_at = ?
					 WHERE id IN (
					     SELECT DISTINCT document_id FROM memory_jobs
					      WHERE job_type = 'document_ingest'
					        AND status = 'dead'
					        AND failed_at = ?
					        AND document_id IS NOT NULL
					 )
					   AND status != 'deleted'`,
				).run("Document ingest lease expired before completion", now, now);
			}
			return recovered.total;
		});
		if (documentLeasesRecovered > 0) {
			logger.info("startup-recovery", "Recovered document ingest leases", {
				count: documentLeasesRecovered,
			});
		}
	} catch (err) {
		logger.warn("startup-recovery", "Document lease recovery failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const cutoff = new Date(Date.now() - DEAD_JOB_RETENTION_DAYS * 86_400_000).toISOString();
	let deadJobsPurged = 0;
	try {
		deadJobsPurged = await drainBatchesAsync(
			accessor,
			(db, limit) =>
				db
					.prepare(
						`SELECT id FROM memory_jobs
						 WHERE status = 'dead' AND created_at < ?
						 LIMIT ?`,
					)
					.all(cutoff, limit) as Array<{ id: string }>,
			(db, batch) => {
				if (batch.length === 0) return;
				const placeholders = batch.map(() => "?").join(",");
				db.prepare(`DELETE FROM memory_jobs WHERE id IN (${placeholders})`).run(...batch.map((item) => item.id));
			},
			JOB_MAX_TOTAL,
			"Dead job purge",
		);
	} catch (err) {
		logger.warn("startup-recovery", "Dead job purge failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	let stagingRowsCleaned = 0;
	try {
		const migrationInProgress = await accessor.withReadDbAsync(async (db) => {
			const tableExists = db
				.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_state'")
				.get() as { n: number } | undefined;
			if (!tableExists?.n) return false;
			const state = db.prepare("SELECT state FROM embedding_index_state WHERE id = 1").get() as
				| { state: string }
				| undefined;
			return state?.state === "building";
		});

		if (migrationInProgress) {
			logger.info("startup-recovery", "Skipping staging cleanup, embedding index migration is in progress");
		} else {
			stagingRowsCleaned = await drainBatchesAsync<{ id: string }>(
				accessor,
				(db, limit) => {
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
				(db, batch) => {
					if (batch.length === 0) return;
					const placeholders = batch.map(() => "?").join(",");
					db.prepare(`DELETE FROM embeddings_staging WHERE id IN (${placeholders})`).run(
						...batch.map((item) => item.id),
					);
				},
				STAGING_MAX_TOTAL,
				"Staging cleanup",
			);
		}
	} catch (err) {
		logger.warn("startup-recovery", "Staging cleanup failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	let orphanedPassesSwept = 0;
	try {
		orphanedPassesSwept = await writeBatch(accessor, (db) => {
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

	let acpDeliveriesReconciled = 0;
	try {
		acpDeliveriesReconciled = await reconcileAcpDeliveriesAsync(accessor);
	} catch (err) {
		logger.warn("startup-recovery", "ACP delivery reconciliation failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const durationMs = Date.now() - startedAt;
	const report: StartupRecoveryReport = {
		recoveryPhase: "complete",
		walCheckpointed: false,
		databaseIntegrity: PENDING_INTEGRITY,
		documentLeasesRecovered,
		deadJobsPurged,
		stagingRowsCleaned,
		orphanedPassesSwept,
		acpDeliveriesReconciled,
		durationMs,
	};

	const totalCleaned =
		documentLeasesRecovered + deadJobsPurged + stagingRowsCleaned + orphanedPassesSwept + acpDeliveriesReconciled;
	if (totalCleaned > 0) {
		logger.info("startup-recovery", "Asynchronous recovery complete", { ...report });
	} else {
		logger.debug("startup-recovery", "Asynchronous recovery complete (workspace was clean)", { durationMs });
	}
	return report;
}

/**
 * Schedule recovery and return immediately. This compatibility entrypoint is
 * called during daemon boot, before the HTTP server binds, so it must never
 * perform a database operation or await the backlog.
 */
export function runStartupRecovery(accessor: DbAccessor): StartupRecoveryReport {
	const report = pendingReport();
	logger.info("startup-recovery", "Deferring startup recovery until the event loop can serve requests");
	void runStartupRecoveryAsync(accessor)
		.then((completed) => Object.assign(report, completed))
		.catch((err) => {
			logger.warn("startup-recovery", "Asynchronous startup recovery failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	return report;
}

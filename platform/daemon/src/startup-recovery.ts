/**
 * Startup recovery: automatically clean accumulated crash-loop damage.
 *
 * Recovery is scheduled without blocking daemon readiness. Each database batch
 * is admitted through the async accessor and yields between batches, so a large
 * backlog remains resumable while HTTP and worker traffic continue to run.
 */

import type { DatabaseIntegrityStatus } from "./database-integrity";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import type { DbOwnerClient } from "./db-owner-client";
import {
	ownerChanges,
	ownerQueryAll,
	ownerQueryOne,
	ownerRunStatement,
	ownerTransaction,
} from "./db-owner-maintenance";
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

export interface StartupRecoveryOptions {
	readonly owner?: DbOwnerClient;
}

export interface StartupRecoveryProgress {
	readonly phase: "pending" | "draining" | "complete" | "failed";
	readonly operation: string;
	readonly processed: number;
	readonly batches: number;
	readonly deadlineKills: number;
	readonly ownerState: string | null;
	readonly ownerGeneration: number | null;
	readonly updatedAt: string;
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
	ownerState: null,
	ownerGeneration: null,
	deadlineKills: 0,
};

let activeRecovery: Promise<StartupRecoveryReport> | null = null;
let lastCompletedRecovery: StartupRecoveryReport | null = null;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function writeBatch<Result>(accessor: DbAccessor, processBatch: (db: WriteDb) => Result): Promise<Result> {
	return accessor.withWriteTxAsync(processBatch);
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

async function runOwnerStartupRecovery(owner: DbOwnerClient): Promise<StartupRecoveryReport> {
	const startedAt = Date.now();
	const recoveryStartedAt = new Date(Math.floor(startedAt / 1_000) * 1_000).toISOString();
	logger.info("startup-recovery", "Running startup recovery through the DB owner");
	const logProgress = (operation: string, processed: number): void => {
		const health = owner.health();
		logger.info("startup-recovery", "Owner startup recovery progress", {
			operation,
			processed,
			ownerState: health.state,
			ownerGeneration: health.generation,
			deadlineKills: health.deadlineKills,
		});
	};

	let documentLeasesRecovered = 0;
	try {
		const now = new Date().toISOString();
		const results = await ownerTransaction(
			owner,
			"startup-recovery.document-leases",
			[
				ownerRunStatement(
					`UPDATE memory_jobs
					 SET status = 'dead', leased_at = NULL, failed_at = ?,
					     error = COALESCE(error, ?), updated_at = ?
					 WHERE status = 'leased' AND job_type = 'document_ingest'
					   AND attempts >= max_attempts`,
					[now, "lease expired before completion", now],
				),
				ownerRunStatement(
					`UPDATE memory_jobs
					 SET status = 'pending', leased_at = NULL, updated_at = ?
					 WHERE status = 'leased' AND job_type = 'document_ingest'
					   AND attempts < max_attempts`,
					[now],
				),
				ownerRunStatement(
					`UPDATE documents
					 SET status = 'failed',
					     error = COALESCE(error, ?), updated_at = ?
					 WHERE id IN (
					     SELECT DISTINCT document_id FROM memory_jobs
					      WHERE job_type = 'document_ingest' AND status = 'dead'
					        AND failed_at = ? AND document_id IS NOT NULL
					 ) AND status != 'deleted'`,
					["Document ingest lease expired before completion", now, now],
				),
			],
			{ estimatedWorkUnits: 3 },
		);
		documentLeasesRecovered = ownerChanges(results[0]) + ownerChanges(results[1]);
		if (documentLeasesRecovered > 0) {
			logger.info("startup-recovery", "Recovered document ingest leases through the DB owner", {
				count: documentLeasesRecovered,
			});
		}
		logProgress("document-leases", documentLeasesRecovered);
	} catch (error) {
		logger.warn("startup-recovery", "Owner document lease recovery failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		logProgress("document-leases", documentLeasesRecovered);
	}

	const cutoff = new Date(startedAt - DEAD_JOB_RETENTION_DAYS * 86_400_000).toISOString();
	let deadJobsPurged = 0;
	try {
		while (deadJobsPurged < JOB_MAX_TOTAL) {
			const batch = await ownerQueryAll<{ id: string }>(
				owner,
				"startup-recovery.dead-jobs.select",
				`SELECT id FROM memory_jobs WHERE status = 'dead' AND created_at < ? LIMIT ?`,
				[cutoff, Math.min(BATCH_SIZE, JOB_MAX_TOTAL - deadJobsPurged)],
				{ estimatedWorkUnits: BATCH_SIZE },
			);
			if (batch.length === 0) break;
			const placeholders = batch.map(() => "?").join(",");
			const results = await ownerTransaction(owner, "startup-recovery.dead-jobs.delete", [
				ownerRunStatement(
					`DELETE FROM memory_jobs WHERE id IN (${placeholders})`,
					batch.map((item) => item.id),
				),
			]);
			const removed = ownerChanges(results[0]);
			deadJobsPurged += removed;
			await yieldToEventLoop();
			if (removed === 0) break;
			if (batch.length < BATCH_SIZE) break;
		}
		logProgress("dead-jobs", deadJobsPurged);
	} catch (error) {
		logger.warn("startup-recovery", "Owner dead job purge failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		logProgress("dead-jobs", deadJobsPurged);
	}

	let stagingRowsCleaned = 0;
	try {
		const migrationTable = await ownerQueryOne<{ present: number }>(
			owner,
			"startup-recovery.embedding-migration-state",
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'embedding_index_state'",
		);
		const migration =
			migrationTable === undefined
				? undefined
				: await ownerQueryOne<{ state: string }>(
						owner,
						"startup-recovery.embedding-migration-state",
						"SELECT state FROM embedding_index_state WHERE id = 1",
					);
		const stagingTable = await ownerQueryOne<{ present: number }>(
			owner,
			"startup-recovery.staging-table",
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'embeddings_staging'",
		);
		if (stagingTable === undefined) {
			logger.debug("startup-recovery", "Skipping staging cleanup, staging table is not present");
		} else if (migration?.state === "building") {
			logger.info("startup-recovery", "Skipping staging cleanup, embedding index migration is in progress");
		} else {
			while (stagingRowsCleaned < STAGING_MAX_TOTAL) {
				const batch = await ownerQueryAll<{ id: string }>(
					owner,
					"startup-recovery.staging.select",
					`SELECT s.id FROM embeddings_staging s
					 WHERE EXISTS (SELECT 1 FROM embeddings e WHERE e.content_hash = s.content_hash)
					 LIMIT ?`,
					[Math.min(BATCH_SIZE, STAGING_MAX_TOTAL - stagingRowsCleaned)],
					{ estimatedWorkUnits: BATCH_SIZE },
				);
				if (batch.length === 0) break;
				const placeholders = batch.map(() => "?").join(",");
				const results = await ownerTransaction(owner, "startup-recovery.staging.delete", [
					ownerRunStatement(
						`DELETE FROM embeddings_staging WHERE id IN (${placeholders})`,
						batch.map((item) => item.id),
					),
				]);
				const removed = ownerChanges(results[0]);
				stagingRowsCleaned += removed;
				await yieldToEventLoop();
				if (removed === 0) break;
				if (batch.length < BATCH_SIZE) break;
			}
		}
		logProgress("staging", stagingRowsCleaned);
	} catch (error) {
		logger.warn("startup-recovery", "Owner staging cleanup failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		logProgress("staging", stagingRowsCleaned);
	}

	let orphanedPassesSwept = 0;
	try {
		const table = await ownerQueryOne<{ present: number }>(
			owner,
			"startup-recovery.dreaming-table",
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_passes'",
		);
		if (table !== undefined) {
			const results = await ownerTransaction(owner, "startup-recovery.orphaned-passes", [
				ownerRunStatement(
					`UPDATE dreaming_passes
						 SET status = 'failed', completed_at = datetime('now'),
						     error = 'Orphaned by daemon restart (startup recovery)'
						 WHERE status = 'running' AND started_at IS NOT NULL
						   AND julianday(started_at) < julianday(?)`,
					[recoveryStartedAt],
				),
			]);
			orphanedPassesSwept = ownerChanges(results[0]);
		}
		logProgress("orphaned-passes", orphanedPassesSwept);
	} catch (error) {
		logger.warn("startup-recovery", "Owner orphaned pass sweep failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		logProgress("orphaned-passes", orphanedPassesSwept);
	}

	let acpDeliveriesReconciled = 0;
	try {
		const now = new Date().toISOString();
		const pendingCutoff = new Date(Date.now() - ACP_PENDING_GRACE_MS).toISOString();
		const results = await ownerTransaction(owner, "startup-recovery.acp-deliveries", [
			ownerRunStatement(
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
				[now, now, pendingCutoff],
			),
		]);
		acpDeliveriesReconciled = ownerChanges(results[0]);
		logProgress("acp-deliveries", acpDeliveriesReconciled);
	} catch (error) {
		logger.warn("startup-recovery", "Owner ACP delivery reconciliation failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		logProgress("acp-deliveries", acpDeliveriesReconciled);
	}

	return {
		recoveryPhase: "complete",
		walCheckpointed: false,
		databaseIntegrity: PENDING_INTEGRITY,
		documentLeasesRecovered,
		deadJobsPurged,
		stagingRowsCleaned,
		orphanedPassesSwept,
		acpDeliveriesReconciled,
		durationMs: Date.now() - startedAt,
	};
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
export function runStartupRecoveryAsync(
	accessor: DbAccessor,
	options: StartupRecoveryOptions = {},
): Promise<StartupRecoveryReport> {
	if (activeRecovery !== null) return activeRecovery;
	const run = runStartupRecoveryInternal(accessor, options.owner);
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

async function runStartupRecoveryInternal(accessor: DbAccessor, owner?: DbOwnerClient): Promise<StartupRecoveryReport> {
	if (owner !== undefined) return await runOwnerStartupRecovery(owner);
	const startedAt = Date.now();
	// Pass timestamps are persisted with millisecond precision, but older rows
	// and direct writers may still use SQLite's second precision. Round the
	// cutoff down so a pass from the current second is never swept as orphaned.
	const recoveryStartedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString();
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
					 WHERE status = 'running'
					   AND started_at IS NOT NULL
					   AND julianday(started_at) < julianday(?)`,
				)
				// The status and cutoff predicates are evaluated in this write
				// transaction. A pass created after recovery began, or completed
				// before this update, cannot be turned into an orphan.
				.run(recoveryStartedAt);
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
export function runStartupRecovery(accessor: DbAccessor, options: StartupRecoveryOptions = {}): StartupRecoveryReport {
	const report = pendingReport();
	logger.info("startup-recovery", "Deferring startup recovery until the event loop can serve requests");
	void runStartupRecoveryAsync(accessor, options)
		.then((completed) => Object.assign(report, completed))
		.catch((err) => {
			logger.warn("startup-recovery", "Asynchronous startup recovery failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	return report;
}

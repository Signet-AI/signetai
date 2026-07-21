import type { DbAccessor, WriteDb } from "../db-accessor";
import { INGEST_JOB_TYPE } from "./ingest/lease";

export const FORGOTTEN_MEMORY_JOB_ERROR = "Source memory forgotten";
export const FORGOTTEN_MEMORY_JOB_RESULT = JSON.stringify({ cancelled: "memory_forgotten" });

/**
 * Active (non-terminal) statuses a forgotten source's job may be in when it is
 * cancelled. Union of the legacy extract lifecycle (pending/leased) and the
 * unified ingest lifecycle (pending/leased/planning/applying — see
 * ingest/lease.ts `IngestJobStatus`). A forgotten source must produce zero
 * derived descendants (#895), so a queued OR in-flight job is dead-lettered
 * regardless of phase. SQLite can't bind an IN-list, so this is a static
 * fragment interpolated into the statement (never user input).
 */
const FORGOTTEN_MEMORY_CANCELLABLE_STATUSES = "('pending', 'leased', 'planning', 'applying')";

/** Job types whose jobs are cancelled when their source memory is forgotten. */
const FORGOTTEN_MEMORY_CANCELLABLE_JOB_TYPES = `('extract', '${INGEST_JOB_TYPE}')`;

/**
 * Dead-letter every queued or in-flight job for a forgotten source memory so it
 * produces zero derived descendants (#895 / #910). Covers both the legacy
 * `extract` lane and the unified `ingest` lane (#913) across every active
 * status — pending, leased, planning, and applying. The mid-lease cases
 * (leased/planning/applying) matter for the ingest path: a forgotten source
 * whose job is already leased must not reach apply, and a stale lease token
 * cannot resurrect a dead job (`verifyIngestLease` filters on active statuses).
 */
export function cancelJobsForForgottenMemory(db: WriteDb, memoryId: string, changedAt: string): number {
	const result = db
		.prepare(
			`UPDATE memory_jobs
			 SET status = 'dead', result = ?, error = ?, failed_at = ?, updated_at = ?
			 WHERE memory_id = ?
			   AND job_type IN ${FORGOTTEN_MEMORY_CANCELLABLE_JOB_TYPES}
			   AND status IN ${FORGOTTEN_MEMORY_CANCELLABLE_STATUSES}`,
		)
		.run(FORGOTTEN_MEMORY_JOB_RESULT, FORGOTTEN_MEMORY_JOB_ERROR, changedAt, changedAt, memoryId);
	return result.changes;
}

/**
 * Dead-letter a single job for a forgotten source — the worker's mid-lease
 * re-check path. Generalized from extraction-only: the apply re-check fires
 * after lease, so the job may be in any active phase (leased/planning/applying
 * on the unified ingest path), not just pending/leased. Does not increment
 * `attempts`; the job is terminal, so no retry is owed.
 */
export function cancelJobForForgottenMemory(db: WriteDb, jobId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'dead', result = ?, error = ?, failed_at = ?, updated_at = ?
		 WHERE id = ?
		   AND status IN ${FORGOTTEN_MEMORY_CANCELLABLE_STATUSES}`,
	).run(FORGOTTEN_MEMORY_JOB_RESULT, FORGOTTEN_MEMORY_JOB_ERROR, now, now, jobId);
}

// ---------------------------------------------------------------------------
// Job enqueue (called by daemon remember endpoint and other write surfaces)
// ---------------------------------------------------------------------------

export function enqueueExtractionJobInTx(db: WriteDb, memoryId: string): void {
	// Skip if memory extraction is already complete (structured passthrough
	// or prior pipeline run). This prevents re-processing memories that
	// were ingested with pre-extracted data.
	const mem = db.prepare("SELECT extraction_status, is_deleted FROM memories WHERE id = ? LIMIT 1").get(memoryId) as
		| { extraction_status: string | null; is_deleted: number }
		| undefined;
	if (!mem || mem.is_deleted === 1) return;
	if (mem?.extraction_status === "complete" || mem?.extraction_status === "completed") return;

	// Dedup: skip if a pending/leased job already exists
	const existing = db
		.prepare(
			`SELECT 1 FROM memory_jobs
				 WHERE memory_id = ? AND job_type = 'extract'
				   AND status IN ('pending', 'leased')
				 LIMIT 1`,
		)
		.get(memoryId);
	if (existing) return;

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts,
			  created_at, updated_at)
			 VALUES (?, ?, 'extract', 'pending', 0, ?, ?, ?)`,
	).run(id, memoryId, 3, now, now);
}

export function enqueueExtractionJob(accessor: DbAccessor, memoryId: string): void {
	accessor.withWriteTx((db) => {
		enqueueExtractionJobInTx(db, memoryId);
	});
}

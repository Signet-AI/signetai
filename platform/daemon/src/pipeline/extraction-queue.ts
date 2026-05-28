import type { DbAccessor, WriteDb } from "../db-accessor";

// ---------------------------------------------------------------------------
// Job enqueue (called by daemon remember endpoint and other write surfaces)
// ---------------------------------------------------------------------------

export function enqueueExtractionJobInTx(db: WriteDb, memoryId: string): void {
	// Skip if memory extraction is already complete (structured passthrough
	// or prior pipeline run). This prevents re-processing memories that
	// were ingested with pre-extracted data.
	const mem = db.prepare("SELECT extraction_status FROM memories WHERE id = ? LIMIT 1").get(memoryId) as
		| { extraction_status: string | null }
		| undefined;
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

import type { DbAccessor, WriteDb } from "../db-accessor";

export interface ExtractionUnavailableOptions {
	readonly reason: string;
	readonly extractionModel?: string;
}

function updateExtractionFailure(db: WriteDb, memoryId: string, extractionModel: string | undefined): void {
	if (extractionModel === undefined) {
		db.prepare("UPDATE memories SET extraction_status = 'failed' WHERE id = ?").run(memoryId);
		return;
	}
	db.prepare("UPDATE memories SET extraction_status = 'failed', extraction_model = ? WHERE id = ?").run(
		extractionModel,
		memoryId,
	);
}

export function deadLetterExtractionJob(
	accessor: DbAccessor,
	memoryId: string,
	options: ExtractionUnavailableOptions,
): void {
	const now = new Date().toISOString();
	accessor.withWriteTx((db) => {
		const memory = db
			.prepare("SELECT extraction_status FROM memories WHERE id = ? LIMIT 1")
			.get(memoryId) as { extraction_status: string | null } | undefined;
		if (!memory) return;
		if (
			memory.extraction_status === "complete" ||
			memory.extraction_status === "completed" ||
			memory.extraction_status === "done"
		) return;

		const liveJobs = db
			.prepare(
				`SELECT id FROM memory_jobs
				 WHERE memory_id = ? AND job_type = 'extract'
				   AND status = 'pending'
				 ORDER BY created_at ASC`,
			)
			.all(memoryId) as Array<{ id: string }>;

		if (liveJobs.length > 0) {
			db.prepare(
				`UPDATE memory_jobs
				 SET status = 'dead', error = ?, failed_at = ?, updated_at = ?
				 WHERE memory_id = ? AND job_type = 'extract'
				   AND status = 'pending'`,
			).run(options.reason, now, now, memoryId);
		} else {
			db.prepare(
				`INSERT INTO memory_jobs
				 (id, memory_id, job_type, status, error, attempts, max_attempts, failed_at, created_at, updated_at)
				 VALUES (?, ?, 'extract', 'dead', ?, 0, 3, ?, ?, ?)`,
			).run(crypto.randomUUID(), memoryId, options.reason, now, now, now);
		}

		// Only mark the memory as failed if it has no remaining leased
		// (in-flight) extract jobs — consistent with deadLetterPendingExtractionJobs.
		const leasedCount = db
			.prepare(
				`SELECT COUNT(*) as cnt FROM memory_jobs
				 WHERE memory_id = ? AND job_type = 'extract' AND status = 'leased'`,
			)
			.get(memoryId) as { cnt: number };
		if (leasedCount.cnt === 0) {
			updateExtractionFailure(db, memoryId, options.extractionModel);
		}
	});
}

export function deadLetterPendingExtractionJobs(
	accessor: DbAccessor,
	options: ExtractionUnavailableOptions,
): number {
	const now = new Date().toISOString();
	return accessor.withWriteTx((db) => {
		const memoryIds = db
			.prepare(
				`SELECT DISTINCT memory_id
				 FROM memory_jobs
				 WHERE job_type = 'extract'
				   AND status = 'pending'`,
			)
			.all() as Array<{ memory_id: string }>;

		const result = db.prepare(
			`UPDATE memory_jobs
			 SET status = 'dead', error = ?, failed_at = ?, updated_at = ?
			 WHERE job_type = 'extract'
			   AND status = 'pending'`,
		).run(options.reason, now, now);

		for (const { memory_id: memoryId } of memoryIds) {
			// Only mark the memory as failed if it has no remaining leased
			// (in-flight) extract jobs — a leased job may still complete
			// successfully and should not be pre-empted.
			const leasedCount = db
				.prepare(
					`SELECT COUNT(*) as cnt FROM memory_jobs
					 WHERE memory_id = ? AND job_type = 'extract' AND status = 'leased'`,
				)
				.get(memoryId) as { cnt: number };
			if (leasedCount.cnt === 0) {
				updateExtractionFailure(db, memoryId, options.extractionModel);
			}
		}

		return result.changes;
	});
}

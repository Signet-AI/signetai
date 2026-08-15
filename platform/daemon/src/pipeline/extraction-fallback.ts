import type { DbAccessor, WriteDb } from "../db-accessor";

export interface LegacyExtractionRetirementOptions {
	readonly reason: string;
}

/**
 * Promote every still-live legacy extraction input into the Dreaming cursor,
 * then retire its job. A cutover must never abandon pending work just because
 * the old worker disappeared: the source remains immutable episodic evidence
 * and Dreaming becomes its live consumer. Deleted or missing sources are
 * intentionally terminal because retention/forgetting already withdrew them.
 */
export function retireLegacyExtractionJobs(accessor: DbAccessor, options: LegacyExtractionRetirementOptions): number {
	const now = new Date().toISOString();
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		const sources = db
			.prepare(
				`SELECT DISTINCT m.id
				 FROM memory_jobs j
				 JOIN memories m ON m.id = j.memory_id
				 WHERE j.job_type = 'extract'
				   AND j.status IN ('pending', 'leased')`,
			)
			.all() as Array<{ id: string }>;

		const result = db
			.prepare(
				`UPDATE memory_jobs
			 SET status = 'dead', error = ?, failed_at = ?, updated_at = ?
			 WHERE job_type = 'extract'
			   AND status IN ('pending', 'leased')`,
			)
			.run(options.reason, now, now);

		// Migration 094 owns memory_kind: this retirement never promotes a row
		// into episodic evidence. Mark every retired job's source consistently,
		// whether it was raw evidence or daemon-derived output.
		for (const source of sources) {
			db.prepare("UPDATE memories SET extraction_status = 'retired' WHERE id = ?").run(source.id);
		}

		return result.changes;
	});
}

import type { MigrationDb } from "./index";

/**
 * Migration 089: Add `job_cancellations` audit table for issue #901.
 *
 * Operators cancel `memory_jobs` and `summary_jobs` rows via the
 * `cancelObsoleteJobs` repair action. We never hard-delete the source
 * row in cancel — we copy the full payload to `job_cancellations` and
 * flip the source row's `status` to `cancelled`. This preserves
 * provenance for support cases where operators need to explain a
 * cancellation after the fact.
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + index check via
 * `pragma_index_list`. Safe to re-run on a partial upgrade.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS job_cancellations (
			id TEXT PRIMARY KEY,
			source_table TEXT NOT NULL,
			source_id TEXT NOT NULL,
			status_before TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			reason TEXT,
			actor TEXT NOT NULL,
			actor_type TEXT NOT NULL,
			request_id TEXT,
			created_at TEXT NOT NULL
		)
	`);

	if (!indexExists(db, "job_cancellations", "idx_job_cancellations_source")) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_job_cancellations_source
			 ON job_cancellations(source_table, source_id)`,
		);
	}
	if (!indexExists(db, "job_cancellations", "idx_job_cancellations_created_at")) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_job_cancellations_created_at
			 ON job_cancellations(created_at)`,
		);
	}
}

function indexExists(db: MigrationDb, table: string, indexName: string): boolean {
	const rows = db.prepare(`PRAGMA index_list(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === indexName);
}

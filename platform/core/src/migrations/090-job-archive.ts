import type { MigrationDb } from "./index";

/**
 * Migration 090: Add `job_archive` provenance table for issue #901.
 *
 * `pruneTerminalJobs` removes rows that have already reached a
 * terminal state (cancelled / completed / dead) and lived beyond the
 * configured retention window. To preserve provenance — required by
 * the issue's "preserving provenance" constraint — we copy the full
 * source row to `job_archive` before deleting it. The archive table
 * holds the original payload plus bookkeeping columns (`archived_at`,
 * `archived_by`, `reason`, `source_table`).
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS`. Safe to re-run.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS job_archive (
			id TEXT PRIMARY KEY,
			source_table TEXT NOT NULL,
			source_id TEXT NOT NULL,
			status TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			archived_by TEXT NOT NULL,
			reason TEXT,
			created_at TEXT NOT NULL
		)
	`);

	if (!indexExists(db, "job_archive", "idx_job_archive_source")) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_job_archive_source
			 ON job_archive(source_table, source_id)`,
		);
	}
	if (!indexExists(db, "job_archive", "idx_job_archive_archived_at")) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS idx_job_archive_archived_at
			 ON job_archive(archived_at)`,
		);
	}
}

function indexExists(db: MigrationDb, table: string, indexName: string): boolean {
	const rows = db.prepare(`PRAGMA index_list(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === indexName);
}

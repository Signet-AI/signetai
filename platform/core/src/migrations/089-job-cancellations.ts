import type { MigrationDb } from "./contract";
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

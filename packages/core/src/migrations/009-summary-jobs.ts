import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS summary_jobs (
			id TEXT PRIMARY KEY,
			session_key TEXT,
			harness TEXT NOT NULL,
			project TEXT,
			transcript TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			result TEXT,
			attempts INTEGER DEFAULT 0,
			max_attempts INTEGER DEFAULT 3,
			created_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		)
	`);

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_summary_jobs_status
		 ON summary_jobs(status)`,
	);
}

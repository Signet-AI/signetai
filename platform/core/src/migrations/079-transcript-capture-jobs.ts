import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS transcript_capture_jobs (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL DEFAULT 'default',
			harness TEXT NOT NULL,
			session_key TEXT,
			session_id TEXT NOT NULL,
			project TEXT,
			transcript TEXT NOT NULL,
			raw_transcript TEXT,
			transcript_path TEXT,
			captured_at TEXT NOT NULL,
			ended_at TEXT,
			summary_status TEXT NOT NULL DEFAULT 'not_requested',
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 5,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			error TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_status
			ON transcript_capture_jobs(status, created_at);

		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_agent_session
			ON transcript_capture_jobs(agent_id, session_key, created_at);
	`);
}

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS transcript_recovery_files (
			agent_id TEXT NOT NULL,
			source_path TEXT NOT NULL,
			harness TEXT NOT NULL,
			size_bytes INTEGER NOT NULL,
			mtime_ms INTEGER NOT NULL,
			content_sha256 TEXT NOT NULL,
			session_id TEXT NOT NULL,
			last_scanned_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_path)
		);

		CREATE INDEX IF NOT EXISTS idx_transcript_capture_jobs_agent_session_id
			ON transcript_capture_jobs(agent_id, session_id, status);
	`);
}

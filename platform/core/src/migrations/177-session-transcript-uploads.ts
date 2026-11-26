import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_transcript_uploads (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			project TEXT,
			generation INTEGER NOT NULL CHECK (generation >= 0),
			committed_offset INTEGER NOT NULL CHECK (committed_offset >= 0),
			tail_sha256 TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_key)
		);
		CREATE TABLE IF NOT EXISTS session_transcript_upload_purges (
			path TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		)
	`);
}

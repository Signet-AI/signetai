import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_extract_cursors (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			last_offset INTEGER NOT NULL DEFAULT 0,
			last_extract_at TEXT NOT NULL,
			PRIMARY KEY (session_key, agent_id)
		);
	`);
}

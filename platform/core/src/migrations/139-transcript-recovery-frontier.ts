import type { MigrationDb } from "./index";

/** Durable traversal cursor for the killable transcript recovery worker. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS transcript_recovery_frontiers (
			agent_id TEXT NOT NULL,
			harness TEXT NOT NULL,
			root_path TEXT NOT NULL,
			cursor_path TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, harness, root_path)
		);
	`);
}

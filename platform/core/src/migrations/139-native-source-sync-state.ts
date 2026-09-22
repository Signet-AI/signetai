import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS native_source_sync_state (
			agent_id TEXT NOT NULL,
			source_key TEXT NOT NULL,
			source_root TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('running', 'paused')),
			checkpoint_path TEXT,
			pause_reason TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_key)
		);
		CREATE INDEX IF NOT EXISTS idx_native_source_sync_state_status
			ON native_source_sync_state(agent_id, status);
	`);
}

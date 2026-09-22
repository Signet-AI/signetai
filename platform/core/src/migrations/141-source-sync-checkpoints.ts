import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS source_sync_checkpoints (
			agent_id TEXT NOT NULL,
			source_key TEXT NOT NULL,
			phase TEXT NOT NULL,
			cursor TEXT,
			scanned INTEGER NOT NULL DEFAULT 0,
			complete INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_key, phase)
		);
	`);
}

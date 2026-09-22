import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS imported_source_lifecycle (
			id TEXT PRIMARY KEY,
			source_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('unsupported', 'reviewed')),
			reason TEXT NOT NULL,
			removed_at TEXT NOT NULL,
			reviewed_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(source_id, agent_id)
		);
		CREATE INDEX IF NOT EXISTS idx_imported_source_lifecycle_agent
			ON imported_source_lifecycle(agent_id, status, updated_at DESC);
	`);
}

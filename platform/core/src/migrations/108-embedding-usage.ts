import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_usage (
			day TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT '',
			source_kind TEXT NOT NULL,
			provider TEXT NOT NULL,
			requests INTEGER NOT NULL DEFAULT 0,
			tokens INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (day, agent_id, source_kind, provider)
		);
	`);
}

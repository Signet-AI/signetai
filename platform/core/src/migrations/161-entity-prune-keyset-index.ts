import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entities_agent_updated_id
		ON entities(agent_id, updated_at DESC, id DESC);
	`);
}

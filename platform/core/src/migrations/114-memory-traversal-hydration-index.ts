import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entity_attributes'")
		.get() as { name?: string } | null | undefined;
	if (table == null) return;

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entity_attributes_memory_agent_status
			ON entity_attributes(memory_id, agent_id, status, importance);
	`);
}

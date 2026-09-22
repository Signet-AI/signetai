import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity_memory
			ON memory_entity_mentions(entity_id, memory_id);
	`);
}

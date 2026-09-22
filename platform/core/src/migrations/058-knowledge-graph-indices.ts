import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entities_order
			ON entities(agent_id, pinned DESC, pinned_at DESC, mentions DESC, updated_at DESC, name)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entities_extracted_mentions
			ON entities(entity_type, mentions)
			WHERE entity_type = 'extracted'`,
	);
}

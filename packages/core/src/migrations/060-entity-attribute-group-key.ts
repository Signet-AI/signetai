import type { MigrationDb } from "./index";

/**
 * Migration 060: Add navigable group identity to structured attributes.
 *
 * Aspects are broad rooms. `group_key` adds a dresser-level navigation
 * layer between an aspect and a claim slot, so agents can browse large
 * entity graphs without loading every attribute under an aspect.
 */
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(entity_attributes)").all() as Array<{ name: string }>;
	if (!cols.some((col) => col.name === "group_key")) {
		db.exec("ALTER TABLE entity_attributes ADD COLUMN group_key TEXT");
	}

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_key
			ON entity_attributes(agent_id, aspect_id, group_key, status)
			WHERE group_key IS NOT NULL`,
	);

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entity_attributes_group_claim
			ON entity_attributes(agent_id, aspect_id, group_key, claim_key, status)
			WHERE claim_key IS NOT NULL`,
	);
}

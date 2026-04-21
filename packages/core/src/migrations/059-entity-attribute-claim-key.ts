import type { MigrationDb } from "./index";

/**
 * Migration 059: Add claim identity to structured attributes.
 *
 * `entity_aspects` group facts by broad facet. That is not enough to decide
 * supersession, because unrelated events under the same facet are siblings but
 * not replacements. `claim_key` identifies the specific claim slot an attribute
 * occupies within an aspect, such as `korean_restaurants_tried_count`.
 */
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(entity_attributes)").all() as Array<{ name: string }>;
	if (!cols.some((col) => col.name === "claim_key")) {
		db.exec("ALTER TABLE entity_attributes ADD COLUMN claim_key TEXT");
	}

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_entity_attributes_claim_key
			ON entity_attributes(agent_id, aspect_id, claim_key, status)
			WHERE claim_key IS NOT NULL`,
	);
}

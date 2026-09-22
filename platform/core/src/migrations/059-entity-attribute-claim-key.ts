import type { MigrationDb } from "./contract";
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

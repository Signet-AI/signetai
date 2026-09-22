import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const depCols = db.prepare("PRAGMA table_info(entity_dependencies)").all() as Array<{ name: string }>;
	if (!depCols.some((c) => c.name === "reason")) {
		db.exec("ALTER TABLE entity_dependencies ADD COLUMN reason TEXT");
	}

	const entCols = db.prepare("PRAGMA table_info(entities)").all() as Array<{ name: string }>;
	if (!entCols.some((c) => c.name === "last_synthesized_at")) {
		db.exec("ALTER TABLE entities ADD COLUMN last_synthesized_at TEXT");
	}
}

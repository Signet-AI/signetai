import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(entity_dependencies)").all() as Array<{ name: string }>;

	if (!cols.some((c) => c.name === "confidence")) {
		db.exec("ALTER TABLE entity_dependencies ADD COLUMN confidence REAL DEFAULT 0.7");
	}
}

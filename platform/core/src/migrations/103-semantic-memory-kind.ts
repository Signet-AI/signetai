import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memories', 'entity_attributes')")
		.all();
	if (tables.length !== 2) return;
	const memoryColumns = db
		.prepare("PRAGMA table_info(memories)")
		.all()
		.map((row) => row.name);
	const attributeColumns = db
		.prepare("PRAGMA table_info(entity_attributes)")
		.all()
		.map((row) => row.name);
	if (!memoryColumns.includes("memory_kind") || !attributeColumns.includes("memory_id")) return;
	db.exec(`
		UPDATE memories
		SET memory_kind = 'derived'
		WHERE memory_kind IS NULL
		  AND id IN (
			SELECT memory_id FROM entity_attributes WHERE memory_id IS NOT NULL
		  )
	`);
}

import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "session_memories", "entity_slot", "INTEGER");
	addColumnIfMissing(db, "session_memories", "aspect_slot", "INTEGER");
	addColumnIfMissing(db, "session_memories", "is_constraint", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "session_memories", "structural_density", "INTEGER");
}

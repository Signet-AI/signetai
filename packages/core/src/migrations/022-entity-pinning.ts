import type { MigrationDb } from "./index";

function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(
		db,
		"entities",
		"pinned",
		"INTEGER NOT NULL DEFAULT 0",
	);
	addColumnIfMissing(db, "entities", "pinned_at", "TEXT");

	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_entities_pinned ON entities(agent_id, pinned, pinned_at DESC)",
	);
}

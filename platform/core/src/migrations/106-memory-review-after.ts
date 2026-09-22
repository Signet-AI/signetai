import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}
export function up(db: MigrationDb): void {
	if (!hasColumn(db, "memories", "review_after")) {
		db.exec("ALTER TABLE memories ADD COLUMN review_after TEXT;");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_review_after ON memories(review_after);");
}

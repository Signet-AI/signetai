import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "scope")) {
		db.exec("ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT NULL");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL");
}

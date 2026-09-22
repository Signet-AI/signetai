import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all() as Array<{ name: string }>;
	const names = new Set(cols.map((col) => col.name));
	if (!names.has("is_deleted")) {
		db.exec("ALTER TABLE memory_artifacts ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
	}
	if (!names.has("deleted_at")) {
		db.exec("ALTER TABLE memory_artifacts ADD COLUMN deleted_at TEXT");
	}
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_deleted
			ON memory_artifacts(agent_id, is_deleted, deleted_at)
	`);
}

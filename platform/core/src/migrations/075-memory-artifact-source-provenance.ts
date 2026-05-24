import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "memory_artifacts", "source_id", "TEXT");
	addColumnIfMissing(db, "memory_artifacts", "source_root", "TEXT");
	addColumnIfMissing(db, "memory_artifacts", "source_external_id", "TEXT");
	addColumnIfMissing(db, "memory_artifacts", "source_parent_path", "TEXT");
	addColumnIfMissing(db, "memory_artifacts", "source_meta_json", "TEXT");

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source
			ON memory_artifacts(agent_id, source_id, source_external_id);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_source_root
			ON memory_artifacts(agent_id, source_id, source_root);
	`);
}

import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memory_artifacts)").all() as Array<{ name: string }>;
	if (cols.some((col) => col.name === "source_mtime_ms")) return;
	db.exec("ALTER TABLE memory_artifacts ADD COLUMN source_mtime_ms REAL");
}

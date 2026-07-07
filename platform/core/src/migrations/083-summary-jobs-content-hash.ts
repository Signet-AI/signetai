import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "summary_jobs", "content_hash", "TEXT");

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_session_content_hash
		ON summary_jobs(agent_id, session_key, content_hash)
	`);
}

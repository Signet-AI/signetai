import type { MigrationDb } from "./contract";
function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "session_memories", "agent_relevance_score", "REAL");
	addColumnIfMissing(db, "session_memories", "agent_feedback_count", "INTEGER DEFAULT 0");
}

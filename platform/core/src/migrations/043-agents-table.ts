import type { MigrationDb } from "./contract";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			id           TEXT PRIMARY KEY,
			name         TEXT,
			read_policy  TEXT NOT NULL DEFAULT 'isolated',
			policy_group TEXT,
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL
		);
	`);

	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO agents (id, name, read_policy, created_at, updated_at)
		 VALUES ('default', 'default', 'shared', ?, ?)`,
	).run(now, now);
	addColumnIfMissing(db, "memories", "agent_id", "TEXT DEFAULT 'default'");
	addColumnIfMissing(db, "memories", "visibility", "TEXT DEFAULT 'global'");
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_agent_id
			ON memories(agent_id);
		CREATE INDEX IF NOT EXISTS idx_memories_agent_visibility
			ON memories(agent_id, visibility);
	`);
}

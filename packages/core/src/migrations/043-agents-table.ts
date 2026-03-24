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
	if (cols.some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 043: Multi-agent support
 *
 * 1. Creates the `agents` table — agent roster with per-agent read policy.
 * 2. Adds `agent_id` to `memories` — which agent owns each memory.
 * 3. Adds `visibility` to `memories` — per-memory access flag.
 *    Values: 'global' (any permitted agent), 'private' (owner only),
 *    'archived' (soft-deleted when owning agent is removed).
 *
 * Note: the existing `scope` column on memories is for benchmark namespacing
 * (e.g. "memorybench:question_42_run1") and is NOT related to this.
 */
export function up(db: MigrationDb): void {
	// 1. Agent roster table
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

	// 2. Agent ownership column on memories
	addColumnIfMissing(db, "memories", "agent_id", "TEXT DEFAULT 'default'");

	// 3. Visibility flag (separate from scope — benchmark namespacing)
	addColumnIfMissing(db, "memories", "visibility", "TEXT DEFAULT 'global'");

	// Indexes for fast per-agent lookups
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_agent_id
			ON memories(agent_id);
		CREATE INDEX IF NOT EXISTS idx_memories_agent_visibility
			ON memories(agent_id, visibility);
	`);
}

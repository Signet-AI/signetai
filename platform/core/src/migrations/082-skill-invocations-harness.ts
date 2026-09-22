import type { MigrationDb } from "./contract";
function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

const COLUMNS = ["harness", "session_id", "tool_use_id", "cwd", "origin", "args"] as const;

export function up(db: MigrationDb): void {
	for (const column of COLUMNS) {
		if (!hasColumn(db, "skill_invocations", column)) {
			db.exec(`ALTER TABLE skill_invocations ADD COLUMN ${column} TEXT`);
		}
	}
	db.exec("DROP INDEX IF EXISTS idx_skill_inv_dedupe");
	db.exec(`
		CREATE UNIQUE INDEX idx_skill_inv_dedupe
		ON skill_invocations(agent_id, harness, session_id, tool_use_id)
		WHERE harness IS NOT NULL AND session_id IS NOT NULL AND tool_use_id IS NOT NULL
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_skill_inv_harness ON skill_invocations(harness, created_at)");
}

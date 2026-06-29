import type { MigrationDb } from "./index";

/**
 * Migration 081: Harness skill-invocation columns
 *
 * Migration 053 created skill_invocations for Signet's own scheduler/api
 * skill runs. This extends it to capture skill use emitted by external agent
 * harnesses (claude-code, opencode, ...) as source='agent' rows, keyed and
 * deduped on (harness, session_id, tool_use_id) so a harness hook that fires
 * or retries records each invocation once.
 *
 * Idempotent: guards each ADD COLUMN with a pragma check (SQLite ALTER has no
 * IF NOT EXISTS) and uses IF NOT EXISTS on indexes, so it is a no-op on DBs
 * that already had these columns hand-applied.
 */
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

	// Dedupe key for harness-emitted rows. Partial so Signet-internal
	// scheduler/api rows (which have no harness/session/tool ids) never collide.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_inv_dedupe
		ON skill_invocations(harness, session_id, tool_use_id)
		WHERE harness IS NOT NULL AND session_id IS NOT NULL AND tool_use_id IS NOT NULL
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_skill_inv_harness ON skill_invocations(harness, created_at)");
}

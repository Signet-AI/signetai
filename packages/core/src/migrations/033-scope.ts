import type { MigrationDb } from "./index";

/**
 * Add nullable `scope` column to memories table.
 *
 * Normal memories keep `scope = NULL`. Benchmark or namespaced memories
 * get a scoped value (e.g. "memorybench:question_42_run1"). A partial
 * index on non-NULL scopes keeps the overhead at zero for normal queries.
 */
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === "scope")) {
		db.exec("ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT NULL");
	}

	// Partial index — only indexes rows where scope IS NOT NULL, so normal
	// (unscoped) queries pay zero indexing cost.
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL",
	);
}

import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	const passColumns = db.prepare("PRAGMA table_info(dreaming_passes)").all() as Array<{ name: string }>;
	if (!passColumns.some((column) => column.name === "scope_key")) {
		db.exec("ALTER TABLE dreaming_passes ADD COLUMN scope_key TEXT");
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_history_nodes (
			agent_id TEXT NOT NULL,
			scope_key TEXT NOT NULL,
			level INTEGER NOT NULL,
			idx INTEGER NOT NULL,
			pass_id TEXT,
			text TEXT NOT NULL,
			tokens_input INTEGER,
			tokens_output INTEGER,
			tokens_cache_read INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (agent_id, scope_key, level, idx)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_history_nodes_pass
			ON dreaming_history_nodes(pass_id) WHERE pass_id IS NOT NULL;
	`);
}

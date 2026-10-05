import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_history_nodes (
			agent_id TEXT NOT NULL,
			level INTEGER NOT NULL,
			idx INTEGER NOT NULL,
			pass_id TEXT,
			text TEXT NOT NULL,
			tokens_input INTEGER,
			tokens_output INTEGER,
			tokens_cache_read INTEGER,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (agent_id, level, idx)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_history_nodes_pass
			ON dreaming_history_nodes(pass_id) WHERE pass_id IS NOT NULL;
	`);
}

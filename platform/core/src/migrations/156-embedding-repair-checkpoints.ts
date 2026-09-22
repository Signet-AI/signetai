import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_repair_checkpoints (
			checkpoint_id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
			model TEXT NOT NULL CHECK (length(trim(model)) > 0),
			status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
			batches INTEGER NOT NULL DEFAULT 0 CHECK (batches >= 0),
			selected INTEGER NOT NULL DEFAULT 0 CHECK (selected >= 0),
			written INTEGER NOT NULL DEFAULT 0 CHECK (written >= 0),
			failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
			stale INTEGER NOT NULL DEFAULT 0 CHECK (stale >= 0),
			cross_agent_hash_conflicts INTEGER NOT NULL DEFAULT 0 CHECK (cross_agent_hash_conflicts >= 0),
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_embedding_repair_checkpoints_status
			ON embedding_repair_checkpoints(status, updated_at);
	`);
}

import type { MigrationDb } from "./contract";

/**
 * Durable progress for bounded vector-index repair.
 *
 * There is one resumable checkpoint per operation and resolved agent. The
 * checkpoint is intentionally separate from embedding-index migration state:
 * this table tracks repair of the active derived vec index and canonical
 * orphan cleanup, not a provider/profile generation change.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS vector_repair_checkpoints (
			operation TEXT NOT NULL CHECK (operation IN ('resync', 'clean-orphans')),
			agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
			checkpoint_id TEXT NOT NULL UNIQUE,
			phase TEXT NOT NULL CHECK (
				phase IN ('orphan-vectors', 'missing-vectors', 'orphan-embeddings', 'complete')
			),
			cursor TEXT,
			processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
			skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
			failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
			affected INTEGER NOT NULL DEFAULT 0 CHECK (affected >= 0),
			remaining INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0),
			status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (operation, agent_id)
		);
		CREATE INDEX IF NOT EXISTS idx_vector_repair_checkpoints_status
			ON vector_repair_checkpoints(status, updated_at);
	`);
}

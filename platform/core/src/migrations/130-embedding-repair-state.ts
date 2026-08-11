import type { MigrationDb } from "./index";

/**
 * Migration 129: durable admission and retry state for incremental embedding
 * repair. The tracker is intentionally a singleton budget plus per-memory
 * backoff rows, not a second queue or owner for embedding writes.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_repair_budget (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			window_started_at TEXT NOT NULL,
			batches_started INTEGER NOT NULL DEFAULT 0 CHECK (batches_started >= 0),
			last_completed_at TEXT,
			last_affected INTEGER NOT NULL DEFAULT 0 CHECK (last_affected >= 0),
			lease_id TEXT,
			lease_expires_at TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS embedding_repair_backoff (
			memory_id TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			model TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
			retry_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (memory_id, content_hash, model)
		);
		CREATE INDEX IF NOT EXISTS idx_embedding_repair_backoff_retry
			ON embedding_repair_backoff(model, retry_at);
	`);
}

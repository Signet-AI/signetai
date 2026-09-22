import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_index_failures (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content_hash TEXT NOT NULL,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			agent_id TEXT,
			target_fingerprint TEXT NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			failure_class TEXT NOT NULL CHECK (failure_class IN ('context_limit', 'invalid_input')),
			attempts INTEGER NOT NULL DEFAULT 1,
			retry_policy TEXT NOT NULL DEFAULT 'quarantined',
			first_failed_at TEXT NOT NULL,
			last_failed_at TEXT NOT NULL,
			UNIQUE(content_hash, target_fingerprint)
		);
		CREATE INDEX IF NOT EXISTS idx_embedding_index_failures_target
			ON embedding_index_failures(target_fingerprint, failure_class, last_failed_at);
		CREATE INDEX IF NOT EXISTS idx_embedding_index_failures_source
			ON embedding_index_failures(source_type, source_id);
	`);
}

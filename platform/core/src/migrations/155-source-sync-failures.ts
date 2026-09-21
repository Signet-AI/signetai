/** Migration 155: durable per-item outcomes for bounded source traversal. */
import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS source_sync_failures (
			agent_id TEXT NOT NULL,
			source_key TEXT NOT NULL,
			phase TEXT NOT NULL,
			item_path TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			failure_code TEXT NOT NULL,
			terminal INTEGER NOT NULL DEFAULT 1,
			diagnostic TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 1,
			first_observed_at TEXT NOT NULL,
			last_observed_at TEXT NOT NULL,
			retry_after TEXT,
			resolved_at TEXT,
			PRIMARY KEY (agent_id, source_key, phase, item_path)
		);
		CREATE INDEX IF NOT EXISTS idx_source_sync_failures_active
		ON source_sync_failures(agent_id, source_key, phase, item_path)
		WHERE resolved_at IS NULL;
	`);
}

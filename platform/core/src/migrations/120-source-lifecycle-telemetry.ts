/**
 * Migration 120: private source lifecycle state.
 *
 * The table is local correlation state only. The source key is a digest of
 * the configured source identity; it is never copied into telemetry events.
 */
import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS source_lifecycle_state (
			agent_id TEXT NOT NULL,
			source_key TEXT NOT NULL,
			source_class TEXT NOT NULL,
			mode TEXT NOT NULL,
			connected_at TEXT,
			first_indexed_at TEXT,
			first_searchable_at TEXT,
			first_recall_at TEXT,
			last_success_at TEXT,
			last_freshness_state TEXT,
			last_freshness_event_at TEXT,
			PRIMARY KEY (agent_id, source_key)
		);

		CREATE INDEX IF NOT EXISTS idx_source_lifecycle_state_ready
			ON source_lifecycle_state(agent_id, source_class, first_searchable_at, first_recall_at);
	`);
}

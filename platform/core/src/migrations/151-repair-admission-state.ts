import type { MigrationDb } from "./contract";

/**
 * Migration 151: durable admission state for mutating repair actions.
 *
 * The row key is the repair action plus its resolved scope. A lease prevents
 * duplicate work before it starts; the hourly counter is charged at
 * admission so a crash cannot immediately replay an expensive operation.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS repair_admission (
			action TEXT NOT NULL,
			scope TEXT NOT NULL,
			window_started_at TEXT NOT NULL,
			hourly_count INTEGER NOT NULL DEFAULT 0 CHECK (hourly_count >= 0),
			lease_id TEXT,
			lease_expires_at TEXT,
			lease_actor TEXT,
			lease_actor_type TEXT,
			lease_request_id TEXT,
			last_completed_at TEXT,
			last_affected INTEGER NOT NULL DEFAULT 0 CHECK (last_affected >= 0),
			last_completed_actor TEXT,
			last_completed_request_id TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (action, scope)
		);
		CREATE INDEX IF NOT EXISTS idx_repair_admission_lease
			ON repair_admission(lease_expires_at);
	`);
}

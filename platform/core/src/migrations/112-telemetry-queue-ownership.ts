/**
 * Migration 112: Telemetry Queue Ownership
 *
 * Separates daemon and CLI telemetry rows and gives flushers a short-lived
 * claim so concurrent processes cannot send the same batch simultaneously.
 */

import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: MigrationDb, column: string, definition: string): void {
	if (!hasColumn(db, "telemetry_events", column)) {
		db.exec(`ALTER TABLE telemetry_events ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "source", "TEXT NOT NULL DEFAULT 'daemon'");
	addColumnIfMissing(db, "claim_token", "TEXT");
	addColumnIfMissing(db, "claimed_at", "TEXT");
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_telemetry_events_queue
			ON telemetry_events(source, sent_to_posthog, claimed_at, timestamp);
	`);
}

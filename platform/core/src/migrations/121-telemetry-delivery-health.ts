/**
 * Migration 121: durable telemetry delivery health (#1279).
 *
 * The event queue already survives daemon restarts, but delivery outcomes did
 * not. Keep the queue ownership columns intact and add only bounded metadata
 * needed to explain whether an empty remote feed means daemon silence or a
 * collector that is waiting to retry.
 */

import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}

function addColumnIfMissing(db: MigrationDb, column: string, definition: string): void {
	if (!hasColumn(db, "telemetry_events", column)) {
		db.exec(`ALTER TABLE telemetry_events ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "last_attempt_at", "TEXT");
	addColumnIfMissing(db, "sent_at", "TEXT");
	addColumnIfMissing(db, "last_failure_code", "TEXT");

	db.exec(`
		CREATE TABLE IF NOT EXISTS telemetry_delivery_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			window_started_at TEXT NOT NULL,
			success_count INTEGER NOT NULL DEFAULT 0,
			failure_count INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			last_attempt_at TEXT,
			last_success_at TEXT,
			last_failure_code TEXT,
			dropped_event_count INTEGER NOT NULL DEFAULT 0
		);
		INSERT OR IGNORE INTO telemetry_delivery_state (id, window_started_at)
		VALUES (1, CURRENT_TIMESTAMP);
	`);
}

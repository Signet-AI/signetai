/**
 * Migration 018: Timeline Eras
 *
 * Stores auto-detected "era" markers for the timeline visualization.
 * Eras represent distinct periods in an agent's workflow based on
 * entity co-occurrence and memory density patterns.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS timeline_eras (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			start_date TEXT NOT NULL,
			end_date TEXT NOT NULL,
			era_type TEXT NOT NULL,
			entity_patterns TEXT,
			memory_count INTEGER NOT NULL DEFAULT 0,
			top_entities TEXT,
			metadata TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_eras_date_range
			ON timeline_eras(start_date, end_date);
		CREATE INDEX IF NOT EXISTS idx_eras_type
			ON timeline_eras(era_type);
	`);

	// Add emergence tracking columns to entities table
	db.exec(`
		ALTER TABLE entities ADD COLUMN first_seen_at TEXT;
		ALTER TABLE entities ADD COLUMN peak_mentions_at TEXT;
	`);

	// Create index for emergence queries
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_entities_emergence
			ON entities(first_seen_at, mentions DESC);
	`);
}

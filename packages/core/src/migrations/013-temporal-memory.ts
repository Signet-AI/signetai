/**
 * Migration 013: Temporal Memory — Strength & Rehearsal Tracking
 *
 * Adds Ebbinghaus-inspired memory strength columns to the memories table:
 *   - strength: Current memory strength [0, 1], decays over time
 *   - last_rehearsed: Timestamp of last rehearsal event
 *   - rehearsal_count: Number of times this memory has been rehearsed
 *
 * Also adds an index on strength for efficient ordering by memory vitality.
 */

import type { MigrationDb } from "./index";

/** Helper: add a column only if it doesn't already exist. */
function addColumnIfMissing(
	db: MigrationDb,
	table: string,
	column: string,
	definition: string,
): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<
		Record<string, unknown>
	>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	// Add temporal memory columns
	addColumnIfMissing(db, "memories", "strength", "REAL DEFAULT 1.0");
	addColumnIfMissing(db, "memories", "last_rehearsed", "TEXT");
	addColumnIfMissing(db, "memories", "rehearsal_count", "INTEGER DEFAULT 0");

	// Index for sorting/filtering by strength
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_strength
			ON memories(strength DESC);
	`);
}

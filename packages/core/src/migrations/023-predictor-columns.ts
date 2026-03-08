/**
 * Migration 023: Predictor Columns on session_memories
 *
 * Adds predictor_rank column to session_memories for Sprint 2 scoring
 * integration. The predictor_score and final_score columns already exist
 * from migration 015; entity_slot, aspect_slot, is_constraint, and
 * structural_density were added in migration 020.
 */

import type { MigrationDb } from "./index";

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
	// predictor_rank tracks the predictor-assigned rank for comparison analysis
	addColumnIfMissing(db, "session_memories", "predictor_rank", "INTEGER");
}

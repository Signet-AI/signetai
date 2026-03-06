/**
 * Migration 024: Additional columns on predictor_comparisons
 *
 * Adds columns needed by Sprint 3 session-end comparison logic:
 * - scorer_confidence: continuity scorer confidence for gating EMA updates
 * - success_rate: snapshot of success rate at time of comparison
 * - predictor_top_ids: JSON array of top-10 predictor-ranked memory IDs
 * - baseline_top_ids: JSON array of top-10 baseline-ranked memory IDs
 * - relevance_scores: JSON map of memory_id -> relevance score
 * - fts_overlap_score: fraction of injected memories with FTS hits
 */

import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (!cols.some((c) => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "predictor_comparisons", "scorer_confidence", "REAL NOT NULL DEFAULT 0");
	addColumnIfMissing(db, "predictor_comparisons", "success_rate", "REAL NOT NULL DEFAULT 0.5");
	addColumnIfMissing(db, "predictor_comparisons", "predictor_top_ids", "TEXT NOT NULL DEFAULT '[]'");
	addColumnIfMissing(db, "predictor_comparisons", "baseline_top_ids", "TEXT NOT NULL DEFAULT '[]'");
	addColumnIfMissing(db, "predictor_comparisons", "relevance_scores", "TEXT NOT NULL DEFAULT '{}'");
	addColumnIfMissing(db, "predictor_comparisons", "fts_overlap_score", "REAL");
}

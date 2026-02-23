/**
 * Migration 015: Decision Memory + Contradiction Detection
 *
 * Phase 2 — Tasks 2.4 & 2.6
 *
 * Creates two new tables:
 *   - decisions: structured decision metadata (reasoning chains,
 *     alternatives considered, outcomes, confidence, revisitable flag)
 *   - contradictions: audit trail for semantic contradictions detected
 *     between memories, with resolution strategy and status
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	// -------------------------------------------------------------------
	// decisions — structured metadata for decision-type memories
	// -------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS decisions (
			id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL,
			conclusion TEXT NOT NULL,
			reasoning TEXT,
			alternatives TEXT,
			context_session TEXT,
			confidence REAL DEFAULT 0.5,
			revisitable INTEGER DEFAULT 1,
			outcome TEXT,
			outcome_notes TEXT,
			outcome_at TEXT,
			created_at TEXT NOT NULL,
			reviewed_at TEXT,
			FOREIGN KEY (memory_id) REFERENCES memories(id)
		);

		CREATE INDEX IF NOT EXISTS idx_decisions_memory_id
			ON decisions(memory_id);
		CREATE INDEX IF NOT EXISTS idx_decisions_revisitable
			ON decisions(revisitable);
		CREATE INDEX IF NOT EXISTS idx_decisions_outcome
			ON decisions(outcome);
		CREATE INDEX IF NOT EXISTS idx_decisions_created_at
			ON decisions(created_at DESC);
	`);

	// -------------------------------------------------------------------
	// contradictions — audit trail for detected semantic contradictions
	// -------------------------------------------------------------------
	db.exec(`
		CREATE TABLE IF NOT EXISTS contradictions (
			id TEXT PRIMARY KEY,
			new_memory_id TEXT NOT NULL,
			old_memory_id TEXT NOT NULL,
			resolution TEXT,
			reasoning TEXT,
			resolved_by TEXT DEFAULT 'auto',
			created_at TEXT NOT NULL,
			FOREIGN KEY (new_memory_id) REFERENCES memories(id),
			FOREIGN KEY (old_memory_id) REFERENCES memories(id)
		);

		CREATE INDEX IF NOT EXISTS idx_contradictions_new_memory
			ON contradictions(new_memory_id);
		CREATE INDEX IF NOT EXISTS idx_contradictions_old_memory
			ON contradictions(old_memory_id);
		CREATE INDEX IF NOT EXISTS idx_contradictions_resolution
			ON contradictions(resolution);
	`);
}

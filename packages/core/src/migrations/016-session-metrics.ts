/**
 * Migration 016: Session Metrics
 *
 * Phase 2 Task 2.3 + Phase 3 Task 3.6
 *
 * Creates the session_metrics table for tracking per-session
 * continuity scoring: how well injected memories carry over,
 * how many facts had to be reconstructed, and the resulting
 * continuity score (0.0–1.0).
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_metrics (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			harness TEXT,
			memories_injected INTEGER NOT NULL DEFAULT 0,
			memories_used INTEGER NOT NULL DEFAULT 0,
			facts_reconstructed INTEGER NOT NULL DEFAULT 0,
			new_memories INTEGER NOT NULL DEFAULT 0,
			continuity_score REAL NOT NULL DEFAULT 0.0,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_session_metrics_session_id
			ON session_metrics(session_id);
		CREATE INDEX IF NOT EXISTS idx_session_metrics_created_at
			ON session_metrics(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_session_metrics_harness
			ON session_metrics(harness);
	`);
}

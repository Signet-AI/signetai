/**
 * Migration 016: Session Checkpoints
 *
 * Persistence layer for the session continuity protocol.
 * Stores rolling digests so agents can recover context
 * after compaction or session restart.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_checkpoints (
			id TEXT PRIMARY KEY,
			session_key TEXT NOT NULL,
			harness TEXT NOT NULL,
			project TEXT,
			project_normalized TEXT,
			trigger TEXT NOT NULL,
			digest TEXT NOT NULL,
			prompt_count INTEGER NOT NULL,
			memory_queries TEXT,
			recent_remembers TEXT,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_checkpoints_session
			ON session_checkpoints(session_key, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_checkpoints_project
			ON session_checkpoints(project_normalized, created_at DESC);
	`);
}

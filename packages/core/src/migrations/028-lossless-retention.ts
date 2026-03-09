/**
 * Migration 027: Lossless Retention (Cold Tier)
 *
 * Replaces hard deletion of tombstoned memories with cold-tier archival.
 * Nothing is ever truly lost — expired memories are archived into
 * memories_cold before being removed from the active table.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memories_cold (
			id TEXT PRIMARY KEY,
			type TEXT DEFAULT 'fact',
			category TEXT,
			content TEXT NOT NULL,
			confidence REAL DEFAULT 1.0,
			importance REAL DEFAULT 0.5,
			source_id TEXT,
			source_type TEXT,
			tags TEXT,
			who TEXT,
			why TEXT,
			project TEXT,
			content_hash TEXT,
			normalized_content TEXT,
			extraction_status TEXT,
			embedding_model TEXT,
			extraction_model TEXT,
			update_count INTEGER DEFAULT 0,
			original_created_at TEXT NOT NULL,
			archived_at TEXT NOT NULL,
			archived_reason TEXT,
			cold_source_id TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default'
		);

		CREATE INDEX IF NOT EXISTS idx_cold_agent ON memories_cold(agent_id);
		CREATE INDEX IF NOT EXISTS idx_cold_project ON memories_cold(project);
		CREATE INDEX IF NOT EXISTS idx_cold_archived_at ON memories_cold(archived_at);
		CREATE INDEX IF NOT EXISTS idx_cold_source ON memories_cold(cold_source_id);
	`);
}

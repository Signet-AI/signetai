/**
 * Migration 017: Perception Tables
 *
 * Creates the raw capture storage tables for the ambient perception layer.
 * These tables hold ephemeral raw data (auto-deleted after retention_days).
 * Extracted knowledge persists as signed Signet memories.
 *
 * Tables: perception_screen, perception_voice, perception_files,
 *         perception_terminal, perception_comms, perception_state
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS perception_screen (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			focused_app TEXT,
			focused_window TEXT,
			bundle_id TEXT,
			ocr_text TEXT,
			vlm_description TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS perception_voice (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			duration_seconds REAL,
			transcript TEXT,
			confidence REAL,
			language TEXT DEFAULT 'en',
			is_speaking INTEGER DEFAULT 1,
			speaker_label TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS perception_files (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			event_type TEXT NOT NULL,
			file_path TEXT NOT NULL,
			file_type TEXT,
			is_git_repo INTEGER DEFAULT 0,
			git_branch TEXT,
			size_bytes INTEGER,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS perception_terminal (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			command TEXT NOT NULL,
			working_directory TEXT,
			exit_code INTEGER,
			shell TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS perception_comms (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			source TEXT NOT NULL,
			content TEXT,
			metadata TEXT,
			created_at TEXT DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS perception_state (
			key TEXT PRIMARY KEY,
			value TEXT,
			updated_at TEXT DEFAULT (datetime('now'))
		);

		-- Indexes for rolling cleanup and time-range queries
		CREATE INDEX IF NOT EXISTS idx_perception_screen_ts
			ON perception_screen(timestamp);
		CREATE INDEX IF NOT EXISTS idx_perception_voice_ts
			ON perception_voice(timestamp);
		CREATE INDEX IF NOT EXISTS idx_perception_files_ts
			ON perception_files(timestamp);
		CREATE INDEX IF NOT EXISTS idx_perception_terminal_ts
			ON perception_terminal(timestamp);
		CREATE INDEX IF NOT EXISTS idx_perception_comms_ts
			ON perception_comms(timestamp);
	`);
}

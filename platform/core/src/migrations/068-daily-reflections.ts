import type { MigrationDb } from "./index";

/**
 * Migration 068: Daily reflections.
 *
 * Stores generated daily narrative insights and user answers.
 * Each row represents one day's reflection for one agent.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS daily_reflections (
			id               TEXT PRIMARY KEY,
			agent_id         TEXT NOT NULL DEFAULT 'default',
			date             TEXT NOT NULL,
			summary          TEXT NOT NULL DEFAULT '',
			patterns         TEXT NOT NULL DEFAULT '[]',
			question         TEXT,
			answer           TEXT,
			answer_memory_id TEXT,
			content_key      TEXT,
			memory_ids       TEXT NOT NULL DEFAULT '[]',
			summary_ids      TEXT NOT NULL DEFAULT '[]',
			model            TEXT,
			created_at       TEXT NOT NULL DEFAULT (datetime('now')),
			answered_at      TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
			ON daily_reflections(agent_id, date, content_key)
			WHERE content_key IS NOT NULL;
	`);
}

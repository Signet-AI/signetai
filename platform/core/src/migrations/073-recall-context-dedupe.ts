import type { MigrationDb } from "./index";

/**
 * Migration 073: Durable per-session recall context dedupe.
 *
 * Tracks which recall items have already been returned or injected within the
 * current context epoch for a session and agent. Compaction-complete advances
 * the epoch so prior items can be recalled again in the fresh context.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_context_epochs (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			context_epoch INTEGER NOT NULL DEFAULT 0,
			reason TEXT NOT NULL,
			source_ref TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_key, agent_id, context_epoch)
		);

		CREATE INDEX IF NOT EXISTS idx_session_context_epochs_created
			ON session_context_epochs(agent_id, created_at DESC);

		CREATE TABLE IF NOT EXISTS session_recall_events (
			session_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT 'default',
			context_epoch INTEGER NOT NULL DEFAULT 0,
			item_kind TEXT NOT NULL,
			item_id TEXT NOT NULL,
			surface TEXT NOT NULL,
			mode TEXT NOT NULL,
			score REAL,
			source TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (session_key, agent_id, context_epoch, item_kind, item_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_recall_events_session
			ON session_recall_events(session_key, agent_id, context_epoch, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_session_recall_events_item
			ON session_recall_events(item_kind, item_id, created_at DESC);
	`);
}

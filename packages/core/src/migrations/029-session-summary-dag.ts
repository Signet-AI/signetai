import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_summaries (
			id TEXT PRIMARY KEY,
			project TEXT,
			depth INTEGER NOT NULL DEFAULT 0,
			kind TEXT NOT NULL CHECK(kind IN ('session', 'arc', 'epoch')),
			content TEXT NOT NULL,
			token_count INTEGER,
			earliest_at TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			session_key TEXT,
			harness TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS session_summary_children (
			parent_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			child_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (parent_id, child_id)
		);

		-- No FK on memory_id: memories may be soft-deleted, purged, or
		-- archived to cold tier. The link is intentionally durable so
		-- summary lineage survives retention sweeps.
		CREATE TABLE IF NOT EXISTS session_summary_memories (
			summary_id TEXT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
			memory_id TEXT NOT NULL,
			PRIMARY KEY (summary_id, memory_id)
		);

		CREATE INDEX IF NOT EXISTS idx_summaries_project_depth ON session_summaries(project, depth);
		CREATE INDEX IF NOT EXISTS idx_summaries_kind ON session_summaries(kind);
		CREATE INDEX IF NOT EXISTS idx_summaries_agent ON session_summaries(agent_id);
		CREATE INDEX IF NOT EXISTS idx_summaries_latest ON session_summaries(latest_at DESC);
		CREATE INDEX IF NOT EXISTS idx_summary_children_child ON session_summary_children(child_id);
	`);
}

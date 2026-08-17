import type { MigrationDb } from "./index";

/** Audited, agent-scoped history for Dreaming-curated MEMORY.md entries. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_head_revisions (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			content_hash TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			entry_text TEXT NOT NULL,
			operation TEXT NOT NULL CHECK (operation IN ('added', 'updated', 'removed', 'deferred', 'no-op')),
			source_refs_json TEXT NOT NULL,
			supporting_quotes_json TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(agent_id, revision, entry_id)
		);
		CREATE INDEX IF NOT EXISTS idx_memory_head_revisions_agent
			ON memory_head_revisions(agent_id, revision DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_head_revisions_pass
			ON memory_head_revisions(agent_id, pass_id);
	`);
}

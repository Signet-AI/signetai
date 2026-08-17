import type { MigrationDb } from "./index";

/** Durable post-commit publication intents for the DB-authoritative memory head. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_head_publications (
			agent_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			revision_id TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
			created_at TEXT NOT NULL,
			completed_at TEXT,
			PRIMARY KEY(agent_id, revision),
			UNIQUE(agent_id, revision_id)
		);
		CREATE INDEX IF NOT EXISTS idx_memory_head_publications_pending
			ON memory_head_publications(agent_id, status, revision DESC);
	`);
}

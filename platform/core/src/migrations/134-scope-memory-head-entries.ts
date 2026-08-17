import type { MigrationDb } from "./index";

/** Repair migration 134: scope legacy memory-head entry identity by agent. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE memory_head_entries_v134 (
			entry_id TEXT NOT NULL, agent_id TEXT NOT NULL, canonical_text TEXT NOT NULL,
			entry_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','removed','superseded')),
			first_revision INTEGER NOT NULL, last_revision INTEGER NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			PRIMARY KEY(agent_id, entry_id)
		);
		INSERT INTO memory_head_entries_v134
		 SELECT entry_id, agent_id, canonical_text, entry_hash, status, first_revision, last_revision, created_at, updated_at
		 FROM memory_head_entries;
		DROP TABLE memory_head_entries;
		ALTER TABLE memory_head_entries_v134 RENAME TO memory_head_entries;
		CREATE INDEX idx_memory_head_entries_agent
		 ON memory_head_entries(agent_id, entry_id, last_revision DESC);
	`);
}

import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_content_safety (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary', 'source_chunk')),
			source_id TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('clean', 'tainted', 'blocked')),
			context_eligible INTEGER NOT NULL CHECK (context_eligible IN (0, 1)),
			reasons_json TEXT NOT NULL DEFAULT '[]',
			policy_version TEXT NOT NULL,
			scanned_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_kind, source_id)
		);

		CREATE INDEX IF NOT EXISTS idx_memory_content_safety_status
			ON memory_content_safety(agent_id, status, source_kind);
		CREATE INDEX IF NOT EXISTS idx_memory_content_safety_eligibility
			ON memory_content_safety(agent_id, source_kind, context_eligible);
	`);
}

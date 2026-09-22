import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_evidence_reviews (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary')),
			source_id TEXT NOT NULL,
			source_captured_at TEXT NOT NULL,
			source_entry_id TEXT NOT NULL DEFAULT '',
			source_revision TEXT NOT NULL,
			reason TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision)
		);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_reviews_agent
			ON dreaming_evidence_reviews (agent_id, reviewed_at DESC);
	`);
}

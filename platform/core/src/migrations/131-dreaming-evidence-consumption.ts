import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_evidence_consumption (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary')),
			source_id TEXT NOT NULL,
			source_captured_at TEXT NOT NULL,
			source_entry_id TEXT NOT NULL DEFAULT '',
			source_revision TEXT NOT NULL,
			delivered_offset INTEGER NOT NULL CHECK (delivered_offset >= 0),
			source_length INTEGER NOT NULL CHECK (source_length >= 0),
			pass_id TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision)
		);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_consumption_source
			ON dreaming_evidence_consumption(agent_id, source_entry_id, source_kind, source_revision);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_consumption_pending
			ON dreaming_evidence_consumption(agent_id, source_kind, source_id, source_captured_at, source_revision, delivered_offset, source_length);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_consumption_continuation
			ON dreaming_evidence_consumption(agent_id, pass_id, delivered_offset, source_length);
	`);
}

import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_evidence_exclusions (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary')),
			source_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			excluded_at TEXT NOT NULL DEFAULT (datetime('now')),
			requeue_requested_at TEXT,
			resolved_at TEXT,
			PRIMARY KEY (agent_id, source_kind, source_id)
		);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_exclusions_active
			ON dreaming_evidence_exclusions (agent_id, resolved_at, requeue_requested_at, excluded_at DESC);
	`);
}

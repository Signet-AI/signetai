import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_evidence_leases (
			agent_id TEXT NOT NULL,
			source_kind TEXT NOT NULL CHECK (source_kind IN ('memory', 'artifact', 'transcript', 'summary')),
			source_id TEXT NOT NULL,
			pass_id TEXT NOT NULL,
			leased_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_kind, source_id)
		);
		CREATE INDEX IF NOT EXISTS idx_dreaming_evidence_leases_pass
			ON dreaming_evidence_leases(pass_id);
	`);
}

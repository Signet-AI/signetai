import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dreaming_attention (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('review_due', 'hygiene', 'contested_claim', 'evidence_requeue')),
			subject_ref TEXT NOT NULL,
			details_json TEXT NOT NULL DEFAULT '{}',
			priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0 AND priority <= 100),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			generation INTEGER NOT NULL DEFAULT 0,
			resolved_at TEXT,
			resolved_by_pass_id TEXT,
			UNIQUE(agent_id, kind, subject_ref)
		);
		CREATE INDEX IF NOT EXISTS idx_dreaming_attention_pending
			ON dreaming_attention (agent_id, resolved_at, priority DESC, created_at ASC);
	`);
}

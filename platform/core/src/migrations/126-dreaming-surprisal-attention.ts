import type { MigrationDb } from "./index";

/**
 * Add the opt-in embedding-geometry attention kind without rewriting any
 * attention records. SQLite CHECK constraints are part of the table definition,
 * so existing installs need an additive table rebuild rather than an ALTER
 * COLUMN. The migration runs inside the migration runner's savepoint.
 */
export function up(db: MigrationDb): void {
	const table = db
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_attention'")
		.get() as { sql?: string | null } | undefined;
	if (!table) return;
	if (table.sql?.includes("'surprisal'")) return;

	db.exec(`
		DROP INDEX IF EXISTS idx_dreaming_attention_pending;
		ALTER TABLE dreaming_attention RENAME TO dreaming_attention_legacy_126;
		CREATE TABLE dreaming_attention (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('review_due', 'hygiene', 'contested_claim', 'evidence_requeue', 'surprisal')),
			subject_ref TEXT NOT NULL,
			details_json TEXT NOT NULL DEFAULT '{}',
			priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0 AND priority <= 100),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			generation INTEGER NOT NULL DEFAULT 0,
			resolved_at TEXT,
			resolved_by_pass_id TEXT,
			UNIQUE(agent_id, kind, subject_ref)
		);
		INSERT INTO dreaming_attention (
			id, agent_id, kind, subject_ref, details_json, priority, created_at,
			generation, resolved_at, resolved_by_pass_id
		)
		SELECT id, agent_id, kind, subject_ref, details_json, priority, created_at,
			generation, resolved_at, resolved_by_pass_id
		FROM dreaming_attention_legacy_126;
		DROP TABLE dreaming_attention_legacy_126;
		CREATE INDEX idx_dreaming_attention_pending
			ON dreaming_attention (agent_id, resolved_at, priority DESC, created_at ASC);
	`);
}

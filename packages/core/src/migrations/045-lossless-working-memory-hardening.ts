import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 045: Lossless working-memory hardening
 *
 * Adds:
 * - transcript recency + FTS search support for prompt-time fallback lookup
 * - agent scoping columns for summary runtime tables
 * - DB-backed MEMORY.md head metadata for merge-safe writes
 */
export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "session_transcripts", "updated_at", "TEXT");
	addColumnIfMissing(db, "summary_jobs", "agent_id", "TEXT NOT NULL DEFAULT 'default'");
	addColumnIfMissing(db, "session_scores", "agent_id", "TEXT NOT NULL DEFAULT 'default'");

	db.exec(`
		UPDATE session_transcripts
		SET updated_at = COALESCE(updated_at, created_at)
		WHERE updated_at IS NULL;

		UPDATE summary_jobs
		SET agent_id = COALESCE(agent_id, 'default')
		WHERE agent_id IS NULL;

		UPDATE session_scores
		SET agent_id = COALESCE(agent_id, 'default')
		WHERE agent_id IS NULL;

		CREATE INDEX IF NOT EXISTS idx_st_agent_updated
			ON session_transcripts(agent_id, updated_at);
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent
			ON summary_jobs(agent_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_session_scores_agent_session
			ON session_scores(agent_id, session_key, created_at);
	`);

	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		)
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END
	`);

	db.exec(`
		INSERT INTO session_transcripts_fts(session_transcripts_fts)
		VALUES ('rebuild');
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_md_heads (
			agent_id TEXT PRIMARY KEY,
			content TEXT NOT NULL DEFAULT '',
			content_hash TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			lease_token TEXT,
			lease_owner TEXT,
			lease_expires_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_memory_md_heads_lease
			ON memory_md_heads(lease_expires_at);
	`);
}

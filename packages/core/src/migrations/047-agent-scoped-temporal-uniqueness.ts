import type { MigrationDb } from "./index";

/**
 * Migration 047: Agent-scoped temporal uniqueness
 *
 * Fixes scoping leaks in temporal storage by making transcript and
 * session-summary retry uniqueness agent-aware.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		DROP TRIGGER IF EXISTS session_transcripts_fts_ai;
		DROP TRIGGER IF EXISTS session_transcripts_fts_ad;
		DROP TRIGGER IF EXISTS session_transcripts_fts_au;
		DROP TABLE IF EXISTS session_transcripts_fts;

		CREATE TABLE IF NOT EXISTS session_transcripts_next (
			session_key TEXT NOT NULL,
			content TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			agent_id TEXT NOT NULL DEFAULT 'default',
			created_at TEXT NOT NULL,
			updated_at TEXT,
			PRIMARY KEY (agent_id, session_key)
		);

		INSERT INTO session_transcripts_next (
			session_key,
			content,
			harness,
			project,
			agent_id,
			created_at,
			updated_at
		)
		SELECT
			session_key,
			content,
			harness,
			project,
			agent_id,
			created_at,
			updated_at
		FROM (
			SELECT
				session_key,
				content,
				harness,
				project,
				COALESCE(agent_id, 'default') AS agent_id,
				created_at,
				COALESCE(updated_at, created_at) AS updated_at,
				ROW_NUMBER() OVER (
					PARTITION BY COALESCE(agent_id, 'default'), session_key
					ORDER BY COALESCE(updated_at, created_at) DESC, LENGTH(content) DESC, created_at DESC, rowid DESC
				) AS rn
			FROM session_transcripts
		) ranked
		WHERE rn = 1;

		DROP TABLE session_transcripts;
		ALTER TABLE session_transcripts_next RENAME TO session_transcripts;

		CREATE INDEX IF NOT EXISTS idx_st_project
			ON session_transcripts(project);
		CREATE INDEX IF NOT EXISTS idx_st_created
			ON session_transcripts(created_at);
		CREATE INDEX IF NOT EXISTS idx_st_agent_updated
			ON session_transcripts(agent_id, updated_at);

		CREATE VIRTUAL TABLE IF NOT EXISTS session_transcripts_fts USING fts5(
			content,
			content='session_transcripts',
			content_rowid='rowid'
		);

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ai AFTER INSERT ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_ad AFTER DELETE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
		END;

		CREATE TRIGGER IF NOT EXISTS session_transcripts_fts_au AFTER UPDATE ON session_transcripts BEGIN
			INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, content)
			VALUES ('delete', old.rowid, old.content);
			INSERT INTO session_transcripts_fts(rowid, content)
			VALUES (new.rowid, new.content);
		END;

		INSERT INTO session_transcripts_fts(session_transcripts_fts)
		VALUES ('rebuild');

		DROP INDEX IF EXISTS idx_summaries_session_depth;
		DROP INDEX IF EXISTS idx_summaries_session_depth_summary;
		CREATE INDEX IF NOT EXISTS idx_summaries_agent_session_key
			ON session_summaries(agent_id, session_key);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_agent_session_depth_summary
			ON session_summaries(agent_id, session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}

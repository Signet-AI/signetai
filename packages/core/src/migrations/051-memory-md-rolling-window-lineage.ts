import type { MigrationDb } from "./index";

function addColumnIfMissing(db: MigrationDb, table: string, column: string, definition: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	if (cols.some((col) => col.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Migration 050: MEMORY.md rolling-window lineage
 *
 * Adds:
 * - richer summary job metadata so session-end and checkpoint flows can
 *   preserve canonical timing/identity context
 * - canonical markdown artifact index + FTS table for rebuildable lineage/search
 * - tombstones so privacy removals survive re-index
 */
export function up(db: MigrationDb): void {
	addColumnIfMissing(db, "summary_jobs", "session_id", "TEXT");
	addColumnIfMissing(db, "summary_jobs", "trigger", "TEXT NOT NULL DEFAULT 'session_end'");
	addColumnIfMissing(db, "summary_jobs", "captured_at", "TEXT");
	addColumnIfMissing(db, "summary_jobs", "started_at", "TEXT");
	addColumnIfMissing(db, "summary_jobs", "ended_at", "TEXT");

	db.exec(`
		UPDATE summary_jobs
		SET
			session_id = COALESCE(session_id, session_key, id),
			trigger = COALESCE(NULLIF(trigger, ''), 'session_end'),
			captured_at = COALESCE(captured_at, completed_at, created_at),
			ended_at = COALESCE(ended_at, completed_at)
		WHERE 1 = 1;

		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_trigger
			ON summary_jobs(agent_id, trigger, created_at);
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_agent_session
			ON summary_jobs(agent_id, session_key, created_at);
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_artifacts (
			agent_id TEXT NOT NULL DEFAULT 'default',
			source_path TEXT NOT NULL,
			source_sha256 TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			session_id TEXT NOT NULL,
			session_key TEXT,
			session_token TEXT NOT NULL,
			project TEXT,
			harness TEXT,
			captured_at TEXT NOT NULL,
			started_at TEXT,
			ended_at TEXT,
			manifest_path TEXT,
			source_node_id TEXT,
			memory_sentence TEXT,
			memory_sentence_quality TEXT,
			content TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, source_path)
		);

		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_kind
			ON memory_artifacts(agent_id, source_kind, captured_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_session
			ON memory_artifacts(agent_id, session_token, captured_at DESC);
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_membership
			ON memory_artifacts(agent_id, COALESCE(ended_at, captured_at) DESC);

		CREATE TABLE IF NOT EXISTS memory_artifact_tombstones (
			agent_id TEXT NOT NULL DEFAULT 'default',
			session_token TEXT NOT NULL,
			removed_at TEXT NOT NULL,
			reason TEXT NOT NULL,
			removed_paths TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_token)
		);
	`);

	db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS memory_artifacts_fts USING fts5(
			content,
			source_path,
			content='memory_artifacts',
			content_rowid='rowid'
		)
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ai AFTER INSERT ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(rowid, content, source_path)
			VALUES (new.rowid, new.content, new.source_path);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_ad AFTER DELETE ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
			VALUES ('delete', old.rowid, old.content, old.source_path);
		END
	`);

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS memory_artifacts_fts_au AFTER UPDATE ON memory_artifacts BEGIN
			INSERT INTO memory_artifacts_fts(memory_artifacts_fts, rowid, content, source_path)
			VALUES ('delete', old.rowid, old.content, old.source_path);
			INSERT INTO memory_artifacts_fts(rowid, content, source_path)
			VALUES (new.rowid, new.content, new.source_path);
		END
	`);

	db.exec(`
		INSERT INTO memory_artifacts_fts(memory_artifacts_fts)
		VALUES ('rebuild');
	`);
}

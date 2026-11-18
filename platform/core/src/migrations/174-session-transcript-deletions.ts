import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	const memoryColumns = db.prepare("PRAGMA table_info(memories)").all();
	for (const column of ["source_id", "source_type"]) {
		if (!memoryColumns.some((row) => row.name === column)) db.exec(`ALTER TABLE memories ADD COLUMN ${column} TEXT`);
	}
	if (
		!db
			.prepare("PRAGMA table_info(source_import_records)")
			.all()
			.some((row) => row.name === "redacted_bytes")
	)
		db.exec("ALTER TABLE source_import_records ADD COLUMN redacted_bytes INTEGER NOT NULL DEFAULT 0");
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_transcript_deletions (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			generation INTEGER NOT NULL DEFAULT 1,
			watermark TEXT NOT NULL,
			opened_at TEXT,
			blocked INTEGER NOT NULL DEFAULT 1,
			ended INTEGER NOT NULL DEFAULT 0,
			pending_start INTEGER NOT NULL DEFAULT 0,
			lifecycle_seq INTEGER NOT NULL DEFAULT 0,
			receipt_generation INTEGER NOT NULL DEFAULT 1,
			harness TEXT,
			project TEXT,
			hard INTEGER NOT NULL DEFAULT 0,
			phase TEXT NOT NULL DEFAULT 'evidence',
			counts TEXT NOT NULL DEFAULT '{}',
			PRIMARY KEY (agent_id, session_key)
		);
		CREATE TABLE IF NOT EXISTS session_transcript_deleted_prefixes (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			generation INTEGER NOT NULL,
			record_count INTEGER NOT NULL,
			record_hash TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_key, generation)
		);
		CREATE TABLE IF NOT EXISTS session_transcript_deleted_sources (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			generation INTEGER NOT NULL,
			kind TEXT NOT NULL,
			id TEXT NOT NULL,
			outcome TEXT NOT NULL DEFAULT 'deleted',
			PRIMARY KEY (agent_id, session_key, generation, kind, id)
		);
		CREATE TABLE IF NOT EXISTS session_transcript_delete_files (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			generation INTEGER NOT NULL,
			path TEXT NOT NULL,
			checkpoint TEXT,
			done INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (agent_id, session_key, generation, path)
		);
		CREATE INDEX IF NOT EXISTS idx_import_records_session_delete ON source_import_records(agent_id,canonical_key,redacted_bytes);
		CREATE INDEX IF NOT EXISTS idx_memories_session_delete_source ON memories(agent_id,source_id);
		CREATE INDEX IF NOT EXISTS idx_capture_jobs_session_delete ON transcript_capture_jobs(agent_id,session_key);
		CREATE INDEX IF NOT EXISTS idx_session_delete_source_lookup
			ON session_transcript_deleted_sources(agent_id, kind, id, outcome);
	`);
	const columns = db.prepare("PRAGMA table_info(session_transcript_deletions)").all();
	for (const column of ["pending_start", "lifecycle_seq"]) {
		if (!columns.some((row) => row.name === column))
			db.exec(`ALTER TABLE session_transcript_deletions ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
	}
}

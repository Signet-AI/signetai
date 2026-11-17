import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	if (!db.prepare("SELECT 1 FROM pragma_table_info('source_import_records') WHERE name = 'redacted_bytes'").get())
		db.exec("ALTER TABLE source_import_records ADD COLUMN redacted_bytes INTEGER NOT NULL DEFAULT 0");
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_source_import_records_session ON source_import_records(agent_id,canonical_key);
		CREATE TABLE IF NOT EXISTS session_transcript_deletions (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			harness TEXT,
			project TEXT,
			hard INTEGER NOT NULL DEFAULT 0,
			requested_at TEXT NOT NULL,
			completed_at TEXT,
			targets TEXT NOT NULL DEFAULT '[]',
			PRIMARY KEY (agent_id, session_key)
		) WITHOUT ROWID;
		CREATE TABLE IF NOT EXISTS session_transcript_deleted_memories (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			memory_id TEXT NOT NULL,
			PRIMARY KEY (agent_id, session_key, memory_id)
		) WITHOUT ROWID;
	`);
	for (const table of ["session_transcripts", "session_summaries", "memory_artifacts", "transcript_capture_jobs"]) {
		for (const action of ["INSERT", "UPDATE"]) {
			db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_transcript_delete_${action.toLowerCase()}
				BEFORE ${action} ON ${table}
				WHEN EXISTS (SELECT 1 FROM session_transcript_deletions d WHERE d.agent_id = NEW.agent_id AND d.session_key = NEW.session_key)
				BEGIN SELECT RAISE(ABORT, 'session transcript deleted'); END;`);
		}
	}
	for (const action of ["INSERT", "UPDATE"]) {
		db.exec(`CREATE TRIGGER IF NOT EXISTS memories_transcript_delete_${action.toLowerCase()}
			BEFORE ${action} ON memories
			WHEN COALESCE(NEW.is_deleted, 0) = 0 AND EXISTS (
				SELECT 1 FROM session_transcript_deletions d WHERE d.agent_id = NEW.agent_id
				AND ((d.session_key = NEW.source_id AND (NEW.type = 'session_summary' OR NEW.source_type IN ('transcript','session','session_summary','checkpoint',d.harness)))
				OR EXISTS (SELECT 1 FROM session_transcript_deleted_memories m WHERE m.agent_id = d.agent_id AND m.session_key = d.session_key AND m.memory_id = NEW.id)))
			BEGIN SELECT RAISE(ABORT, 'session transcript deleted'); END;`);
	}
	db.exec(`CREATE TRIGGER IF NOT EXISTS derived_memories_transcript_delete
		BEFORE INSERT ON derived_memory_sources
		WHEN NEW.source_kind = 'transcript' AND EXISTS (SELECT 1 FROM session_transcript_deletions d WHERE d.agent_id = NEW.agent_id AND d.session_key = NEW.source_id)
		BEGIN SELECT RAISE(ABORT, 'session transcript deleted'); END;`);
}

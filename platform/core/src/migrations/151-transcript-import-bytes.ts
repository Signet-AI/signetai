import type { MigrationDb } from "./contract";

/** Raw evidence is immutable once sealed; legacy paths require explicit migration. */
export function up(db: MigrationDb): void {
	for (const [column, definition] of [
		["upload_generation", "INTEGER NOT NULL DEFAULT 0"],
		["upload_offset", "INTEGER NOT NULL DEFAULT 0"],
		["upload_size", "INTEGER"],
		["upload_digest", "TEXT NOT NULL DEFAULT ''"],
		["checkpoint_line_number", "INTEGER NOT NULL DEFAULT 0"],
		["reserved_bytes", "INTEGER NOT NULL DEFAULT 0"],
		["original_path", "TEXT"],
		[
			"storage_state",
			"TEXT NOT NULL DEFAULT 'legacy' CHECK (storage_state IN ('legacy','uploading','sealed','purging','purged'))",
		],
	]) {
		if (!db.prepare("SELECT 1 FROM pragma_table_info('source_import_files') WHERE name = ?").get(column))
			db.exec(`ALTER TABLE source_import_files ADD COLUMN ${column} ${definition}`);
	}
	if (!db.prepare("SELECT 1 FROM pragma_table_info('source_import_jobs') WHERE name = 'retry_count'").get())
		db.exec("ALTER TABLE source_import_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
	if (!db.prepare("SELECT 1 FROM pragma_table_info('source_import_jobs') WHERE name = 'cleanup_state'").get())
		db.exec("ALTER TABLE source_import_jobs ADD COLUMN cleanup_state TEXT NOT NULL DEFAULT 'idle'");
	if (!db.prepare("SELECT 1 FROM pragma_table_info('source_import_jobs') WHERE name = 'retry_cursor'").get())
		db.exec("ALTER TABLE source_import_jobs ADD COLUMN retry_cursor TEXT NOT NULL DEFAULT ''");
	if (!db.prepare("SELECT 1 FROM pragma_table_info('source_import_jobs') WHERE name = 'retry_requested'").get())
		db.exec("ALTER TABLE source_import_jobs ADD COLUMN retry_requested INTEGER NOT NULL DEFAULT 0");
	db.exec(`
		CREATE TABLE IF NOT EXISTS source_import_migrations (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending', cursor TEXT NOT NULL DEFAULT '', error TEXT);
		CREATE TABLE IF NOT EXISTS source_import_migration_counts (agent_id TEXT NOT NULL, job_id TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0, duplicate INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,job_id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS source_import_migration_streams (agent_id TEXT NOT NULL, stem TEXT NOT NULL, PRIMARY KEY(agent_id,stem)) WITHOUT ROWID;
		INSERT OR IGNORE INTO source_import_migrations(agent_id) SELECT DISTINCT agent_id FROM source_import_files WHERE storage_state = 'legacy';
		CREATE TABLE IF NOT EXISTS source_import_capacity (id INTEGER PRIMARY KEY CHECK (id = 1), reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0));
		INSERT OR IGNORE INTO source_import_capacity(id) VALUES (1);
		CREATE TRIGGER IF NOT EXISTS source_import_capacity_update AFTER UPDATE OF reserved_bytes ON source_import_files
		BEGIN UPDATE source_import_capacity SET reserved_bytes = reserved_bytes - OLD.reserved_bytes + NEW.reserved_bytes WHERE id = 1; END;
		CREATE TRIGGER IF NOT EXISTS source_import_capacity_delete AFTER DELETE ON source_import_files
		BEGIN UPDATE source_import_capacity SET reserved_bytes = reserved_bytes - OLD.reserved_bytes WHERE id = 1; END;
		CREATE TABLE IF NOT EXISTS source_import_chunks (
			file_id TEXT NOT NULL REFERENCES source_import_files(id),
			agent_id TEXT NOT NULL, generation INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
			checksum TEXT NOT NULL, content BLOB NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
			PRIMARY KEY (agent_id, file_id, generation, byte_offset)
		) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS idx_source_import_files_storage ON source_import_files(agent_id, storage_state, id);
		CREATE INDEX IF NOT EXISTS idx_source_import_cleanup ON source_import_jobs(agent_id,id) WHERE cleanup_state = 'pending';
		CREATE INDEX IF NOT EXISTS idx_source_import_records_file_pending ON source_import_records(agent_id, file_id, status, ordinal);
		CREATE INDEX IF NOT EXISTS idx_source_import_records_agent_cursor ON source_import_records(agent_id,id);
        CREATE INDEX IF NOT EXISTS idx_source_import_records_job_cursor ON source_import_records(job_id,agent_id,status,id);
        CREATE INDEX IF NOT EXISTS idx_source_import_files_agent_cursor ON source_import_files(agent_id,id);
        CREATE INDEX IF NOT EXISTS idx_session_transcripts_export ON session_transcripts(agent_id,created_at,session_key);
        CREATE INDEX IF NOT EXISTS idx_transcript_import_harness ON transcript_import_conversations(agent_id,harness);
	`);
}

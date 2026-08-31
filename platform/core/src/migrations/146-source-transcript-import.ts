import type { MigrationDb } from "./contract";

/** Migration 146: durable, agent-scoped transcript import ledgers. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS source_import_jobs (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind = 'import'), agent_id TEXT NOT NULL,
			schema_id TEXT NOT NULL, adapter_version INTEGER NOT NULL CHECK (adapter_version = 1),
			state TEXT NOT NULL CHECK (state IN ('staging','inventorying','queued','running','paused','completed','completed_with_rejections','cancelled','failed')),
			control_request TEXT CHECK (control_request IN ('pause','resume','retry','cancel') OR control_request IS NULL),
			generation INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
			duplicate INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
			lease_token TEXT, lease_expires_at TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, reconciled_at TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_source_import_jobs_agent_state ON source_import_jobs(agent_id, state);

		CREATE TABLE IF NOT EXISTS source_import_files (
			id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES source_import_jobs(id) ON DELETE CASCADE,
			source_id TEXT NOT NULL, agent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL,
			managed_path TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
			state TEXT NOT NULL CHECK (state IN ('staging','ready','inventorying','completed','failed')),
			record_count INTEGER NOT NULL DEFAULT 0, blank_count INTEGER NOT NULL DEFAULT 0, malformed_count INTEGER NOT NULL DEFAULT 0,
			inventory_version INTEGER NOT NULL DEFAULT 1, checkpoint_ordinal INTEGER NOT NULL DEFAULT 0,
			checkpoint_byte_offset INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(job_id, ordinal)
		);
		CREATE INDEX IF NOT EXISTS idx_source_import_files_job_state ON source_import_files(job_id, state);

		CREATE TABLE IF NOT EXISTS source_import_records (
			id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES source_import_jobs(id) ON DELETE CASCADE,
			file_id TEXT NOT NULL REFERENCES source_import_files(id) ON DELETE CASCADE, source_id TEXT NOT NULL, agent_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL, line_number INTEGER NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
			raw_hash TEXT NOT NULL, external_identity TEXT, conversation_fingerprint TEXT, status TEXT NOT NULL CHECK (status IN ('pending','imported','duplicate','rejected','cancelled')),
			canonical_id TEXT, canonical_key TEXT, rejection_code TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(file_id, ordinal), UNIQUE(file_id, byte_offset)
		);
		CREATE INDEX IF NOT EXISTS idx_source_import_records_job_status ON source_import_records(job_id, status);
		CREATE INDEX IF NOT EXISTS idx_source_import_records_source_status ON source_import_records(agent_id, source_id, status);

		CREATE TABLE IF NOT EXISTS transcript_import_conversations (
			agent_id TEXT NOT NULL, external_identity TEXT NOT NULL, canonical_key TEXT NOT NULL,
			conversation_fingerprint TEXT NOT NULL, canonical_id TEXT NOT NULL, owner_source_id TEXT NOT NULL,
			owner_record_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('committing','committed','removed')),
			content_hash TEXT NOT NULL, harness TEXT NOT NULL, timestamp TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (agent_id, external_identity), UNIQUE(agent_id, canonical_key)
		);
		CREATE INDEX IF NOT EXISTS idx_transcript_import_conversations_source ON transcript_import_conversations(agent_id, owner_source_id);

		CREATE TABLE IF NOT EXISTS source_import_record_attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, job_id TEXT NOT NULL, file_id TEXT NOT NULL,
			record_id TEXT NOT NULL, generation INTEGER NOT NULL, outcome TEXT NOT NULL, error_code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_source_import_attempts_record ON source_import_record_attempts(agent_id, record_id, created_at);
	`);
	for (const column of ["source_id", "source_record_id", "source_meta_json"] as const) {
		const exists = db
			.prepare("SELECT 1 AS found FROM pragma_table_info('session_transcripts') WHERE name = ?")
			.get(column);
		if (exists == null) db.exec(`ALTER TABLE session_transcripts ADD COLUMN ${column} TEXT`);
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_session_transcripts_agent_source ON session_transcripts(agent_id, source_id)",
	);
}

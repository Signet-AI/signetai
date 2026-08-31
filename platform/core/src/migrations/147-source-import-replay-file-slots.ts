import type { MigrationDb } from "./contract";

/** Migration 147: one configured Source may own multiple auditable replay file slots. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE source_import_files_147 (
			id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES source_import_jobs(id) ON DELETE CASCADE,
			source_id TEXT NOT NULL, agent_id TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL,
			managed_path TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
			state TEXT NOT NULL CHECK (state IN ('staging','ready','inventorying','completed','failed')),
			record_count INTEGER NOT NULL DEFAULT 0, blank_count INTEGER NOT NULL DEFAULT 0, malformed_count INTEGER NOT NULL DEFAULT 0,
			inventory_version INTEGER NOT NULL DEFAULT 1, checkpoint_ordinal INTEGER NOT NULL DEFAULT 0,
			checkpoint_byte_offset INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(job_id, ordinal)
		);
		INSERT INTO source_import_files_147 (
			id, job_id, source_id, agent_id, ordinal, name, managed_path, size_bytes, content_hash, state,
			record_count, blank_count, malformed_count, inventory_version, checkpoint_ordinal, checkpoint_byte_offset, created_at, updated_at
		)
		SELECT id, job_id, source_id, agent_id, ordinal, name, managed_path, size_bytes, content_hash, state,
			record_count, blank_count, malformed_count, inventory_version, checkpoint_ordinal, checkpoint_byte_offset, created_at, updated_at
		FROM source_import_files;
		DROP TABLE source_import_files;
		ALTER TABLE source_import_files_147 RENAME TO source_import_files;
		CREATE INDEX idx_source_import_files_job_state ON source_import_files(job_id, state);
	`);
}

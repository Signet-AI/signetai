import type { MigrationDb } from "./contract";

export const artifacts = {
	tables: ["hook_transcript_uploads", "hook_transcript_chunks"],
	indexes: ["idx_hook_transcript_upload_expiry", "idx_hook_transcript_upload_state"],
	columns: [
		"agent_id",
		"principal_id",
		"credential_kind",
		"credential_id",
		"harness",
		"session_key",
		"sha256",
		"upload_offset",
		"upload_size",
		"storage_state",
		"result_json",
		"updated_at",
	].map((column) => ({ table: "hook_transcript_uploads", column })),
};

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS source_import_capacity (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
		);
		INSERT OR IGNORE INTO source_import_capacity(id) VALUES (1);
		CREATE TABLE IF NOT EXISTS hook_transcript_uploads (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			credential_kind TEXT NOT NULL,
			credential_id TEXT NOT NULL,
			harness TEXT NOT NULL,
			session_key TEXT NOT NULL,
			sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
			upload_generation INTEGER NOT NULL DEFAULT 0 CHECK (upload_generation >= 0),
			upload_offset INTEGER NOT NULL DEFAULT 0 CHECK (upload_offset >= 0),
			upload_size INTEGER CHECK (upload_size >= 0),
			upload_digest TEXT NOT NULL DEFAULT '',
			content_hash TEXT,
			size_bytes INTEGER NOT NULL DEFAULT 0,
			reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
			storage_state TEXT NOT NULL DEFAULT 'uploading' CHECK (storage_state IN ('uploading','sealed','consumed','purging','purged')),
			result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(agent_id,id),
			UNIQUE(principal_id,harness,session_key,sha256),
			CHECK (upload_size IS NULL OR upload_offset <= upload_size)
		);
		CREATE TABLE IF NOT EXISTS hook_transcript_chunks (
			agent_id TEXT NOT NULL,
			file_id TEXT NOT NULL,
			generation INTEGER NOT NULL,
			byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
			checksum TEXT NOT NULL,
			content BLOB NOT NULL CHECK (length(content) BETWEEN 1 AND 65536),
			PRIMARY KEY(agent_id,file_id,generation,byte_offset),
			FOREIGN KEY(agent_id,file_id) REFERENCES hook_transcript_uploads(agent_id,id) ON DELETE CASCADE
		) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS idx_hook_transcript_upload_expiry ON hook_transcript_uploads(updated_at,id);
		CREATE INDEX IF NOT EXISTS idx_hook_transcript_upload_state ON hook_transcript_uploads(storage_state,principal_id,id);
		CREATE TRIGGER IF NOT EXISTS hook_transcript_capacity_update AFTER UPDATE OF reserved_bytes ON hook_transcript_uploads
		BEGIN UPDATE source_import_capacity SET reserved_bytes = reserved_bytes - OLD.reserved_bytes + NEW.reserved_bytes WHERE id = 1; END;
		CREATE TRIGGER IF NOT EXISTS hook_transcript_capacity_delete AFTER DELETE ON hook_transcript_uploads
		BEGIN UPDATE source_import_capacity SET reserved_bytes = reserved_bytes - OLD.reserved_bytes WHERE id = 1; END;
	`);
}

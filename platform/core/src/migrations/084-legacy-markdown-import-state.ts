import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS legacy_markdown_imports (
			path TEXT PRIMARY KEY,
			mtime_ms INTEGER NOT NULL,
			ctime_ms INTEGER NOT NULL,
			size INTEGER NOT NULL,
			content_hash TEXT NOT NULL,
			importer_version INTEGER NOT NULL,
			chunk_count INTEGER NOT NULL DEFAULT 0,
			last_imported_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'imported',
			error TEXT
		);

		CREATE TABLE IF NOT EXISTS legacy_markdown_chunks (
			file_path TEXT NOT NULL,
			chunk_hash TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			memory_id TEXT,
			source_id TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (file_path, chunk_hash)
		);

		CREATE INDEX IF NOT EXISTS idx_legacy_markdown_chunks_memory_id
			ON legacy_markdown_chunks(memory_id);
	`);
}

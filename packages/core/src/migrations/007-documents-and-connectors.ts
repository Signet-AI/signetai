import type { MigrationDb } from "./index";

function hasColumn(
	db: MigrationDb,
	table: string,
	column: string,
): boolean {
	const rows = db
		.prepare(`PRAGMA table_info(${table})`)
		.all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((r) => r.name === column);
}

export function up(db: MigrationDb): void {
	// -- documents table --
	db.exec(`
		CREATE TABLE IF NOT EXISTS documents (
			id TEXT PRIMARY KEY,
			source_url TEXT,
			source_type TEXT NOT NULL,
			content_type TEXT,
			content_hash TEXT,
			title TEXT,
			raw_content TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			error TEXT,
			connector_id TEXT,
			chunk_count INTEGER NOT NULL DEFAULT 0,
			memory_count INTEGER NOT NULL DEFAULT 0,
			metadata_json TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_documents_status
		 ON documents(status)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_documents_source_url
		 ON documents(source_url)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_documents_connector_id
		 ON documents(connector_id)`,
	);
	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_documents_content_hash
		 ON documents(content_hash)`,
	);

	// -- document_memories link table --
	db.exec(`
		CREATE TABLE IF NOT EXISTS document_memories (
			document_id TEXT NOT NULL REFERENCES documents(id),
			memory_id TEXT NOT NULL REFERENCES memories(id),
			chunk_index INTEGER,
			PRIMARY KEY (document_id, memory_id)
		)
	`);

	// -- connectors table --
	db.exec(`
		CREATE TABLE IF NOT EXISTS connectors (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			display_name TEXT,
			config_json TEXT NOT NULL,
			cursor_json TEXT,
			status TEXT NOT NULL DEFAULT 'idle',
			last_sync_at TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(
		`CREATE INDEX IF NOT EXISTS idx_connectors_provider
		 ON connectors(provider)`,
	);

	// -- add document_id to memory_jobs for document ingest jobs --
	if (!hasColumn(db, "memory_jobs", "document_id")) {
		db.exec(
			"ALTER TABLE memory_jobs ADD COLUMN document_id TEXT",
		);
	}
}

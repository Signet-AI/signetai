import type { MigrationDb } from "./index";

/**
 * The inactive half of a rolling embedding migration. sqlite-vec's matching
 * virtual table is created by the daemon only when its extension is loaded;
 * keeping the durable BLOB store here makes migration safe everywhere else.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embeddings_staging (
			id TEXT PRIMARY KEY,
			content_hash TEXT NOT NULL UNIQUE,
			vector BLOB NOT NULL,
			dimensions INTEGER NOT NULL,
			source_type TEXT NOT NULL,
			source_id TEXT NOT NULL,
			chunk_text TEXT NOT NULL,
			created_at TEXT NOT NULL,
			agent_id TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_embeddings_staging_source
			ON embeddings_staging(source_type, source_id);
		CREATE INDEX IF NOT EXISTS idx_embeddings_staging_agent_source
			ON embeddings_staging(agent_id, source_type, source_id);
	`);
}

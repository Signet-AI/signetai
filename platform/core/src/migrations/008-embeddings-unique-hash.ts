import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'").all();
	if (tables.length === 0) return;
	db.exec(`
		DELETE FROM embeddings
		WHERE rowid NOT IN (
			SELECT MIN(rowid) FROM embeddings
			GROUP BY content_hash
		)
	`);
	db.exec(`DROP INDEX IF EXISTS idx_embeddings_hash`);
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_content_hash_unique
			ON embeddings(content_hash)
	`);
}

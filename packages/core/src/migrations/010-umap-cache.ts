import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS umap_cache (
			id INTEGER PRIMARY KEY,
			dimensions INTEGER NOT NULL,
			embedding_count INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);
}

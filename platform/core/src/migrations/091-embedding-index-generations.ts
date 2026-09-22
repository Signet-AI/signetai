import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS embedding_index_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			active_profile_json TEXT NOT NULL,
			staging_profile_json TEXT,
			state TEXT NOT NULL CHECK (state IN ('ready', 'building', 'failed')) DEFAULT 'ready',
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
}

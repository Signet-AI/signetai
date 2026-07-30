import type { MigrationDb } from "./index";

/**
 * Persist active/staging embedding generations separately from mutable config.
 *
 * The daemon creates the physical staging tables only after it can verify the
 * vector extension is available. Keeping this migration extension-free makes
 * upgrades safe on installs without sqlite-vec.
 */
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

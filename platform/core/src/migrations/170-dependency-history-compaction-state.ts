import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS dependency_history_compaction_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			cursor_rowid INTEGER NOT NULL DEFAULT 0 CHECK (cursor_rowid >= 0),
			pruned_rows INTEGER NOT NULL DEFAULT 0 CHECK (pruned_rows >= 0),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		INSERT OR IGNORE INTO dependency_history_compaction_state (id) VALUES (1);
	`);
}

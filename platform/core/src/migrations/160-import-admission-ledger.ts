import type { MigrationDb } from "./contract";

/** Durable admission ledger for dashboard uploads and the workspace inbox. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS import_admission_ledger (
			key TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			file_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending','processing','imported','duplicate','failed','quarantined')),
			original_path TEXT NOT NULL,
			sha256 TEXT NOT NULL,
			size_bytes INTEGER NOT NULL,
			error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_import_admission_status ON import_admission_ledger(agent_id, status, updated_at);
		CREATE TABLE IF NOT EXISTS import_admission_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			admission_key TEXT NOT NULL,
			event TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_import_admission_events_key ON import_admission_events(admission_key, id);
	`);
}

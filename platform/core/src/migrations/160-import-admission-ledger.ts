import type { MigrationDb } from "./contract";

/** Durable admission ledger for dashboard uploads and the workspace inbox. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS import_admission_ledger (
			key TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL DEFAULT '',
			file_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending','processing','imported','duplicate','failed','quarantined','original_unavailable')),
			original_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
			request_fingerprint TEXT NOT NULL DEFAULT '', source_id TEXT, lease_token TEXT,
			lease_expires_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS import_admission_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			admission_key TEXT NOT NULL,
			agent_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '',
			event TEXT NOT NULL, created_at TEXT NOT NULL
		);
	`);
	for (const column of [
		"workspace_id TEXT NOT NULL DEFAULT ''",
		"request_fingerprint TEXT NOT NULL DEFAULT ''",
		"source_id TEXT",
		"lease_token TEXT",
		"lease_expires_at TEXT",
		"attempt_count INTEGER NOT NULL DEFAULT 0",
	]) {
		try {
			db.exec(`ALTER TABLE import_admission_ledger ADD COLUMN ${column}`);
		} catch {
			/* already present */
		}
	}
	for (const column of ["agent_id TEXT NOT NULL DEFAULT ''", "workspace_id TEXT NOT NULL DEFAULT ''"]) {
		try {
			db.exec(`ALTER TABLE import_admission_events ADD COLUMN ${column}`);
		} catch {
			/* already present */
		}
	}
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS uq_import_admission_scope_key ON import_admission_ledger(key, agent_id, workspace_id);
		CREATE INDEX IF NOT EXISTS idx_import_admission_status ON import_admission_ledger(agent_id, workspace_id, status, updated_at);
		CREATE INDEX IF NOT EXISTS idx_import_admission_events_key ON import_admission_events(admission_key, agent_id, workspace_id, id);
	`);
}

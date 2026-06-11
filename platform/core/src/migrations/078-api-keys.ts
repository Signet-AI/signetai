import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			prefix TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'agent',
			scope_json TEXT NOT NULL DEFAULT '{}',
			permissions_json TEXT NOT NULL DEFAULT '[]',
			connector TEXT,
			harness TEXT,
			agent_id TEXT,
			allowed_projects_json TEXT,
			created_at TEXT NOT NULL,
			last_used_at TEXT,
			revoked_at TEXT,
			expires_at TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
			ON api_keys(prefix);
		CREATE INDEX IF NOT EXISTS idx_api_keys_active
			ON api_keys(revoked_at, expires_at);
		CREATE INDEX IF NOT EXISTS idx_api_keys_connector
			ON api_keys(connector, harness);
	`);
}

import type { MigrationArtifacts, MigrationDb } from "./contract";

const addedColumns = {
	agents: {
		kind: "TEXT NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy','personal','team','organization'))",
		owner_user_id: "TEXT",
		owner_group_id: "TEXT",
		archived_at: "TEXT",
	},
	api_keys: {
		user_id: "TEXT",
		device_id: "TEXT",
		session_id: "TEXT",
		kind: "TEXT NOT NULL DEFAULT 'legacy' CHECK (kind IN ('legacy','connector','personal','shared'))",
		legacy: "INTEGER NOT NULL DEFAULT 0",
	},
	memories: { author_user_id: "TEXT" },
	session_transcripts: { speaker_user_id: "TEXT" },
	memory_artifacts: { author_user_id: "TEXT" },
	documents: { author_user_id: "TEXT" },
	ontology_proposals: { author_user_id: "TEXT" },
	entities: { person_user_id: "TEXT" },
};

export const artifacts: MigrationArtifacts = {
	tables: [
		"organization",
		"users",
		"groups",
		"group_members",
		"devices",
		"auth_sessions",
		"device_authorizations",
		"user_invites",
		"audit_events",
		"org_jobs",
	],
	columns: Object.entries(addedColumns).flatMap(([table, columns]) =>
		Object.keys(columns).map((column) => ({ table, column })),
	),
	indexes: ["idx_entities_person_user", "idx_audit_at", "idx_audit_actor", "idx_audit_action", "idx_audit_target"],
};

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS organization (
			id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT, claimed_at TEXT, claimed_by TEXT,
			setup_token_hash TEXT, agent_model TEXT NOT NULL DEFAULT 'personal' CHECK (agent_model IN ('personal','single')),
			personal_agents_self_service INTEGER NOT NULL DEFAULT 1, password_login INTEGER NOT NULL DEFAULT 1,
			require_sso INTEGER NOT NULL DEFAULT 0, session_ttl_seconds INTEGER NOT NULL DEFAULT 604800,
			refresh_ttl_seconds INTEGER NOT NULL DEFAULT 2592000, access_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
			connector_key_ttl_seconds INTEGER NOT NULL DEFAULT 2592000, legacy_key_deadline TEXT,
			oidc_json TEXT, audit_retention_days INTEGER NOT NULL DEFAULT 365, public_url TEXT, updated_at TEXT
		);
		INSERT OR IGNORE INTO organization (id) VALUES (1);
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT UNIQUE, display_name TEXT NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('admin','operator','member','readonly')), compliance INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
			password_hash TEXT, oidc_issuer TEXT, oidc_subject TEXT, personal_agent_id TEXT, default_read_agent_id TEXT,
			created_at TEXT, updated_at TEXT, deactivated_at TEXT, last_active_at TEXT, UNIQUE (oidc_issuer, oidc_subject)
		);
		CREATE TABLE IF NOT EXISTS groups (
			id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT,
			managed_by TEXT NOT NULL DEFAULT 'signet' CHECK (managed_by IN ('signet','idp')), idp_group TEXT, created_at TEXT, updated_at TEXT
		);
		CREATE TABLE IF NOT EXISTS group_members (
			group_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','member')),
			managed_by TEXT NOT NULL DEFAULT 'signet', created_at TEXT, PRIMARY KEY (group_id,user_id)
		);
		CREATE TABLE IF NOT EXISTS devices (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT, created_at TEXT, last_seen_at TEXT, revoked_at TEXT
		);
		CREATE TABLE IF NOT EXISTS auth_sessions (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('browser','cli','desktop')),
			device_id TEXT, token_hash TEXT NOT NULL, access_expires_at TEXT NOT NULL, refresh_hash TEXT, refresh_expires_at TEXT,
			csrf_hash TEXT, created_at TEXT, last_used_at TEXT, revoked_at TEXT, revoked_reason TEXT, user_agent TEXT, ip TEXT
		);
		CREATE TABLE IF NOT EXISTS device_authorizations (
			id TEXT PRIMARY KEY, device_code_hash TEXT UNIQUE, user_code TEXT UNIQUE,
			client TEXT CHECK (client IN ('cli','desktop')), device_name TEXT, platform TEXT,
			status TEXT CHECK (status IN ('pending','approved','denied','consumed','expired')), user_id TEXT, session_id TEXT,
			created_at TEXT, expires_at TEXT, approved_at TEXT, last_polled_at TEXT
		);
		CREATE TABLE IF NOT EXISTS user_invites (
			id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, email TEXT, role TEXT NOT NULL,
			group_ids_json TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT, expires_at TEXT, used_at TEXT, used_by TEXT
		);
		CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_user_id TEXT, actor_credential TEXT, action TEXT NOT NULL,
			target_kind TEXT, target_id TEXT, agent_id TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed')), detail_json TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at);
		CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_user_id, at);
		CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events (action, at);
		CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events (target_kind,target_id);
		CREATE TABLE IF NOT EXISTS org_jobs (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','running','complete','failed','cancelled')),
			params_json TEXT, progress_json TEXT, error TEXT, created_by TEXT, created_at TEXT, started_at TEXT, finished_at TEXT
		);
	`);
	for (const [table, columns] of Object.entries(addedColumns)) {
		const existing = new Set(
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.map((row) => row.name),
		);
		for (const [column, definition] of Object.entries(columns)) {
			if (existing.has(column)) continue;
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
			if (table === "api_keys" && column === "legacy") db.exec("UPDATE api_keys SET legacy = 1");
		}
	}
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_person_user ON entities (agent_id, person_user_id) WHERE person_user_id IS NOT NULL",
	);
}

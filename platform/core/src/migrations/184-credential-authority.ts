import type { MigrationDb } from "./contract";

export const artifacts = {
	columns: [
		{ table: "auth_sessions", column: "permission_ceiling_json" },
		{ table: "api_keys", column: "parent_key_id" },
	],
	indexes: ["idx_api_keys_parent"],
};
export function up(db: MigrationDb): void {
	const columns = new Set(
		db
			.prepare("PRAGMA table_info(auth_sessions)")
			.all()
			.map((row) => row.name),
	);
	if (!columns.has("permission_ceiling_json"))
		db.exec(
			"ALTER TABLE auth_sessions ADD COLUMN permission_ceiling_json TEXT CHECK (permission_ceiling_json IS NULL OR json_valid(permission_ceiling_json))",
		);
	const keyColumns = new Set(
		db
			.prepare("PRAGMA table_info(api_keys)")
			.all()
			.map((row) => row.name),
	);
	if (!keyColumns.has("parent_key_id"))
		db.exec("ALTER TABLE api_keys ADD COLUMN parent_key_id TEXT REFERENCES api_keys(id)");
	db.exec("CREATE INDEX _legacy_key_creation ON audit_events(target_id,action,at)");
	try {
		db.exec(`
		CREATE INDEX IF NOT EXISTS idx_api_keys_parent ON api_keys(parent_key_id) WHERE parent_key_id IS NOT NULL;
		UPDATE api_keys SET parent_key_id=(
			SELECT substr(a.actor_credential,9) FROM audit_events a JOIN api_keys p ON p.id=substr(a.actor_credential,9)
			WHERE a.action='key.created' AND a.target_id=api_keys.id AND a.actor_credential LIKE 'api_key:%' AND p.user_id=api_keys.user_id
			ORDER BY a.at LIMIT 1
		) WHERE parent_key_id IS NULL;
		CREATE TRIGGER IF NOT EXISTS api_keys_revoke_descendants AFTER UPDATE OF revoked_at ON api_keys
		WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL
		BEGIN
			UPDATE api_keys SET revoked_at=NEW.revoked_at WHERE revoked_at IS NULL AND id IN (
				WITH RECURSIVE descendants(id) AS (SELECT id FROM api_keys WHERE parent_key_id=NEW.id UNION SELECT k.id FROM api_keys k JOIN descendants d ON k.parent_key_id=d.id)
				SELECT id FROM descendants
			);
		END;
		WITH RECURSIVE ancestry(child,id,parent_key_id,expires_at,revoked_at,depth) AS (
			SELECT id,id,parent_key_id,expires_at,revoked_at,0 FROM api_keys
			UNION ALL SELECT a.child,p.id,p.parent_key_id,p.expires_at,p.revoked_at,a.depth+1 FROM ancestry a JOIN api_keys p ON p.id=a.parent_key_id WHERE a.depth<64
		)
		UPDATE api_keys SET expires_at=(SELECT min(a.expires_at) FROM ancestry a WHERE a.child=api_keys.id),
			revoked_at=COALESCE(revoked_at,(SELECT min(a.revoked_at) FROM ancestry a WHERE a.child=api_keys.id))
		WHERE parent_key_id IS NOT NULL;
	`);
	} finally {
		db.exec("DROP INDEX _legacy_key_creation");
	}
}

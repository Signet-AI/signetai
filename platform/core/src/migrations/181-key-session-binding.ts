import type { MigrationDb } from "./contract";

export const artifacts = {
	columns: ["source_key_id", "source_key_ceiling_json"].map((column) => ({ table: "auth_sessions", column })),
	indexes: ["idx_auth_sessions_source_key"],
};

export function up(db: MigrationDb): void {
	const columns = new Set(
		db
			.prepare("PRAGMA table_info(auth_sessions)")
			.all()
			.map((row) => row.name),
	);
	if (!columns.has("source_key_id"))
		db.exec("ALTER TABLE auth_sessions ADD COLUMN source_key_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE");
	if (!columns.has("source_key_ceiling_json"))
		db.exec(
			"ALTER TABLE auth_sessions ADD COLUMN source_key_ceiling_json TEXT CHECK ((source_key_id IS NULL AND source_key_ceiling_json IS NULL) OR (source_key_id IS NOT NULL AND source_key_ceiling_json IS NOT NULL AND json_valid(source_key_ceiling_json)))",
		);
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_auth_sessions_source_key ON auth_sessions(source_key_id) WHERE source_key_id IS NOT NULL",
	);
}

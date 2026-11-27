import type { MigrationDb } from "./contract";

export const artifacts = {
	columns: [{ table: "auth_sessions", column: "permission_ceiling_json" }],
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
}

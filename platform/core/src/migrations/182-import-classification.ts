import type { MigrationDb } from "./contract";

export const artifacts = {
	columns: [{ table: "source_import_jobs", column: "labels_json" }],
	tables: ["document_import_jobs"],
	indexes: ["idx_document_import_jobs_source"],
};

export function up(db: MigrationDb): void {
	const columns = new Set(
		db
			.prepare("PRAGMA table_info(source_import_jobs)")
			.all()
			.map((row) => row.name),
	);
	if (!columns.has("labels_json"))
		db.exec(
			"ALTER TABLE source_import_jobs ADD COLUMN labels_json TEXT CHECK(labels_json IS NULL OR (json_valid(labels_json) AND json_type(labels_json)='array'))",
		);
	db.exec(`CREATE TABLE IF NOT EXISTS document_import_jobs (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		author_user_id TEXT,
		author_credential TEXT NOT NULL,
		labels_json TEXT NOT NULL CHECK(json_valid(labels_json) AND json_type(labels_json)='array'),
		created_at TEXT NOT NULL
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_document_import_jobs_source ON document_import_jobs(source_id,agent_id);`);
}

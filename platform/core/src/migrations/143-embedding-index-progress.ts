import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(embedding_index_state)").all() as Array<{ name?: string }>)
			.map((row) => row.name)
			.filter((name): name is string => typeof name === "string"),
	);
	const additions: Array<[string, string]> = [
		["migration_phase", "TEXT"],
		["progress_staged", "INTEGER NOT NULL DEFAULT 0"],
		["progress_total", "INTEGER NOT NULL DEFAULT 0"],
		["projection_cursor_last_id", "TEXT"],
		["projection_cursor_slot", "TEXT"],
		["no_progress_ticks", "INTEGER NOT NULL DEFAULT 0"],
		["provider_endpoint", "TEXT"],
	];
	for (const [name, definition] of additions) {
		if (!columns.has(name)) db.exec(`ALTER TABLE embedding_index_state ADD COLUMN ${name} ${definition}`);
	}
	db.exec(`
		UPDATE embedding_index_state
		SET provider_endpoint = COALESCE(
			provider_endpoint,
			json_extract(active_profile_json, '$.baseUrl')
		)
		WHERE id = 1
	`);
	const hasEmbeddings =
		(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'").get() as
			| { present?: number }
			| null
			| undefined) != null;
	const hasStaging =
		(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'embeddings_staging'").get() as
			| { present?: number }
			| null
			| undefined) != null;
	if (hasEmbeddings && hasStaging) {
		db.exec(`
			UPDATE embedding_index_state
			SET migration_phase = COALESCE(migration_phase, CASE WHEN state = 'building' THEN 'staging' END),
				progress_staged = CASE WHEN state = 'building' THEN (SELECT COUNT(*) FROM embeddings_staging) ELSE progress_staged END,
				progress_total = CASE WHEN state = 'building' THEN (SELECT COUNT(*) FROM embeddings) ELSE progress_total END
			WHERE state = 'building'
		`);
	}
}

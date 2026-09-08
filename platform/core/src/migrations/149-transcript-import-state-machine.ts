import type { MigrationDb } from "./contract";

/** Migration 149: explicit import controls, retry timing, and file failures. */
export function up(db: MigrationDb): void {
	const addColumn = (table: string, column: string, definition: string): void => {
		const statement = db.prepare("SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?");
		let exists: Record<string, unknown> | undefined;
		try {
			exists = statement.get(table, column);
		} finally {
			statement.finalize?.();
		}
		if (exists == null) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	};
	addColumn(
		"source_import_jobs",
		"duplicate_mode",
		"TEXT NOT NULL DEFAULT 'skip' CHECK (duplicate_mode IN ('skip','replace','reimport'))",
	);
	addColumn("source_import_jobs", "next_attempt_at", "TEXT");
	addColumn("source_import_files", "error", "TEXT");
}

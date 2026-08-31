import type { MigrationDb } from "./contract";

/** Migration 148: retain source identity on append-only import attempt tombstones. */
export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(source_import_record_attempts)").all() as Array<{ name?: unknown }>;
	if (!columns.some((column) => column.name === "source_id")) {
		db.exec("ALTER TABLE source_import_record_attempts ADD COLUMN source_id TEXT");
	}
}

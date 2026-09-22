import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>).some(
		(row) => row.name === column,
	);
}

const TOKEN_COLUMNS: ReadonlyArray<[string, string]> = [
	["tokens_input", "INTEGER"],
	["tokens_output", "INTEGER"],
	["tokens_cache_read", "INTEGER"],
	["tokens_cache_write", "INTEGER"],
	["tokens_cost", "REAL"],
];
export function up(db: MigrationDb): void {
	for (const [column, type] of TOKEN_COLUMNS) {
		if (!hasColumn(db, "dreaming_passes", column)) {
			db.exec(`ALTER TABLE dreaming_passes ADD COLUMN ${column} ${type};`);
		}
	}
}

import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return rows.some((row) => row.name === column);
}

const COLUMNS = ["first_remember_at", "first_recall_at"] as const;

export function up(db: MigrationDb): void {
	for (const column of COLUMNS) {
		if (!hasColumn(db, "telemetry_install", column)) {
			db.exec(`ALTER TABLE telemetry_install ADD COLUMN ${column} TEXT`);
		}
	}
}

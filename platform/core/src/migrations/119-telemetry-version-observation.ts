import type { MigrationDb } from "./contract";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}
export function up(db: MigrationDb): void {
	if (!hasColumn(db, "telemetry_install", "last_seen_version")) {
		db.exec("ALTER TABLE telemetry_install ADD COLUMN last_seen_version TEXT");
	}
}

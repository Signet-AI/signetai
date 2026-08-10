import type { MigrationDb } from "./index";

function hasColumn(db: MigrationDb, table: string, column: string): boolean {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}

/**
 * Migration 119: retain the last daemon version observed for an install.
 *
 * This is deliberately a nullable operational value. It lets the daemon
 * report a version transition on the next start without treating a manual
 * package/source change as an auto-upgrade. No path, package URL, or owner
 * information is persisted.
 */
export function up(db: MigrationDb): void {
	if (!hasColumn(db, "telemetry_install", "last_seen_version")) {
		db.exec("ALTER TABLE telemetry_install ADD COLUMN last_seen_version TEXT");
	}
}

import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS telemetry_install (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL
		);
	`);
}

import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(dreaming_state)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "last_failure_at")) {
		db.exec("ALTER TABLE dreaming_state ADD COLUMN last_failure_at TEXT");
	}
	db.exec(
		"UPDATE dreaming_state SET last_failure_at = updated_at WHERE consecutive_failures > 0 AND last_failure_at IS NULL",
	);
}

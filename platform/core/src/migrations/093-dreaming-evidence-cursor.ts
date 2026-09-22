import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(dreaming_state)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "evidence_cursor")) {
		db.exec("ALTER TABLE dreaming_state ADD COLUMN evidence_cursor TEXT");
	}
}

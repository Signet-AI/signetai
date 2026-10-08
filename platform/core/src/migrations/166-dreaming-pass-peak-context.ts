import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	const columns = db.prepare("PRAGMA table_info(dreaming_passes)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "tokens_peak_context")) {
		db.exec("ALTER TABLE dreaming_passes ADD COLUMN tokens_peak_context INTEGER");
	}
}

import type { MigrationDb } from "./contract";

const COLUMNS = ["occurred_start", "occurred_end", "valid_from", "valid_until", "time_precision"] as const;

export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(entity_attributes)").all() as Array<{ name: string }>;
	for (const column of COLUMNS) {
		if (!cols.some((col) => col.name === column)) {
			db.exec(`ALTER TABLE entity_attributes ADD COLUMN ${column} TEXT`);
		}
	}
}

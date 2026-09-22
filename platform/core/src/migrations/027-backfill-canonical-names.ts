import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		UPDATE entities
		SET canonical_name = REPLACE(REPLACE(REPLACE(
			LOWER(TRIM(name)),
			'  ', ' '), '  ', ' '), '  ', ' ')
		WHERE canonical_name IS NULL
	`);
}

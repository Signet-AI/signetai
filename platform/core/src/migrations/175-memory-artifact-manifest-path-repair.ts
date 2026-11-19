import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	if (
		!db
			.prepare("PRAGMA table_info(memory_artifacts)")
			.all()
			.some((row) => row.name === "manifest_path")
	)
		return;
	db.exec(`
		UPDATE memory_artifacts
		SET manifest_path = NULL
		WHERE manifest_path IS NOT NULL
		  AND manifest_path NOT LIKE '%--manifest.md'
	`);
}

import type { MigrationDb } from "./index";

/** Pass-level audit manifest for content Dreaming MEMORY.md curation. */
export function up(db: MigrationDb): void {
	const columns = [
		["head_revision", "INTEGER"],
		["head_hash", "TEXT"],
		["head_added", "INTEGER NOT NULL DEFAULT 0"],
		["head_updated", "INTEGER NOT NULL DEFAULT 0"],
		["head_removed", "INTEGER NOT NULL DEFAULT 0"],
		["head_deferred", "INTEGER NOT NULL DEFAULT 0"],
		["head_no_op", "INTEGER NOT NULL DEFAULT 0"],
	] as const;
	const existing = new Set(
		(db.prepare("PRAGMA table_info(dreaming_passes)").all() as Array<{ name: string }>).map((row) => row.name),
	);
	for (const [name, type] of columns)
		if (!existing.has(name)) db.exec(`ALTER TABLE dreaming_passes ADD COLUMN ${name} ${type}`);
}

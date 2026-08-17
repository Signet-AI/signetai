import type { MigrationDb } from "./index";

/** Pass-level audit manifest for content Dreaming MEMORY.md curation. */
export function up(db: MigrationDb): void {
	const cols = new Set(
		(db.prepare("PRAGMA table_info(dreaming_passes)").all() as Array<{ name: string }>).map((r) => r.name),
	);
	for (const [name, type] of [
		["head_revision", "INTEGER"],
		["head_hash", "TEXT"],
		["head_added", "INTEGER NOT NULL DEFAULT 0"],
		["head_updated", "INTEGER NOT NULL DEFAULT 0"],
		["head_removed", "INTEGER NOT NULL DEFAULT 0"],
		["head_deferred", "INTEGER NOT NULL DEFAULT 0"],
		["head_no_op", "INTEGER NOT NULL DEFAULT 0"],
	] as const)
		if (!cols.has(name)) db.exec(`ALTER TABLE dreaming_passes ADD COLUMN ${name} ${type}`);
}

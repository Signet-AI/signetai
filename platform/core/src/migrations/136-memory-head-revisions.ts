import type { MigrationDb } from "./index";

/** Adds the audited entry-level contract to the lineage revision table. */
export function up(db: MigrationDb): void {
	const cols = new Set(
		(db.prepare("PRAGMA table_info(memory_head_revisions)").all() as Array<{ name: string }>).map((r) => r.name),
	);
	for (const [name, type] of [
		["entry_id", "TEXT"],
		["entry_text", "TEXT"],
		["operation", "TEXT"],
		["source_refs_json", "TEXT"],
		["supporting_quotes_json", "TEXT"],
	] as const) {
		if (!cols.has(name)) db.exec(`ALTER TABLE memory_head_revisions ADD COLUMN ${name} ${type}`);
	}
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_head_revisions_entry ON memory_head_revisions(agent_id, revision, entry_id)",
	);
}

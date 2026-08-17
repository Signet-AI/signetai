import type { MigrationDb } from "./index";

/** Migration 133: immutable, scoped Dreaming-curated MEMORY.md revisions. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_head_revisions (
			id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			content TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			rendered_token_count INTEGER NOT NULL,
			pass_id TEXT NOT NULL,
			base_revision INTEGER NOT NULL,
			base_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(agent_id, revision)
		);
		CREATE INDEX IF NOT EXISTS idx_memory_head_revisions_agent
			ON memory_head_revisions(agent_id, revision DESC);
		CREATE TABLE IF NOT EXISTS memory_head_entries (
			entry_id TEXT PRIMARY KEY,
			agent_id TEXT NOT NULL,
			canonical_text TEXT NOT NULL,
			entry_hash TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active','removed','superseded')),
			first_revision INTEGER NOT NULL,
			last_revision INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_memory_head_entries_agent
			ON memory_head_entries(agent_id, entry_id, last_revision DESC);
		CREATE TABLE IF NOT EXISTS memory_head_revision_entries (
			agent_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			entry_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			operation TEXT NOT NULL CHECK(operation IN ('add','update','remove','retain')),
			provenance_json TEXT NOT NULL,
			PRIMARY KEY(agent_id, revision, entry_id),
			UNIQUE(agent_id, revision, ordinal)
		);
		CREATE INDEX IF NOT EXISTS idx_memory_head_revision_entries_entry
			ON memory_head_revision_entries(agent_id, entry_id, revision DESC);
	`);
	const columns = db.prepare("PRAGMA table_info(memory_md_heads)").all();
	const names = new Set(columns.map((column) => String(column.name)));
	if (!names.has("revision_id")) db.exec("ALTER TABLE memory_md_heads ADD COLUMN revision_id TEXT");
	if (!names.has("pass_id")) db.exec("ALTER TABLE memory_md_heads ADD COLUMN pass_id TEXT");
	if (!names.has("format_version"))
		db.exec("ALTER TABLE memory_md_heads ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1");
}

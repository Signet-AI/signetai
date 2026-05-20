import type { MigrationDb } from "./index";

function ensureMemoriesScopeColumns(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(memories)").all() as ReadonlyArray<Record<string, unknown>>;
	const names = new Set(cols.map((col) => col.name).filter((name): name is string => typeof name === "string"));
	if (!names.has("agent_id")) db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT 'default'");
	if (!names.has("visibility")) db.exec("ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'global'");
	if (!names.has("scope")) db.exec("ALTER TABLE memories ADD COLUMN scope TEXT");
	if (!names.has("idempotency_key")) db.exec("ALTER TABLE memories ADD COLUMN idempotency_key TEXT");
	if (!names.has("runtime_path")) db.exec("ALTER TABLE memories ADD COLUMN runtime_path TEXT");
}

/**
 * Migration 072: Agent-aware idempotency key dedupe.
 *
 * Import keys are stable within a memory owner and visibility domain. The old
 * global index could make retries collide across agents or scopes.
 */
export function up(db: MigrationDb): void {
	ensureMemoriesScopeColumns(db);

	db.exec("DROP INDEX IF EXISTS idx_memories_idempotency_key");
	db.exec(`
		CREATE UNIQUE INDEX idx_memories_idempotency_key
		ON memories(
			idempotency_key,
			COALESCE(NULLIF(agent_id, ''), 'default'),
			COALESCE(visibility, 'global'),
			COALESCE(scope, '__NULL__')
		)
		WHERE idempotency_key IS NOT NULL AND is_deleted = 0
	`);
}

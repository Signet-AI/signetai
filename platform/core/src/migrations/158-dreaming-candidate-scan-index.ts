import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memories_agent_kind
		ON memories(agent_id, memory_kind);
	`);
}

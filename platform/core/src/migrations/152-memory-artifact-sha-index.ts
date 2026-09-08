import type { MigrationDb } from "./contract";

/** Migration 152: covering index for the episodic-source dedup subquery on memory_artifacts. */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_agent_sha
			ON memory_artifacts(agent_id, source_sha256, source_id, is_deleted, captured_at DESC, source_path)
	`);
}

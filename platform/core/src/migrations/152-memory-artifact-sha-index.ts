import type { MigrationDb } from "./contract";

/** Migration 152: covering index for the episodic-source dedup subquery on memory_artifacts. */
export function up(db: MigrationDb): void {
	db.exec(`
		DROP INDEX IF EXISTS idx_memory_artifacts_agent_sha;
		CREATE INDEX idx_memory_artifacts_agent_sha ON memory_artifacts(agent_id, source_sha256, COALESCE(source_id, ''), COALESCE(is_deleted, 0), captured_at DESC, source_path)
	`);
}

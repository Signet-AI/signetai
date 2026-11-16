import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_artifacts_native_paths
			ON memory_artifacts(agent_id, harness, source_kind, source_id, source_path, is_deleted)
			WHERE is_deleted = 0 AND harness IS NOT NULL
	`);
}

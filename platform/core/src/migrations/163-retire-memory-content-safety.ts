import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec(`
		DROP TRIGGER IF EXISTS memory_content_safety_head_freshness_ai;
		DROP TRIGGER IF EXISTS memory_content_safety_head_freshness_au;
		DROP INDEX IF EXISTS idx_memory_content_safety_status;
		DROP INDEX IF EXISTS idx_memory_content_safety_eligibility;
		DROP TABLE IF EXISTS memory_content_safety;
	`);
}

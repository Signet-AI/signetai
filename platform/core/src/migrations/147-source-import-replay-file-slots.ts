import type { MigrationDb } from "./contract";

/**
 * Migration 147: one configured Source may own multiple auditable replay file
 * slots. Migration 146 already creates that schema. Keep this migration
 * additive: rebuilding the parent table here would cascade-delete existing
 * source_import_records while foreign keys are enabled.
 */
export function up(db: MigrationDb): void {
	db.exec("CREATE INDEX IF NOT EXISTS idx_source_import_files_job_state ON source_import_files(job_id, state)");
}

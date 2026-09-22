import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec("CREATE INDEX IF NOT EXISTS idx_source_import_files_job_state ON source_import_files(job_id, state)");
}

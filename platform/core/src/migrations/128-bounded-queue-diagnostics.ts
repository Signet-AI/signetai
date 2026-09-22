import type { MigrationDb } from "./contract";
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_diagnostics_status_created_at
			ON memory_jobs(status, created_at)
			WHERE job_type <> 'extract';
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_diagnostics_error_updated_at
			ON memory_jobs(updated_at DESC)
			WHERE status IN ('pending', 'leased', 'dead')
			  AND job_type <> 'extract'
			  AND error IS NOT NULL;
	`);
}

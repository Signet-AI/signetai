import type { MigrationDb } from "./index";

/**
 * Migration 118: bounded queue-pressure observation
 *
 * Heartbeat pressure telemetry only needs active queue depth buckets and the
 * oldest active job age. These partial indexes let that path probe a bounded
 * number of live rows without scanning terminal jobs or retired extraction
 * jobs.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_pressure_status
			ON memory_jobs(status)
			WHERE status IN ('pending', 'leased') AND job_type <> 'extract';
		CREATE INDEX IF NOT EXISTS idx_memory_jobs_pressure_created_at
			ON memory_jobs(created_at)
			WHERE status IN ('pending', 'leased') AND job_type <> 'extract';
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_pressure_status
			ON summary_jobs(status)
			WHERE status IN ('pending', 'leased');
		CREATE INDEX IF NOT EXISTS idx_summary_jobs_pressure_created_at
			ON summary_jobs(created_at)
			WHERE status IN ('pending', 'leased');
	`);
}

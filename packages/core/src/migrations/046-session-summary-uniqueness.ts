import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		DROP INDEX IF EXISTS idx_summaries_session_depth;

		CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_session_depth_summary
			ON session_summaries(session_key, depth)
			WHERE session_key IS NOT NULL
			  AND COALESCE(source_type, 'summary') = 'summary';
	`);
}

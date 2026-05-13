import type { MigrationDb } from "./index";

/**
 * Migration 069: Daily reflections become dashboard-open insights.
 *
 * The dashboard should generate fresh Daily Brief items whenever it opens,
 * so an agent can have multiple insights on the same date. De-duplication
 * happens at generation time against recent brief content, not by forbidding
 * more than one row per day.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		DROP INDEX IF EXISTS idx_daily_reflections_agent_date;

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_created
			ON daily_reflections(agent_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);
	`);
}

import type { MigrationDb } from "./index";

/**
 * Migration 069: Daily reflections become dashboard-open insights.
 *
 * The dashboard should generate fresh Daily Brief items whenever it opens,
 * so an agent can have multiple insights on the same date. De-duplication
 * happens at generation time against recent brief content. The database only
 * prevents concurrent duplicate inserts for the same agent and date.
 */
export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(daily_reflections)").all() as ReadonlyArray<Record<string, unknown>>;
	const colNames = new Set(cols.flatMap((c) => (typeof c.name === "string" ? [c.name] : [])));
	if (!colNames.has("content_key")) {
		db.exec("ALTER TABLE daily_reflections ADD COLUMN content_key TEXT");
	}

	db.exec(`
		DROP INDEX IF EXISTS idx_daily_reflections_agent_date;
		DROP INDEX IF EXISTS idx_daily_reflections_agent_content_key;

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_created
			ON daily_reflections(agent_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_daily_reflections_agent_date
			ON daily_reflections(agent_id, date, created_at DESC);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_reflections_agent_content_key
			ON daily_reflections(agent_id, date, content_key)
			WHERE content_key IS NOT NULL;
	`);
}

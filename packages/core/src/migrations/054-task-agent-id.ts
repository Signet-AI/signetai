/**
 * Migration 054: Add agent_id to scheduled_tasks
 *
 * Allows skill invocation analytics to attribute task runs
 * to the correct agent instead of hardcoding 'default'.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as ReadonlyArray<Record<string, unknown>>;
	const colNames = new Set(cols.flatMap((c) => (typeof c.name === "string" ? [c.name] : [])));

	if (!colNames.has("agent_id")) {
		db.exec("ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
	}
}

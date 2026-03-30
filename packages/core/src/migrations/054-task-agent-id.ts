/**
 * Migration 054: Add agent_id to scheduled_tasks
 *
 * Allows skill invocation analytics to attribute task runs
 * to the correct agent instead of hardcoding 'default'.
 *
 * Existing rows receive agent_id = 'default' because pre-migration
 * tasks had no agent ownership column — there is no prior data to
 * infer the correct agent. In single-agent (local) deployments this
 * is accurate. In multi-agent deployments that predate this migration,
 * operators should reassign tasks directly in the database:
 *   UPDATE scheduled_tasks SET agent_id = '<target>' WHERE id = '<task>';
 * The PATCH endpoint cannot move tasks between agents because it scopes
 * the lookup by the caller's agent_id.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as ReadonlyArray<Record<string, unknown>>;
	const colNames = new Set(cols.flatMap((c) => (typeof c.name === "string" ? [c.name] : [])));

	if (!colNames.has("agent_id")) {
		db.exec("ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
	}
}

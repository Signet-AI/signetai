/**
 * Migration 054: Add agent_id to scheduled_tasks
 *
 * Allows skill invocation analytics to attribute task runs
 * to the correct agent instead of hardcoding 'default'.
 *
 * BREAKING for multi-agent deployments: all existing rows are set to
 * agent_id = 'default' because the pre-migration schema had no ownership
 * column — there is no prior data to infer the correct agent. After this
 * migration, task endpoints scope by agent_id in SQL, so tasks assigned
 * to 'default' are only visible to the default agent. Single-agent (local)
 * deployments are unaffected.
 *
 * Multi-agent upgrade path (operator/admin action):
 *   PATCH /api/tasks/:id?agent_id=default  body: { agentId: "<target>" }
 * Done in local mode or with default-agent credentials. The PATCH endpoint
 * scopes the lookup by the current owner (query param) and allows
 * reassignment via body.agentId (validated through resolveScopedAgent).
 * Callers that omit agent_id default to 'default' — no existing client
 * breaks because all pre-migration callers were implicitly 'default'.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as ReadonlyArray<Record<string, unknown>>;
	const colNames = new Set(cols.flatMap((c) => (typeof c.name === "string" ? [c.name] : [])));

	if (!colNames.has("agent_id")) {
		db.exec("ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
	}
}

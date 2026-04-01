import type { ReadDb } from "./db-accessor";

export interface ScopedTaskRow extends Record<string, unknown> {
	readonly scoped_agent_id?: unknown;
}

export function readScopedTask(
	db: ReadDb,
	taskId: string,
	agentId: string,
	enforceScope: boolean,
): ScopedTaskRow | undefined {
	// LEFT JOIN intentionally preserves tasks that do not yet have a scope hint
	// row (e.g., missing or deleted skill metadata). Scope fallback remains
	// explicit via COALESCE.
	const sql =
		"SELECT t.*, COALESCE(h.agent_id, 'default') AS scoped_agent_id FROM scheduled_tasks t LEFT JOIN task_scope_hints h ON h.task_id = t.id WHERE t.id = ?";
	if (!enforceScope) {
		const row = db.prepare(sql).get(taskId) as ScopedTaskRow | null;
		return row ?? undefined;
	}
	const row = db.prepare(`${sql} AND COALESCE(h.agent_id, 'default') = ?`).get(taskId, agentId) as
		| ScopedTaskRow
		| null;
	return row ?? undefined;
}

export function readTaskAgentId(task: ScopedTaskRow, fallbackAgentId: string): string {
	const value = task.scoped_agent_id;
	return typeof value === "string" && value.length > 0 ? value : fallbackAgentId;
}

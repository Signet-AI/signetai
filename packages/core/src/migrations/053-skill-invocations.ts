import type { MigrationDb } from "./index";

/**
 * Migration 053: Skill invocation tracking
 *
 * Records every skill invocation (scheduled-task and API-triggered) with
 * skill name, agent, latency, and outcome. Powers the analytics API
 * and the dashboard usage panel (mirrors mcp_invocations pattern).
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_invocations (
			id          TEXT PRIMARY KEY,
			skill_name  TEXT NOT NULL,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			source      TEXT NOT NULL CHECK(source IN ('scheduled-task','slash-command','cli','api')),
			task_id     TEXT,
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_skill ON skill_invocations(skill_name, created_at);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_agent ON skill_invocations(agent_id, created_at);
	`);
}

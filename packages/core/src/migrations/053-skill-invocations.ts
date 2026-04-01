import type { MigrationDb } from "./index";

/**
 * Migration 053: Skill invocation tracking
 *
 * Records task- and agent-driven skill usage with timestamps, latency,
 * agent scope, and success outcome. Powers overview usage analytics and
 * keeps procedural-memory usage fields grounded in real invocations.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS skill_invocations (
			id          TEXT PRIMARY KEY,
			skill_name  TEXT NOT NULL,
			agent_id    TEXT NOT NULL,
			source      TEXT NOT NULL CHECK(source IN ('agent','scheduler','api')),
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_name ON skill_invocations(skill_name, created_at);
		CREATE INDEX IF NOT EXISTS idx_skill_inv_agent ON skill_invocations(agent_id, created_at);
	`);
}

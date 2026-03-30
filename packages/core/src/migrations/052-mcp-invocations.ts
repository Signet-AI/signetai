import type { MigrationDb } from "./index";

/**
 * Migration 052: MCP invocation tracking
 *
 * Records every MCP tool call (CLI, agent, and MCP-originated) with
 * server, tool, agent, latency, and outcome. Powers the analytics API
 * and the dashboard usage panel.
 */
export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_invocations (
			id          TEXT PRIMARY KEY,
			server_id   TEXT NOT NULL,
			tool_name   TEXT NOT NULL,
			agent_id    TEXT NOT NULL DEFAULT 'default',
			source      TEXT NOT NULL CHECK(source IN ('cli','agent','mcp','dashboard')),
			latency_ms  INTEGER NOT NULL,
			success     INTEGER NOT NULL DEFAULT 1,
			error_text  TEXT,
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_mcp_inv_server ON mcp_invocations(server_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_mcp_inv_agent ON mcp_invocations(agent_id, created_at);
	`);
}

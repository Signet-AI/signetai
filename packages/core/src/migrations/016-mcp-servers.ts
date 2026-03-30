/**
 * Migration 016: MCP Server Registry
 *
 * Adds the mcp_servers table for Signet-managed MCP servers.
 * Each row stores a server's mcporter-format config so the daemon
 * can connect via createRuntime() and proxy tools through /mcp.
 *
 * cli_path is populated after `generate-cli --compile` succeeds,
 * giving non-MCP harnesses a standalone binary they can shell out to.
 */

import type { MigrationDb } from "./index";

export function up(db: MigrationDb): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS mcp_servers (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL UNIQUE,
			transport  TEXT NOT NULL CHECK(transport IN ('stdio', 'http')),
			config     TEXT NOT NULL,
			enabled    INTEGER NOT NULL DEFAULT 1,
			cli_path   TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
			ON mcp_servers(enabled);
	`);
}

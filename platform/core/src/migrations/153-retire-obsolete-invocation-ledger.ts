/**
 * Migration 153: retire the unused external-tool invocation ledger.
 *
 * The external MCP server surface was never a supported product path. Keep
 * the historical migration sequence intact, but remove its unused table from
 * workspaces that may have applied that sequence.
 */
import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec("DROP TABLE IF EXISTS mcp_invocations");
}

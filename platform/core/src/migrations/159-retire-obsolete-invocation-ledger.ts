import type { MigrationDb } from "./contract";

export function up(db: MigrationDb): void {
	db.exec("DROP TABLE IF EXISTS mcp_invocations");
}

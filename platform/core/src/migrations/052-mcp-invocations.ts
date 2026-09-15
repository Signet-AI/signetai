import type { MigrationDb } from "./contract";

export function up(_db: MigrationDb): void {
	// Reserved historical migration slot. External MCP invocation analytics were removed.
}

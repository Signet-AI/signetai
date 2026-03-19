/**
 * Marketplace helpers — shared utilities extracted to avoid circular imports.
 *
 * The readInstalledServers function from marketplace.ts is not exported,
 * so we provide a public re-implementation here that reads the same file.
 *
 * COUPLING NOTE: This reads ~/.agents/marketplace/mcp-servers.json directly.
 * If marketplace.ts ever changes the file path or format, this must be updated
 * to match. See also: marketplace.ts readInstalledServers().
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstalledMarketplaceMcpServer } from "./marketplace.js";

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getInstalledMcpPath(): string {
	return join(getAgentsDir(), "marketplace", "mcp-servers.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read installed MCP servers from the marketplace config file.
 * This is a public accessor for the same data marketplace.ts manages.
 */
export function readInstalledServersPublic(): InstalledMarketplaceMcpServer[] {
	const path = getInstalledMcpPath();
	if (!existsSync(path)) return [];

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.filter(
			(item): item is InstalledMarketplaceMcpServer =>
				isRecord(item) &&
				typeof item.id === "string" &&
				typeof item.name === "string" &&
				typeof item.enabled === "boolean",
		);
	} catch {
		return [];
	}
}

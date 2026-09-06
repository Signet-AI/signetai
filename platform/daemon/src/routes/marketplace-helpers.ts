/** Shared access to the canonical installed MCP server state owner. */

import { readInstalledServers } from "../mcp-install-service.js";
import type { InstalledMarketplaceMcpServer } from "../mcp-install-service.js";

/** Read installed MCP servers for app-tray and other daemon adapters. */
export function readInstalledServersPublic(): InstalledMarketplaceMcpServer[] {
	return readInstalledServers();
}

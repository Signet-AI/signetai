#!/usr/bin/env node
/**
 * Signet MCP Server — stdio transport
 *
 * Standalone entry point that exposes Signet memory tools over stdin/stdout.
 * Designed to be spawned as a subprocess by AI harnesses (Claude Code, OpenCode).
 *
 * The daemon must be running — tool handlers call the daemon's HTTP API.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, refreshMarketplaceProxyTools } from "./mcp/tools.js";

const DAEMON_URL =
	process.env.SIGNET_DAEMON_URL ??
	`http://${process.env.SIGNET_HOST ?? "127.0.0.1"}:${process.env.SIGNET_PORT ?? "3850"}`;

async function resolveAgentsDir(daemonUrl: string): Promise<string | undefined> {
	try {
		const res = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return undefined;
		const data = (await res.json()) as Record<string, unknown>;
		if (typeof data.agentsDir === "string") return data.agentsDir;
	} catch {
		// daemon unreachable — fall through to SIGNET_PATH
	}
	return undefined;
}

const resolvedAgentsDir = await resolveAgentsDir(DAEMON_URL);
if (resolvedAgentsDir && !process.env.SIGNET_PATH) {
	process.env.SIGNET_PATH = resolvedAgentsDir;
}

const server = await createMcpServer({
	daemonUrl: DAEMON_URL,
	version: "0.1.0",
	context: {
		harness: process.env.SIGNET_HARNESS,
		workspace: process.env.SIGNET_WORKSPACE ?? process.cwd(),
		channel: process.env.SIGNET_CHANNEL,
	},
});

const transport = new StdioServerTransport();
await server.connect(transport);

const refreshMsRaw = Number(process.env.SIGNET_MCP_PROXY_REFRESH_MS ?? "15000");
const refreshMs = Number.isFinite(refreshMsRaw) && refreshMsRaw >= 1000 ? refreshMsRaw : 15000;

const refreshTimer = setInterval(() => {
	void refreshMarketplaceProxyTools(server, { notify: true });
}, refreshMs);

let closing = false;
const shutdown = () => {
	if (closing) return;
	closing = true;
	clearInterval(refreshTimer);
	// Hard deadline: exit even if server.close() hangs
	const deadline = setTimeout(() => process.exit(0), 3000);
	deadline.unref();
	void server.close().finally(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Exit when the parent process closes our stdin (session ended)
process.stdin.on("end", shutdown);

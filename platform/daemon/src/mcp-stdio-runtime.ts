/** Signet MCP stdio runtime shared by the public entrypoint and native binary. */
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDreamingMcpServer } from "./mcp/dreaming-tools.js";
import { createMcpServer, refreshMarketplaceProxyTools } from "./mcp/tools.js";
import { resolveMcpDaemonUrl } from "./mcp-stdio-url.js";

function isLocalDaemonUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
}

function isValidAgentsDir(dir: string): boolean {
	try {
		return isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

async function resolveAgentsDir(daemonUrl: string): Promise<string | undefined> {
	if (!isLocalDaemonUrl(daemonUrl)) return undefined;
	try {
		const res = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return undefined;
		const data = (await res.json()) as Record<string, unknown>;
		if (typeof data.agentsDir !== "string") return undefined;
		if (!isValidAgentsDir(data.agentsDir)) return undefined;
		return data.agentsDir;
	} catch {
		// daemon unreachable - fall through to SIGNET_PATH
	}
	return undefined;
}

export async function runMcpStdio(): Promise<void> {
	const daemonUrl = resolveMcpDaemonUrl();
	const resolvedAgentsDir = await resolveAgentsDir(daemonUrl);
	if (resolvedAgentsDir) {
		process.env.SIGNET_PATH = resolvedAgentsDir;
	} else if (process.env.SIGNET_PATH && !isValidAgentsDir(process.env.SIGNET_PATH)) {
		delete process.env.SIGNET_PATH;
	}

	const dreamingAgentId = process.env.SIGNET_DREAMING_AGENT_ID?.trim();
	const dreamingPassId = process.env.SIGNET_DREAMING_PASS_ID?.trim();
	const server = dreamingAgentId
		? createDreamingMcpServer({
				daemonUrl,
				agentId: dreamingAgentId,
				passId: dreamingPassId,
				version: "0.1.0",
			})
		: await createMcpServer({
				daemonUrl,
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
	const refreshTimer = dreamingAgentId
		? null
		: setInterval(() => {
				void refreshMarketplaceProxyTools(server, { notify: true });
			}, refreshMs);

	let closing = false;
	const shutdown = () => {
		if (closing) return;
		closing = true;
		if (refreshTimer) clearInterval(refreshTimer);
		const deadline = setTimeout(() => process.exit(0), 3000);
		deadline.unref();
		void server.close().finally(() => process.exit(0));
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.stdin.on("end", shutdown);
}

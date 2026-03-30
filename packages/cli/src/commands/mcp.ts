/**
 * CLI commands for MCP server management and tool invocation.
 *
 * Provides `signet mcp list`, `signet mcp call`, and `signet mcp analytics`
 * subcommands. All operations go through the daemon's HTTP API.
 */

import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import type { DaemonFetch } from "../lib/daemon.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpDeps {
	readonly fetchFromDaemon: DaemonFetch;
	readonly isDaemonRunning: () => Promise<boolean>;
}

interface McpServer {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly enabled: boolean;
	readonly config: { readonly transport: string };
}

interface McpTool {
	readonly id: string;
	readonly serverId: string;
	readonly serverName: string;
	readonly toolName: string;
	readonly description: string;
	readonly inputSchema?: unknown;
}

interface McpToolsResponse {
	readonly tools: readonly McpTool[];
	readonly servers: readonly {
		readonly serverId: string;
		readonly serverName: string;
		readonly ok: boolean;
		readonly toolCount: number;
	}[];
	readonly count: number;
}

interface McpCallResponse {
	readonly success: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

interface AnalyticsSummary {
	readonly totalCalls: number;
	readonly successRate: number;
	readonly topServers: readonly { readonly serverId: string; readonly count: number; readonly avgLatencyMs: number }[];
	readonly topTools: readonly {
		readonly toolName: string;
		readonly count: number;
		readonly successCount: number;
		readonly avgLatencyMs: number;
	}[];
	readonly latency: { readonly p50: number; readonly p95: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDaemon(deps: McpDeps): Promise<boolean> {
	if (!(await deps.isDaemonRunning())) {
		console.error(chalk.red("Daemon is not running. Start it with: signet daemon start"));
		return false;
	}
	return true;
}

function resolveServer(servers: readonly McpServer[], query: string): McpServer | null {
	// Exact match by id
	const byId = servers.find((s) => s.id === query);
	if (byId) return byId;

	// Case-insensitive match by name
	const lower = query.toLowerCase();
	const byName = servers.filter((s) => s.name.toLowerCase() === lower);
	if (byName.length === 1) return byName[0];

	// Prefix match
	const prefix = servers.filter((s) => s.name.toLowerCase().startsWith(lower));
	if (prefix.length === 1) return prefix[0];

	if (prefix.length > 1) {
		console.error(chalk.red(`Ambiguous server "${query}". Matches:`));
		for (const s of prefix) {
			console.error(`  ${chalk.cyan(s.id)}  ${s.name}`);
		}
		return null;
	}

	console.error(chalk.red(`Server "${query}" not found.`));
	if (servers.length > 0) {
		console.error("Available servers:");
		for (const s of servers.slice(0, 10)) {
			console.error(
				`  ${chalk.cyan(s.id)}  ${s.name}  ${s.enabled ? chalk.green("enabled") : chalk.yellow("disabled")}`,
			);
		}
	}
	return null;
}

function parseToolArgs(params: readonly string[]): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const param of params) {
		const eq = param.indexOf("=");
		if (eq === -1) {
			args[param] = true;
			continue;
		}
		const key = param.slice(0, eq);
		const raw = param.slice(eq + 1);
		// Auto-parse JSON values
		try {
			args[key] = JSON.parse(raw);
		} catch {
			args[key] = raw;
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMcpCommands(program: Command, deps: McpDeps): void {
	const mcpCmd = program.command("mcp").description("Manage and invoke MCP tool servers");

	// signet mcp list
	mcpCmd
		.command("list")
		.description("List installed MCP servers")
		.option("--json", "Output as JSON")
		.action(async (options: { json?: boolean }) => {
			if (!(await ensureDaemon(deps))) return;

			const data = await deps.fetchFromDaemon<{ servers: readonly McpServer[]; count: number }>("/api/marketplace/mcp");
			if (!data) {
				console.error(chalk.red("Failed to fetch servers"));
				return;
			}

			if (options.json) {
				console.log(JSON.stringify(data.servers, null, 2));
				return;
			}

			if (data.servers.length === 0) {
				console.log(chalk.yellow("No MCP servers installed."));
				return;
			}

			console.log(chalk.bold(`\nInstalled MCP Servers (${data.count}):\n`));
			for (const s of data.servers) {
				const status = s.enabled ? chalk.green("enabled") : chalk.yellow("disabled");
				console.log(
					`  ${chalk.cyan(s.id.slice(0, 12).padEnd(12))}  ${s.name.padEnd(25)}  ${s.config.transport.padEnd(6)}  ${status}`,
				);
				if (s.description) {
					console.log(`  ${"".padEnd(12)}  ${chalk.dim(s.description.slice(0, 60))}`);
				}
			}
			console.log();
		});

	// signet mcp tools <server>
	mcpCmd
		.command("tools <server>")
		.description("List tools exposed by an installed MCP server")
		.option("--json", "Output as JSON")
		.action(async (serverQuery: string, options: { json?: boolean }) => {
			if (!(await ensureDaemon(deps))) return;

			const serversData = await deps.fetchFromDaemon<{ servers: readonly McpServer[] }>("/api/marketplace/mcp");
			if (!serversData) {
				console.error(chalk.red("Failed to fetch servers"));
				return;
			}

			const server = resolveServer(serversData.servers, serverQuery);
			if (!server) return;

			const spinner = ora("Fetching tools...").start();
			const toolsData = await deps.fetchFromDaemon<McpToolsResponse>("/api/marketplace/mcp/tools?refresh=1");
			spinner.stop();

			if (!toolsData) {
				console.error(chalk.red("Failed to fetch tools"));
				return;
			}

			const serverTools = toolsData.tools.filter((t) => t.serverId === server.id);

			if (options.json) {
				console.log(JSON.stringify(serverTools, null, 2));
				return;
			}

			if (serverTools.length === 0) {
				console.log(chalk.yellow(`No tools found for server "${server.name}".`));
				return;
			}

			console.log(chalk.bold(`\nTools for ${server.name} (${serverTools.length}):\n`));
			for (const t of serverTools) {
				console.log(`  ${chalk.cyan(t.toolName)}`);
				if (t.description) {
					console.log(`    ${chalk.dim(t.description.slice(0, 80))}`);
				}
			}
			console.log();
		});

	// signet mcp call <server> <tool> [params...]
	mcpCmd
		.command("call <server> <tool> [params...]")
		.description("Invoke a tool on an installed MCP server")
		.option("--pretty", "Pretty-print the JSON result")
		.action(async (serverQuery: string, toolName: string, params: string[], options: { pretty?: boolean }) => {
			if (!(await ensureDaemon(deps))) return;

			const serversData = await deps.fetchFromDaemon<{ servers: readonly McpServer[] }>("/api/marketplace/mcp");
			if (!serversData) {
				console.error(chalk.red("Failed to fetch servers"));
				return;
			}

			const server = resolveServer(serversData.servers, serverQuery);
			if (!server) return;

			if (!server.enabled) {
				console.error(chalk.red(`Server "${server.name}" is disabled.`));
				return;
			}

			const args = parseToolArgs(params);
			const spinner = ora(`Calling ${server.name}.${toolName}...`).start();

			const result = await deps.fetchFromDaemon<McpCallResponse>("/api/marketplace/mcp/call", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-mcp-source": "cli",
				},
				body: JSON.stringify({ serverId: server.id, toolName, args }),
				timeout: 60_000,
			});

			spinner.stop();

			if (!result) {
				console.error(chalk.red("Tool call failed"));
				return;
			}
			if (!result.success) {
				console.error(chalk.red(`Error: ${result.error ?? "unknown error"}`));
				process.exitCode = 1;
				return;
			}

			const indent = options.pretty ? 2 : undefined;
			console.log(JSON.stringify(result.result, null, indent));
		});

	// signet mcp analytics
	mcpCmd
		.command("analytics")
		.description("Show MCP tool usage analytics")
		.option("--server <id>", "Filter by server ID")
		.option("--since <iso>", "Only include invocations after this ISO date")
		.option("--json", "Output as JSON")
		.action(async (options: { server?: string; since?: string; json?: boolean }) => {
			if (!(await ensureDaemon(deps))) return;

			const params = new URLSearchParams();
			if (options.server) params.set("server", options.server);
			if (options.since) params.set("since", options.since);

			const qs = params.toString();
			const path = `/api/mcp/analytics${qs ? `?${qs}` : ""}`;
			const data = await deps.fetchFromDaemon<AnalyticsSummary>(path);

			if (!data) {
				console.error(chalk.red("Failed to fetch analytics"));
				return;
			}

			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}

			console.log(chalk.bold("\nMCP Tool Usage Analytics\n"));
			console.log(`  Total calls:   ${chalk.cyan(String(data.totalCalls))}`);
			console.log(`  Success rate:  ${chalk.cyan(`${(data.successRate * 100).toFixed(1)}%`)}`);
			console.log(`  Latency p50:   ${chalk.cyan(`${data.latency.p50}ms`)}`);
			console.log(`  Latency p95:   ${chalk.cyan(`${data.latency.p95}ms`)}`);

			if (data.topServers.length > 0) {
				console.log(chalk.bold("\n  Top Servers:"));
				for (const s of data.topServers) {
					console.log(
						`    ${s.serverId.slice(0, 20).padEnd(20)}  ${String(s.count).padStart(6)} calls  ${String(s.avgLatencyMs).padStart(5)}ms avg`,
					);
				}
			}

			if (data.topTools.length > 0) {
				console.log(chalk.bold("\n  Top Tools:"));
				for (const t of data.topTools) {
					const rate = t.count > 0 ? `${((t.successCount / t.count) * 100).toFixed(0)}%` : "n/a";
					console.log(
						`    ${t.toolName.padEnd(25)}  ${String(t.count).padStart(6)} calls  ${rate.padStart(4)} ok  ${String(t.avgLatencyMs).padStart(5)}ms`,
					);
				}
			}
			console.log();
		});
}

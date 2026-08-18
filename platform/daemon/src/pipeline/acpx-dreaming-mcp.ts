/** Temporary ACPX MCP configuration for one bounded Dreaming pass. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasNativeRuntimeAssets } from "../native-runtime-assets";
import { DREAMING_CAPABILITY_IDS } from "./dreaming-capability-ids";

export interface DreamingAcpxMcpConfig {
	readonly path: string;
	readonly args: readonly string[];
	readonly environment?: Readonly<NodeJS.ProcessEnv>;
	dispose(): void;
}

interface DreamingMcpProcess {
	readonly command: string;
	readonly args: readonly string[];
	readonly internal: boolean;
}

const DREAMING_MCP_NAME = "signet_dreaming";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexEnvironment(
	processConfig: DreamingMcpProcess,
	env: readonly { name: string; value: string }[],
): NodeJS.ProcessEnv {
	const inherited = process.env.CODEX_CONFIG?.trim();
	let config: Record<string, unknown> = {};
	if (inherited) {
		const parsed: unknown = JSON.parse(inherited);
		if (!isRecord(parsed)) throw new Error("CODEX_CONFIG must contain a JSON object for scoped Dreaming MCP");
		config = parsed;
	}
	return {
		...Object.fromEntries(env.map((entry) => [entry.name, entry.value])),
		CODEX_CONFIG: JSON.stringify({
			...config,
			mcp_servers: {
				[DREAMING_MCP_NAME]: {
					command: processConfig.command,
					args: processConfig.args,
					env_vars: env.map((entry) => entry.name),
					enabled_tools: [...DREAMING_CAPABILITY_IDS],
					default_tools_approval_mode: "approve",
					required: true,
				},
			},
		}),
	};
}

function resolveMcpProcess(): DreamingMcpProcess {
	if (hasNativeRuntimeAssets()) {
		return { command: process.execPath, args: [], internal: true };
	}
	const here = fileURLToPath(import.meta.url);
	const suffix = extname(here) === ".ts" ? ".ts" : ".js";
	const candidates =
		suffix === ".ts"
			? [join(dirname(dirname(here)), "mcp-stdio.ts")]
			: [join(dirname(here), "mcp-stdio.js"), join(dirname(dirname(here)), "mcp-stdio.js")];
	const entrypoint = candidates.find((candidate) => existsSync(candidate));
	if (!entrypoint) {
		throw new Error(`Signet Dreaming MCP entrypoint is unavailable: ${candidates.join(", ")}`);
	}
	return { command: process.execPath, args: [entrypoint], internal: false };
}

/**
 * Codex receives the constrained server through CODEX_CONFIG so its exact
 * Dreaming tool allowlist can be approved while ACPX remains deny-all. Other
 * ACP agents load the same server from this ephemeral config. The JSON is
 * process configuration and is removed as soon as the bounded turn exits.
 */
export function createDreamingAcpxMcpConfig(params: {
	readonly agentId: string;
	readonly passId: string;
	readonly daemonUrl: string;
	readonly authorizationToken?: string;
	readonly acpxAgent?: string;
}): DreamingAcpxMcpConfig {
	const processConfig = resolveMcpProcess();
	const env = [
		{ name: "SIGNET_DREAMING_AGENT_ID", value: params.agentId },
		{ name: "SIGNET_DREAMING_PASS_ID", value: params.passId },
		{ name: "SIGNET_DAEMON_URL", value: params.daemonUrl },
		...(processConfig.internal ? [{ name: "SIGNET_MCP_STDIO_WORKER", value: "1" }] : []),
		...(params.authorizationToken ? [{ name: "SIGNET_TOKEN", value: params.authorizationToken }] : []),
	];
	const codex = params.acpxAgent?.trim().toLowerCase() === "codex";
	const environment = codex ? codexEnvironment(processConfig, env) : undefined;
	const dir = mkdtempSync(join(tmpdir(), "signet-dreaming-mcp-"));
	const path = join(dir, "mcp.json");
	try {
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: [
					{
						name: DREAMING_MCP_NAME,
						command: processConfig.command,
						args: processConfig.args,
						env,
					},
				],
			}),
			{ mode: 0o600 },
		);
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	return {
		path,
		args: codex ? [] : ["--mcp-config", path],
		...(environment ? { environment } : {}),
		dispose() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

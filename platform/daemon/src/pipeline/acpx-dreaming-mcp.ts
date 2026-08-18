/** Temporary ACPX MCP configuration for one bounded Dreaming pass. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasNativeRuntimeAssets } from "../native-runtime-assets";

export interface DreamingAcpxMcpConfig {
	readonly path: string;
	dispose(): void;
}

interface DreamingMcpProcess {
	readonly command: string;
	readonly args: readonly string[];
	readonly internal: boolean;
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
 * ACPX loads `mcpServers` only from this ephemeral config. It receives one
 * constrained Signet server, whose schemas never accept an agent id. The
 * JSON is process configuration (not application state) and is removed as
 * soon as the bounded agent turn exits.
 */
export function createDreamingAcpxMcpConfig(params: {
	readonly agentId: string;
	readonly passId: string;
	readonly daemonUrl: string;
	readonly authorizationToken?: string;
}): DreamingAcpxMcpConfig {
	const dir = mkdtempSync(join(tmpdir(), "signet-dreaming-mcp-"));
	const path = join(dir, "mcp.json");
	const processConfig = resolveMcpProcess();
	const env = [
		{ name: "SIGNET_DREAMING_AGENT_ID", value: params.agentId },
		{ name: "SIGNET_DREAMING_PASS_ID", value: params.passId },
		{ name: "SIGNET_DAEMON_URL", value: params.daemonUrl },
		...(processConfig.internal ? [{ name: "SIGNET_MCP_STDIO_WORKER", value: "1" }] : []),
		...(params.authorizationToken ? [{ name: "SIGNET_TOKEN", value: params.authorizationToken }] : []),
	];
	writeFileSync(
		path,
		JSON.stringify({
			mcpServers: [
				{
					name: "signet_dreaming",
					command: processConfig.command,
					args: processConfig.args,
					env,
				},
			],
		}),
		{ mode: 0o600 },
	);
	return {
		path,
		dispose() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

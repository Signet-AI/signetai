/** Temporary ACPX MCP configuration for one bounded Dreaming pass. */
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DreamingAcpxMcpConfig {
	readonly path: string;
	dispose(): void;
}

interface DreamingMcpProcess {
	readonly command: string;
	readonly args: readonly string[];
}

/** Resolve only the packaged Rust MCP executable; never a JS/TS stdio server. */
export function resolveDreamingMcpBinary(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.SIGNET_RUST_MCP_BIN?.trim();
	const packageRoot = env.SIGNET_DIR?.trim() ?? env.SIGNET_WRAPPER_DIR?.trim();
	const binary = process.platform === "win32" ? "signet-mcp.exe" : "signet-mcp";
	const here = fileURLToPath(import.meta.url);
	const candidates = [
		explicit,
		packageRoot
			? join(packageRoot, "runtime", "rust-daemon", `${process.platform}-${process.arch}`, binary)
			: undefined,
		join(dirname(here), "../../../../dist/signetai/runtime/rust-daemon", `${process.platform}-${process.arch}`, binary),
	];
	const resolved = candidates.find((candidate) => {
		if (!candidate || /\.(?:js|ts|mjs|cjs)$/i.test(candidate) || !existsSync(candidate)) return false;
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	if (!resolved)
		throw new Error(`Signet native MCP binary is missing; set SIGNET_RUST_MCP_BIN or install the packaged ${binary}`);
	return resolved;
}

function resolveMcpProcess(): DreamingMcpProcess {
	return { command: resolveDreamingMcpBinary(), args: [] };
}
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

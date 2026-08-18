import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "bun:test";
import { registerNativeAssets } from "../native-runtime-assets";
import { createDreamingAcpxMcpConfig } from "./acpx-dreaming-mcp";
import { DREAMING_CAPABILITY_IDS } from "./dreaming-capability-ids";

const originalCodexConfig = process.env.CODEX_CONFIG;

describe("Dreaming ACPX MCP config", () => {
	const configs: Array<ReturnType<typeof createDreamingAcpxMcpConfig>> = [];

	afterEach(() => {
		for (const config of configs.splice(0)) config.dispose();
		globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__ = undefined;
		if (originalCodexConfig === undefined) delete process.env.CODEX_CONFIG;
		else process.env.CODEX_CONFIG = originalCodexConfig;
	});

	it("creates one ephemeral scoped MCP server and removes it after the turn", () => {
		const config = createDreamingAcpxMcpConfig({
			agentId: "agent-a",
			passId: "pass-a",
			daemonUrl: "http://127.0.0.1:3850",
			authorizationToken: "scoped-token",
		});
		configs.push(config);
		const parsed = JSON.parse(readFileSync(config.path, "utf8")) as {
			mcpServers: Array<{
				name: string;
				command: string;
				args: string[];
				env: Array<{ name: string; value: string }>;
			}>;
		};
		expect(parsed.mcpServers).toHaveLength(1);
		expect(parsed.mcpServers[0]).toMatchObject({
			name: "signet_dreaming",
			command: process.execPath,
		});
		expect(parsed.mcpServers[0]?.args[0]).toEndWith("mcp-stdio.ts");
		expect(parsed.mcpServers[0]?.env).toEqual(
			expect.arrayContaining([
				{ name: "SIGNET_DREAMING_AGENT_ID", value: "agent-a" },
				{ name: "SIGNET_DREAMING_PASS_ID", value: "pass-a" },
				{ name: "SIGNET_DAEMON_URL", value: "http://127.0.0.1:3850" },
				{ name: "SIGNET_TOKEN", value: "scoped-token" },
			]),
		);
		expect(config.args).toEqual(["--mcp-config", config.path]);
		expect(config.environment).toBeUndefined();
		config.dispose();
		expect(existsSync(config.path)).toBe(false);
	});

	it("dispatches MCP internally instead of resolving a /$bunfs entrypoint in the native binary", () => {
		registerNativeAssets({});
		const config = createDreamingAcpxMcpConfig({
			agentId: "agent-a",
			passId: "pass-a",
			daemonUrl: "http://127.0.0.1:3850",
		});
		configs.push(config);
		const parsed = JSON.parse(readFileSync(config.path, "utf8")) as {
			mcpServers: Array<{
				command: string;
				args: string[];
				env: Array<{ name: string; value: string }>;
			}>;
		};

		expect(parsed.mcpServers[0]?.command).toBe(process.execPath);
		expect(parsed.mcpServers[0]?.args).toEqual([]);
		expect(parsed.mcpServers[0]?.env).toContainEqual({ name: "SIGNET_MCP_STDIO_WORKER", value: "1" });
	});

	it("auto-approves only the scoped Dreaming MCP tools for Codex while ACPX remains deny-all", () => {
		process.env.CODEX_CONFIG = JSON.stringify({
			features: { web_search: false },
			mcp_servers: { existing: { url: "https://example.test/mcp" } },
		});
		registerNativeAssets({});
		const config = createDreamingAcpxMcpConfig({
			agentId: "agent-a",
			passId: "pass-a",
			daemonUrl: "http://127.0.0.1:3850",
			authorizationToken: "scoped-token",
			acpxAgent: "codex",
		});
		configs.push(config);

		expect(config.args).toEqual([]);
		expect(config.environment).toMatchObject({
			SIGNET_DREAMING_AGENT_ID: "agent-a",
			SIGNET_DREAMING_PASS_ID: "pass-a",
			SIGNET_DAEMON_URL: "http://127.0.0.1:3850",
			SIGNET_MCP_STDIO_WORKER: "1",
			SIGNET_TOKEN: "scoped-token",
		});
		const codex = JSON.parse(config.environment?.CODEX_CONFIG ?? "{}") as {
			features?: { web_search?: boolean };
			mcp_servers?: Record<string, Record<string, unknown>>;
		};
		expect(codex.features?.web_search).toBe(false);
		expect(codex.mcp_servers?.existing).toBeUndefined();
		expect(Object.keys(codex.mcp_servers ?? {})).toEqual(["signet_dreaming"]);
		expect(codex.mcp_servers?.signet_dreaming).toMatchObject({
			command: process.execPath,
			args: [],
			default_tools_approval_mode: "approve",
			required: true,
		});
		expect(codex.mcp_servers?.signet_dreaming?.env_vars).toEqual([
			"SIGNET_DREAMING_AGENT_ID",
			"SIGNET_DREAMING_PASS_ID",
			"SIGNET_DAEMON_URL",
			"SIGNET_MCP_STDIO_WORKER",
			"SIGNET_TOKEN",
		]);
		expect(codex.mcp_servers?.signet_dreaming?.enabled_tools).toEqual([...DREAMING_CAPABILITY_IDS]);
		expect(codex.mcp_servers?.signet_dreaming?.env).toBeUndefined();
	});

	it("does not leave a scoped token file when inherited Codex config is invalid", () => {
		const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("signet-dreaming-mcp-"));
		process.env.CODEX_CONFIG = "[";

		expect(() =>
			createDreamingAcpxMcpConfig({
				agentId: "agent-a",
				passId: "pass-a",
				daemonUrl: "http://127.0.0.1:3850",
				authorizationToken: "must-not-reach-disk",
				acpxAgent: "codex",
			}),
		).toThrow();
		expect(readdirSync(tmpdir()).filter((entry) => entry.startsWith("signet-dreaming-mcp-"))).toEqual(before);
	});
});

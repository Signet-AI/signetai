import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { registerNativeAssets } from "../native-runtime-assets";
import { createDreamingAcpxMcpConfig } from "./acpx-dreaming-mcp";

describe("Dreaming ACPX MCP config", () => {
	const configs: Array<ReturnType<typeof createDreamingAcpxMcpConfig>> = [];

	afterEach(() => {
		for (const config of configs.splice(0)) config.dispose();
		globalThis.__SIGNET_NATIVE_RUNTIME_ASSETS__ = undefined;
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
});

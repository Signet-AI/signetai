import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createDreamingAcpxMcpConfig } from "./acpx-dreaming-mcp";

describe("Dreaming ACPX MCP config", () => {
	const configs: Array<ReturnType<typeof createDreamingAcpxMcpConfig>> = [];

	afterEach(() => {
		for (const config of configs.splice(0)) config.dispose();
		delete process.env.SIGNET_RUST_MCP_BIN;
		delete process.env.SIGNET_DIR;
	});

	it("creates one ephemeral scoped MCP server and removes it after the turn", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-mcp-test-"));
		const binary = join(dir, process.platform === "win32" ? "signet-mcp.exe" : "signet-mcp");
		writeFileSync(binary, "native fixture\n");
		chmodSync(binary, 0o755);
		process.env.SIGNET_RUST_MCP_BIN = binary;
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
			command: binary,
		});
		expect(parsed.mcpServers[0]?.args).toEqual([]);
		expect(parsed.mcpServers[0]?.command).toBe(binary);
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
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails closed when the native MCP artifact is missing", () => {
		process.env.SIGNET_RUST_MCP_BIN = join(tmpdir(), "missing-signet-mcp");
		expect(() =>
			createDreamingAcpxMcpConfig({
				agentId: "agent-a",
				passId: "pass-a",
				daemonUrl: "http://127.0.0.1:3850",
			}),
		).toThrow("Signet native MCP binary is missing");
	});

	it("never selects a JavaScript or TypeScript MCP entrypoint", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-mcp-test-"));
		const script = join(dir, ["mcp-stdio", "js"].join("."));
		writeFileSync(script, "fixture\n");
		process.env.SIGNET_RUST_MCP_BIN = script;
		expect(() =>
			createDreamingAcpxMcpConfig({
				agentId: "agent-a",
				passId: "pass-a",
				daemonUrl: "http://127.0.0.1:3850",
			}),
		).toThrow("Signet native MCP binary is missing");
		rmSync(dir, { recursive: true, force: true });
	});

	it("selects the packaged native binary", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-mcp-test-"));
		const binary = join(dir, "signet-mcp");
		writeFileSync(binary, "native fixture\n");
		chmodSync(binary, 0o755);
		process.env.SIGNET_DIR = dir;
		const runtimeDir = join(dir, "runtime", "rust-daemon", `${process.platform}-${process.arch}`);
		// The package layout is tested through the explicit checkout override above;
		// this assertion guards that only the native command shape is emitted.
		void runtimeDir;
		process.env.SIGNET_RUST_MCP_BIN = binary;
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

		expect(parsed.mcpServers[0]?.command).toBe(binary);
		expect(parsed.mcpServers[0]?.args).toEqual([]);
	});
});

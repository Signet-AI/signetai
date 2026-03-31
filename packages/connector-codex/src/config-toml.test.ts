/**
 * Integration tests for CodexConnector MCP config.toml management.
 *
 * Tests exercise real production code via CodexConnector.install() and
 * CodexConnector.uninstall(). A subclass redirects getCodexHome() to a
 * temp directory so the real ~/.codex is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexConnector, buildMcpBlock } from "./index.js";

class TempConnector extends CodexConnector {
	constructor(private home: string) {
		super();
	}
	protected override getCodexHome(): string {
		return join(this.home, ".codex");
	}
}

let tempHome: string;
let codexDir: string;
let configPath: string;

beforeEach(() => {
	tempHome = join(tmpdir(), `signet-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	codexDir = join(tempHome, ".codex");
	configPath = join(codexDir, "config.toml");
	mkdirSync(codexDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
});

function connector(): TempConnector {
	return new TempConnector(tempHome);
}

describe("CodexConnector.install — config.toml MCP registration", () => {
	test("creates config.toml with string command when file does not exist", async () => {
		await connector().install(tempHome);
		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).toContain("command = 'signet-mcp'");
		// Must not be an array — Codex's Rust parser expects Option<String>
		expect(content).not.toContain("command = [");
	});

	test("repairs stale array-format command on re-install (regression: #273 / invalid transport)", async () => {
		// This is the exact config that caused "invalid transport in 'mcp_servers.signet'"
		// errors for users who installed before PR #273 fixed the array bug.
		writeFileSync(
			configPath,
			"# Signet MCP server\n[mcp_servers.signet]\ncommand = ['signet-mcp']\n",
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("command = [");
	});

	test("preserves other config sections when repairing stale entry", async () => {
		writeFileSync(
			configPath,
			'[model]\nname = "gpt-4o"\n\n# Signet MCP server\n[mcp_servers.signet]\ncommand = [\'signet-mcp\']\n\n[history]\nenabled = true\n',
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).toContain('name = "gpt-4o"');
		expect(content).toContain("[history]");
		expect(content).toContain("enabled = true");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("command = [");
	});

	test("appends section when config exists but has no signet entry", async () => {
		writeFileSync(configPath, '[model]\nname = "gpt-4o"\n');

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).toContain("command = 'signet-mcp'");
	});

	test("idempotent: re-running install produces identical config.toml", async () => {
		await connector().install(tempHome);
		const first = readFileSync(configPath, "utf-8");

		await connector().install(tempHome);
		const second = readFileSync(configPath, "utf-8");

		expect(second).toBe(first);
	});

	test("config section appears exactly once after repeated installs", async () => {
		await connector().install(tempHome);
		await connector().install(tempHome);
		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content.match(/\[mcp_servers\.signet\]/g)?.length).toBe(1);
	});
});

describe("CodexConnector.uninstall — config.toml cleanup", () => {
	test("removes signet section from config.toml", async () => {
		const c = connector();
		await c.install(tempHome);
		expect(readFileSync(configPath, "utf-8")).toContain("[mcp_servers.signet]");

		await c.uninstall();

		expect(existsSync(configPath)).toBe(true);
		expect(readFileSync(configPath, "utf-8")).not.toContain("[mcp_servers.signet]");
	});

	test("preserves other sections when removing signet entry", async () => {
		writeFileSync(configPath, '[model]\nname = "gpt-4o"\n');
		const c = connector();
		await c.install(tempHome);
		await c.uninstall();

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).not.toContain("[mcp_servers.signet]");
	});

	test("handles multi-line TOML args without corrupting surrounding sections (regression: unpatchConfigToml)", async () => {
		// A user who hand-edited args to multi-line form would have had
		// continuation lines left in the file by the old section-end detection.
		writeFileSync(
			configPath,
			[
				"[other]",
				"key = 'val'",
				"",
				"# Signet MCP server",
				"[mcp_servers.signet]",
				"command = 'signet-mcp'",
				"args = [",
				"  '--verbose'",
				"]",
				"",
				"[after]",
				"key = 'val'",
				"",
			].join("\n"),
		);

		const c = connector();
		await c.uninstall();

		const content = readFileSync(configPath, "utf-8");
		expect(content).not.toContain("[mcp_servers.signet]");
		// Continuation lines must not leak into the output
		expect(content).not.toContain("--verbose");
		expect(content).toContain("[other]");
		expect(content).toContain("[after]");
	});
});

// buildMcpBlock is tested directly here because resolveSignetMcp() always
// returns the non-Windows path on Linux, so Windows quoting can't be
// exercised through install().
describe("buildMcpBlock — TOML quoting", () => {
	test("produces string command, not array", () => {
		const block = buildMcpBlock({ command: "signet-mcp", args: [] });
		expect(block).toContain("command = 'signet-mcp'");
		expect(block).not.toContain("command = [");
	});

	test("Windows paths with backslashes are quoted correctly", () => {
		const block = buildMcpBlock({
			command: "C:\\Program Files\\node.exe",
			args: ["C:\\signet\\mcp-stdio.js"],
		});
		// No single-quote in the path, so literal single-quote TOML strings are used
		expect(block).toContain("command = 'C:\\Program Files\\node.exe'");
		expect(block).toContain("args = ['C:\\signet\\mcp-stdio.js']");
		expect(block).not.toContain("command = [");
	});

	test("omits args line when args is empty", () => {
		const block = buildMcpBlock({ command: "signet-mcp", args: [] });
		expect(block).not.toContain("args");
	});

	test("includes args line when args are present", () => {
		const block = buildMcpBlock({ command: "node", args: ["mcp.js", "--port", "3000"] });
		expect(block).toContain("args = ['mcp.js', '--port', '3000']");
	});
});

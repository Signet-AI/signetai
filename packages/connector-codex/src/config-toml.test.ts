/**
 * Integration tests for CodexConnector MCP config.toml management.
 *
 * Tests exercise real production code via CodexConnector.install() and
 * CodexConnector.uninstall(). A subclass redirects getCodexHome() to a
 * temp directory so the real ~/.codex is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let hooksPath: string;

beforeEach(() => {
	tempHome = join(tmpdir(), `signet-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	codexDir = join(tempHome, ".codex");
	configPath = join(codexDir, "config.toml");
	hooksPath = join(codexDir, "hooks.json");
	mkdirSync(codexDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
});

function connector(): TempConnector {
	return new TempConnector(tempHome);
}

describe("CodexConnector.install — legacy SIGNET block migration", () => {
	test("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		const agentsPath = join(tempHome, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");

		const result = await connector().install(tempHome);

		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	test("leaves AGENTS.md untouched and does not add path when no legacy block", async () => {
		const agentsPath = join(tempHome, "AGENTS.md");
		writeFileSync(agentsPath, "plain content\n", "utf-8");

		const result = await connector().install(tempHome);

		expect(readFileSync(agentsPath, "utf-8")).toBe("plain content\n");
		expect(result.filesWritten).not.toContain(agentsPath);
	});
});

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
		writeFileSync(configPath, "# Signet MCP server\n[mcp_servers.signet]\ncommand = ['signet-mcp']\n");

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("command = [");
	});

	test("preserves other config sections when repairing stale entry", async () => {
		writeFileSync(
			configPath,
			"[model]\nname = \"gpt-4o\"\n\n# Signet MCP server\n[mcp_servers.signet]\ncommand = ['signet-mcp']\n\n[history]\nenabled = true\n",
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

// ---------------------------------------------------------------------------
// hooks.json regression tests (issue #481)
// ---------------------------------------------------------------------------

function readHooksJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

describe("CodexConnector.install — hooks.json schema", () => {
	test("writes hooks under a top-level 'hooks' key with PascalCase event names", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();

		expect(json.hooks).toBeDefined();
		expect(typeof json.hooks).toBe("object");
		expect(json.hooks).not.toBeNull();

		const hooks = json.hooks as Record<string, unknown>;
		expect(hooks.SessionStart).toBeDefined();
		expect(hooks.UserPromptSubmit).toBeDefined();
		expect(hooks.Stop).toBeDefined();
	});

	test("uses MatcherGroup shape with 'hooks' array (not 'handlers')", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		const groups = (json.hooks as Record<string, unknown[]>).SessionStart as Record<string, unknown>[];

		expect(groups.length).toBeGreaterThanOrEqual(1);
		const group = groups[0] as Record<string, unknown>;
		expect(Array.isArray(group.hooks)).toBe(true);
		expect(group.handlers).toBeUndefined();
	});

	test("emits tagged handler with type 'command' and string command", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		const groups = (json.hooks as Record<string, unknown[]>).SessionStart as Record<string, unknown>[];
		const handler = ((groups[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];

		expect(handler.type).toBe("command");
		expect(typeof handler.command).toBe("string");
		expect(handler.command as string).toContain("hook session-start");
		expect(handler.command as string).toContain("-H codex");
		expect(handler.timeout).toBe(10);
	});

	test("sets correct timeouts per event", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;

		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];
		expect(startHandler.timeout).toBe(10);

		const promptHandler = (
			(hooks.UserPromptSubmit[0] as Record<string, unknown>).hooks as Record<string, unknown>[]
		)[0];
		expect(promptHandler.timeout).toBe(5);

		const stopHandler = ((hooks.Stop[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];
		expect(stopHandler.timeout).toBe(30);
	});

	test("does not use array-form command (regression: issue #481)", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;

		for (const eventGroups of Object.values(hooks)) {
			for (const group of eventGroups) {
				const handlers = (group as Record<string, unknown>).hooks as Record<string, unknown>[];
				for (const h of handlers) {
					expect(Array.isArray(h.command)).toBe(false);
				}
			}
		}
	});

	test("does not use lowercase event names (regression: issue #481)", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();

		expect(json.sessionStart).toBeUndefined();
		expect(json.userPromptSubmit).toBeUndefined();
		expect(json.stop).toBeUndefined();
	});

	test("sets _signet marker", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		expect(json._signet).toBe(true);
	});

	test("idempotent: re-running install produces identical hooks.json", async () => {
		await connector().install(tempHome);
		const first = readFileSync(hooksPath, "utf-8");

		await connector().install(tempHome);
		const second = readFileSync(hooksPath, "utf-8");

		expect(second).toBe(first);
	});

	test("writes fresh Signet hooks when existing hooks.json has empty hooks object", async () => {
		writeFileSync(hooksPath, JSON.stringify({ hooks: {} }));

		const c = connector();
		await c.install(tempHome);

		expect(c.isInstalled()).toBe(true);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, unknown>;
		expect(hooks.SessionStart).toBeDefined();
		expect(hooks.UserPromptSubmit).toBeDefined();
		expect(hooks.Stop).toBeDefined();
	});

	test("writes fresh Signet hooks when existing hooks.json has _signet marker but empty hooks", async () => {
		writeFileSync(hooksPath, JSON.stringify({ _signet: true, hooks: {} }));

		const c = connector();
		await c.install(tempHome);

		expect(c.isInstalled()).toBe(true);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, unknown>;
		expect(hooks.SessionStart).toBeDefined();
		expect(hooks.UserPromptSubmit).toBeDefined();
		expect(hooks.Stop).toBeDefined();
	});
});

describe("CodexConnector.install — hooks.json legacy migration", () => {
	test("migrates legacy lowercase handlers-based hooks.json to correct schema", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				_signet: true,
				sessionStart: [{ handlers: [{ command: ["signet", "hook", "session-start", "-H", "codex"], timeout: 10 }] }],
				userPromptSubmit: [
					{ handlers: [{ command: ["signet", "hook", "user-prompt-submit", "-H", "codex"], timeout: 5 }] },
				],
				stop: [{ handlers: [{ command: ["signet", "hook", "session-end", "-H", "codex"], timeout: 30 }] }],
			}),
		);

		await connector().install(tempHome);
		const json = readHooksJson();

		expect(json.hooks).toBeDefined();
		expect(json.sessionStart).toBeUndefined();
		expect(json.userPromptSubmit).toBeUndefined();
		expect(json.stop).toBeUndefined();

		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		expect(hooks.SessionStart).toBeDefined();
		expect(hooks.UserPromptSubmit).toBeDefined();
		expect(hooks.Stop).toBeDefined();
	});

	test("preserves existing third-party hooks during migration", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [{ type: "command", command: "echo hello", timeout: 5 }] }],
				},
			}),
		);

		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;

		const startGroups = hooks.SessionStart as Record<string, unknown>[];
		const allCommands = startGroups.flatMap((g) =>
			((g as Record<string, unknown>).hooks as Record<string, unknown>[]).map(
				(h) => (h as Record<string, unknown>).command,
			),
		);
		expect(allCommands).toContain("echo hello");
		expect(allCommands.some((c) => (c as string).includes("hook session-start"))).toBe(true);
	});
});

describe("CodexConnector.uninstall — hooks.json cleanup", () => {
	test("removes hooks.json when only Signet entries exist", async () => {
		const c = connector();
		await c.install(tempHome);
		expect(existsSync(hooksPath)).toBe(true);

		await c.uninstall();
		expect(existsSync(hooksPath)).toBe(false);
	});

	test("preserves third-party hooks when uninstalling", async () => {
		const c = connector();
		await c.install(tempHome);

		const json = readHooksJson();
		const hooks = json.hooks as Record<string, unknown[]>;
		(hooks as Record<string, unknown>).PreToolUse = [
			{ hooks: [{ type: "command", command: "echo pre-tool", timeout: 5 }] },
		];
		writeFileSync(hooksPath, JSON.stringify(json));

		await c.uninstall();

		expect(existsSync(hooksPath)).toBe(true);
		const remaining = JSON.parse(readFileSync(hooksPath, "utf-8"));
		const remHooks = remaining.hooks as Record<string, unknown[]>;
		expect(remHooks.PreToolUse).toBeDefined();
		expect(remHooks.SessionStart).toBeUndefined();
		expect(remHooks.UserPromptSubmit).toBeUndefined();
		expect(remHooks.Stop).toBeUndefined();
	});
});

describe("CodexConnector.isInstalled", () => {
	test("returns true after install", async () => {
		const c = connector();
		expect(c.isInstalled()).toBe(false);
		await c.install(tempHome);
		expect(c.isInstalled()).toBe(true);
	});

	test("returns false after uninstall", async () => {
		const c = connector();
		await c.install(tempHome);
		await c.uninstall();
		expect(c.isInstalled()).toBe(false);
	});

	test("returns false for legacy schema without hooks key", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				_signet: true,
				sessionStart: [{ handlers: [{ command: ["signet", "hook", "session-start", "-H", "codex"], timeout: 10 }] }],
			}),
		);
		expect(connector().isInstalled()).toBe(false);
	});
});

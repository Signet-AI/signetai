/**
 * Integration tests for KimiConnector config.toml hook + mcp.json management.
 *
 * Tests exercise real production code via KimiConnector.install() and
 * KimiConnector.uninstall(). A subclass redirects getKimiHome() to a
 * temp directory so the real ~/.kimi-code is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiConnector, buildKimiHookEntries, removeSignetKimiHookBlocks } from "./index.js";

class TempConnector extends KimiConnector {
	constructor(private home: string) {
		super();
	}
	protected override getKimiHome(): string {
		return join(this.home, ".kimi-code");
	}
}

let tempHome: string;
let kimiDir: string;
let configPath: string;
let mcpPath: string;
let previousSessionStartTimeout: string | undefined;
let previousFetchTimeout: string | undefined;
let previousPromptSubmitTimeout: string | undefined;
let previousDaemonUrl: string | undefined;
let previousApiKey: string | undefined;
let previousToken: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(process.env, name);
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	previousSessionStartTimeout = process.env.SIGNET_SESSION_START_TIMEOUT;
	previousFetchTimeout = process.env.SIGNET_FETCH_TIMEOUT;
	previousPromptSubmitTimeout = process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT;
	previousDaemonUrl = process.env.SIGNET_DAEMON_URL;
	previousApiKey = process.env.SIGNET_API_KEY;
	previousToken = process.env.SIGNET_TOKEN;
	Reflect.deleteProperty(process.env, "SIGNET_SESSION_START_TIMEOUT");
	Reflect.deleteProperty(process.env, "SIGNET_FETCH_TIMEOUT");
	Reflect.deleteProperty(process.env, "SIGNET_PROMPT_SUBMIT_TIMEOUT");
	Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
	Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
	Reflect.deleteProperty(process.env, "SIGNET_TOKEN");
	tempHome = join(tmpdir(), `signet-kimi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	kimiDir = join(tempHome, ".kimi-code");
	configPath = join(kimiDir, "config.toml");
	mcpPath = join(kimiDir, "mcp.json");
	mkdirSync(kimiDir, { recursive: true });
});

afterEach(() => {
	restoreEnv("SIGNET_SESSION_START_TIMEOUT", previousSessionStartTimeout);
	restoreEnv("SIGNET_FETCH_TIMEOUT", previousFetchTimeout);
	restoreEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT", previousPromptSubmitTimeout);
	restoreEnv("SIGNET_DAEMON_URL", previousDaemonUrl);
	restoreEnv("SIGNET_API_KEY", previousApiKey);
	restoreEnv("SIGNET_TOKEN", previousToken);
	rmSync(tempHome, { recursive: true, force: true });
});

function connector(): TempConnector {
	return new TempConnector(tempHome);
}

function readMcpJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(mcpPath, "utf-8"));
}

describe("KimiConnector.install — config.toml hook registration", () => {
	test("creates config.toml with three [[hooks]] entries when file does not exist", async () => {
		await connector().install(tempHome);

		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(3);
		expect(content).toContain("event = 'SessionStart'");
		expect(content).toContain("event = 'UserPromptSubmit'");
		expect(content).toContain("event = 'SessionEnd'");
		expect(content).toContain("command = 'signet hook session-start -H kimi --kimi-json'");
		expect(content).toContain("command = 'signet hook user-prompt-submit -H kimi --kimi-json'");
		expect(content).toContain("command = 'signet hook session-end -H kimi'");
	});

	test("only uses allowed hook fields (event, command, timeout)", async () => {
		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		const blockLines = content
			.split("\n")
			.filter((line) => line.includes(" = "))
			.map((line) => line.split(" = ")[0].trim());
		for (const key of blockLines) {
			expect(["event", "command", "timeout"]).toContain(key);
		}
	});

	test("sets correct timeouts per event", async () => {
		await connector().install(tempHome);
		const content = readFileSync(configPath, "utf-8");

		const sessionStart = content.match(/event = 'SessionStart'\ncommand = [^\n]+\ntimeout = (\d+)/);
		const promptSubmit = content.match(/event = 'UserPromptSubmit'\ncommand = [^\n]+\ntimeout = (\d+)/);
		const sessionEnd = content.match(/event = 'SessionEnd'\ncommand = [^\n]+\ntimeout = (\d+)/);
		expect(sessionStart?.[1]).toBe("20");
		expect(promptSubmit?.[1]).toBe("7");
		expect(sessionEnd?.[1]).toBe("30");
	});

	test("idempotent: re-running install produces identical config.toml", async () => {
		await connector().install(tempHome);
		const first = readFileSync(configPath, "utf-8");

		await connector().install(tempHome);
		const second = readFileSync(configPath, "utf-8");

		expect(second).toBe(first);
		expect(second.match(/\[\[hooks\]\]/g)?.length).toBe(3);
	});

	test("preserves existing user config sections and user hooks", async () => {
		writeFileSync(
			configPath,
			[
				"model = 'kimi-k2.7'",
				"",
				"[[hooks]]",
				"event = 'PreToolUse'",
				"matcher = 'Bash'",
				"command = 'echo user-hook'",
				"timeout = 5",
				"",
			].join("\n"),
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("model = 'kimi-k2.7'");
		expect(content).toContain("matcher = 'Bash'");
		expect(content).toContain("command = 'echo user-hook'");
		expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(4);
	});

	test("preserves a TOML table following a managed hook block", async () => {
		writeFileSync(
			configPath,
			[
				"# Signet lifecycle hook (managed by signet)",
				"[[hooks]]",
				"event = 'SessionStart'",
				"command = 'signet hook session-start -H kimi --kimi-json'",
				"timeout = 20",
				"",
				"[providers]",
				"default = 'moonshot'",
				"",
				"[mcp.client]",
				"tool_call_timeout_ms = 45000",
				"",
			].join("\n"),
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[providers]\ndefault = 'moonshot'");
		expect(content).toContain("[mcp.client]\ntool_call_timeout_ms = 45000");
		expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(3);
	});

	test("refreshes stale Signet hook commands without duplicating entries", async () => {
		writeFileSync(
			configPath,
			[
				"[[hooks]]",
				"event = 'SessionStart'",
				"command = 'signet hook session-start -H kimi --kimi-json'",
				"timeout = 99",
				"",
			].join("\n"),
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(3);
		expect(content).not.toContain("timeout = 99");
	});

	test("preserves third-party commands that only mention hook subcommands", async () => {
		writeFileSync(
			configPath,
			[
				"[[hooks]]",
				"event = 'SessionStart'",
				"command = 'python ./scripts/custom.py --note \" hook session-start \"'",
				"timeout = 7",
				"",
			].join("\n"),
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("custom.py");
		expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(4);
	});

	test("prefixes hook commands with remote daemon env when SIGNET_DAEMON_URL is configured", async () => {
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850";

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain(
			"SIGNET_DAEMON_URL='http://192.168.0.60:3850' signet hook session-start -H kimi --kimi-json",
		);
		expect(content).toContain(
			"SIGNET_DAEMON_URL='http://192.168.0.60:3850' signet hook user-prompt-submit -H kimi --kimi-json",
		);
		expect(content).toContain("SIGNET_DAEMON_URL='http://192.168.0.60:3850' signet hook session-end -H kimi");
	});
});

describe("KimiConnector.install — mcp.json registration", () => {
	test("creates mcp.json with stdio signet server when file does not exist", async () => {
		await connector().install(tempHome);

		expect(existsSync(mcpPath)).toBe(true);
		const json = readMcpJson();
		expect(json.mcpServers).toEqual({ signet: { command: "signet-mcp", args: [] } });
	});

	test("merges signet server into existing mcp.json without clobbering other servers", async () => {
		writeFileSync(
			mcpPath,
			JSON.stringify({ mcpServers: { other: { command: "other-mcp", args: ["--flag"] } }, theme: "dark" }),
		);

		await connector().install(tempHome);

		const json = readMcpJson();
		expect(json.theme).toBe("dark");
		expect(json.mcpServers).toEqual({
			other: { command: "other-mcp", args: ["--flag"] },
			signet: { command: "signet-mcp", args: [] },
		});
	});

	test("idempotent: re-running install produces identical mcp.json", async () => {
		await connector().install(tempHome);
		const first = readFileSync(mcpPath, "utf-8");

		await connector().install(tempHome);

		expect(readFileSync(mcpPath, "utf-8")).toBe(first);
	});

	test("does not clobber an unparseable mcp.json", async () => {
		writeFileSync(mcpPath, "{ not valid json");

		const result = await connector().install(tempHome);

		expect(readFileSync(mcpPath, "utf-8")).toBe("{ not valid json");
		expect(result.warnings?.some((w) => w.includes("could not parse"))).toBe(true);
	});
});

describe("KimiConnector.uninstall", () => {
	test("removes Signet hooks from config.toml but keeps user entries", async () => {
		writeFileSync(
			configPath,
			["[[hooks]]", "event = 'PreToolUse'", "command = 'echo user-hook'", "timeout = 5", ""].join("\n"),
		);
		const c = connector();
		await c.install(tempHome);

		await c.uninstall();

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("echo user-hook");
		expect(content).not.toContain("-H kimi");
		expect(content.match(/\[\[hooks\]\]/g)?.length).toBe(1);
	});

	test("removes signet MCP server but keeps other servers", async () => {
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: "other-mcp" } } }));
		const c = connector();
		await c.install(tempHome);
		expect(readMcpJson().mcpServers).toHaveProperty("signet");

		await c.uninstall();

		const json = readMcpJson();
		expect(json.mcpServers).toEqual({ other: { command: "other-mcp" } });
	});

	test("drops empty mcpServers object when signet was the only server", async () => {
		const c = connector();
		await c.install(tempHome);

		await c.uninstall();

		expect(readMcpJson()).toEqual({});
	});

	test("is idempotent on repeated uninstall", async () => {
		const c = connector();
		await c.install(tempHome);
		await c.uninstall();
		const configAfter = readFileSync(configPath, "utf-8");
		const mcpAfter = readFileSync(mcpPath, "utf-8");

		await c.uninstall();

		expect(readFileSync(configPath, "utf-8")).toBe(configAfter);
		expect(readFileSync(mcpPath, "utf-8")).toBe(mcpAfter);
	});
});

describe("KimiConnector.isInstalled", () => {
	test("returns true after install and false after uninstall", async () => {
		const c = connector();
		expect(c.isInstalled()).toBe(false);

		await c.install(tempHome);
		expect(c.isInstalled()).toBe(true);

		await c.uninstall();
		expect(c.isInstalled()).toBe(false);
	});
});

describe("buildKimiHookEntries", () => {
	test("builds the three lifecycle entries with kimi-json output modes", () => {
		const entries = buildKimiHookEntries(["signet"], null);
		expect(entries.map((e) => e.event)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
		expect(entries[0]?.command).toBe("signet hook session-start -H kimi --kimi-json");
		expect(entries[1]?.command).toBe("signet hook user-prompt-submit -H kimi --kimi-json");
		expect(entries[2]?.command).toBe("signet hook session-end -H kimi");
	});

	test("honors SIGNET_SESSION_START_TIMEOUT and SIGNET_PROMPT_SUBMIT_TIMEOUT", () => {
		process.env.SIGNET_SESSION_START_TIMEOUT = "18000";
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "9000";

		const entries = buildKimiHookEntries(["signet"], null);

		expect(entries[0]?.timeout).toBe(23);
		expect(entries[1]?.timeout).toBe(11);
		expect(entries[2]?.timeout).toBe(30);
	});
});

describe("removeSignetKimiHookBlocks", () => {
	test("returns content unchanged when no signet hooks exist", () => {
		const content = "model = 'kimi-k2.7'\n\n[[hooks]]\nevent = 'PreToolUse'\ncommand = 'echo hi'\n";
		expect(removeSignetKimiHookBlocks(content)).toBe(content);
	});

	test("removes signet blocks with remote env prefixes and marker comments", () => {
		const content = [
			"model = 'kimi-k2.7'",
			"",
			"# Signet lifecycle hook (managed by signet)",
			"[[hooks]]",
			"event = 'SessionStart'",
			"command = 'SIGNET_DAEMON_URL=\\'http://10.0.0.2:3850\\' signet hook session-start -H kimi --kimi-json'",
			"timeout = 20",
			"",
			"[[hooks]]",
			"event = 'UserPromptSubmit'",
			"command = 'echo keep-me'",
			"",
		].join("\n");

		const cleaned = removeSignetKimiHookBlocks(content);

		expect(cleaned).not.toContain("-H kimi");
		expect(cleaned).not.toContain("Signet lifecycle hook");
		expect(cleaned).toContain("model = 'kimi-k2.7'");
		expect(cleaned).toContain("echo keep-me");
	});
});

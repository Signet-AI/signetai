import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseCodeConnector, buildMuseHookCommand, isSignetMuseHookCommand, readMuseSettings } from "./index";

const ENV_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"SIGNET_DAEMON_URL",
	"SIGNET_HOST",
	"SIGNET_PORT",
	"SIGNET_API_KEY",
	"SIGNET_TOKEN",
	"SIGNET_PATH",
	"SIGNET_AGENT_ID",
	"SIGNET_SESSION_START_TIMEOUT",
	"SIGNET_FETCH_TIMEOUT",
	"SIGNET_PROMPT_SUBMIT_TIMEOUT",
] as const;

let root = "";
let saved: Record<string, string | undefined> = {};

function settingsPath(): string {
	return join(root, "config", "muse", "settings.json");
}

function workspace(): string {
	return join(root, "home", ".agents");
}

function readSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(settingsPath(), "utf-8"));
}

function writeSettings(value: unknown): void {
	mkdirSync(join(root, "config", "muse"), { recursive: true });
	writeFileSync(settingsPath(), typeof value === "string" ? value : JSON.stringify(value));
}

function commands(settings: Record<string, unknown>, event: string): string[] {
	const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
	return (hooks[event] ?? []).flatMap((group) => group.hooks.map((handler) => handler.command));
}

function mcpEnv(settings: Record<string, unknown>): Record<string, string> {
	return (settings.mcp_servers as Record<string, { env: Record<string, string> }>).signet.env;
}

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
	root = mkdtempSync(join(tmpdir(), "signet-muse-"));
	process.env.HOME = join(root, "home");
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_DATA_HOME = join(root, "data");
	mkdirSync(workspace(), { recursive: true });
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("buildMuseHookCommand", () => {
	test("pins the workspace and emits hook JSON for context hooks", () => {
		expect(buildMuseHookCommand(["signet"], "session-start", { SIGNET_PATH: "/home/u/.agents" })).toBe(
			"SIGNET_PATH=/home/u/.agents signet hook session-start -H muse-code --codex-json",
		);
		expect(buildMuseHookCommand(["signet"], "session-end", { SIGNET_PATH: "/home/u/.agents" })).toBe(
			"SIGNET_PATH=/home/u/.agents signet hook session-end -H muse-code",
		);
	});

	test("quotes values that the shell would otherwise interpret", () => {
		const command = buildMuseHookCommand(["signet"], "user-prompt-submit", {
			SIGNET_DAEMON_URL: "http://10.0.0.5:4000",
			SIGNET_API_KEY: "it's $(secret)",
			SIGNET_PATH: "/srv/my agents",
		});
		expect(command).toBe(
			"SIGNET_DAEMON_URL=http://10.0.0.5:4000 SIGNET_API_KEY='it'\\''s $(secret)' SIGNET_PATH='/srv/my agents' signet hook user-prompt-submit -H muse-code --codex-json",
		);
		expect(isSignetMuseHookCommand(command)).toBe(true);
	});

	test("recognizes only whole Signet invocations for this harness", () => {
		expect(isSignetMuseHookCommand("'/opt/my tools/signet' hook session-end -H muse-code")).toBe(true);
		expect(
			isSignetMuseHookCommand(buildMuseHookCommand(["/opt/o'neil/signet"], "session-end", { SIGNET_PATH: "/a" })),
		).toBe(true);
		expect(
			isSignetMuseHookCommand("/Applications/Signet.app/Contents/MacOS/Signet hook session-end -H muse-code"),
		).toBe(true);
		expect(isSignetMuseHookCommand("signet hook session-end -H muse-code-dev")).toBe(false);
		expect(isSignetMuseHookCommand("wrapper.sh; signet hook session-end -H muse-code")).toBe(false);
		expect(isSignetMuseHookCommand("signet hook session-start -H muse-code && notify-send done")).toBe(false);
	});
});

describe("MuseCodeConnector", () => {
	test("creates an owner-only schema_version 1 settings file with hooks and an optional MCP server", async () => {
		const connector = new MuseCodeConnector();
		expect(connector.isInstalled()).toBe(false);

		const result = await connector.install(workspace());

		expect(result.success).toBe(true);
		expect(result.configsPatched).toEqual([settingsPath()]);
		expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
		const settings = readSettings();
		expect(settings.schema_version).toBe(1);
		const pin = `SIGNET_PATH=${workspace()}`;
		expect(commands(settings, "SessionStart")).toEqual([`${pin} signet hook session-start -H muse-code --codex-json`]);
		expect(commands(settings, "UserPromptSubmit")).toEqual([
			`${pin} signet hook user-prompt-submit -H muse-code --codex-json`,
		]);
		expect(commands(settings, "Stop")).toEqual([`${pin} signet hook session-end -H muse-code`]);
		expect(commands(settings, "SessionEnd")).toEqual([]);
		const signet = (settings.mcp_servers as Record<string, Record<string, unknown>>).signet;
		expect(signet.transport).toBe("stdio");
		expect(signet.mode).toBe("optional");
		expect(connector.isInstalled()).toBe(true);
	});

	test("preserves user hooks and servers and is idempotent", async () => {
		writeSettings({
			schema_version: 1,
			model: "muse-spark-1.2",
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }],
				Stop: [{ hooks: [{ type: "command", command: "signet hook session-end -H muse-code-dev" }] }],
			},
			mcp_servers: { other: { transport: "stdio", command: "other-mcp" } },
		});
		const connector = new MuseCodeConnector();

		await connector.install(workspace());
		const second = await connector.install(workspace());

		expect(second.configsPatched).toEqual([]);
		const settings = readSettings();
		expect(settings.model).toBe("muse-spark-1.2");
		expect(commands(settings, "SessionStart")).toEqual([
			"echo mine",
			`SIGNET_PATH=${workspace()} signet hook session-start -H muse-code --codex-json`,
		]);
		expect(commands(settings, "Stop")[0]).toBe("signet hook session-end -H muse-code-dev");
		expect(Object.keys(settings.mcp_servers as object).sort()).toEqual(["other", "signet"]);
	});

	test("replaces stale Signet hooks under any event on reinstall", async () => {
		writeSettings({
			schema_version: 1,
			hooks: {
				SessionEnd: [{ hooks: [{ type: "command", command: "signet hook session-end -H muse-code", timeout: 30 }] }],
			},
		});

		await new MuseCodeConnector().install(workspace());

		const settings = readSettings();
		expect(commands(settings, "SessionEnd")).toEqual([]);
		expect(commands(settings, "Stop")).toHaveLength(1);
	});

	test("refuses to touch settings Muse itself would reject", async () => {
		const connector = new MuseCodeConnector();
		for (const content of [
			'{"model":"x"}',
			"{not json",
			'{"schema_version":2}',
			'{"schema_version":1,"hooks":[]}',
			'{"schema_version":1,"hooks":{"PreToolUse":["junk"]}}',
			'{"schema_version":1,"hooks":{"Stop":{"hooks":[]}}}',
			'{"schema_version":1,"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true","timeout":"5"}]}]}}',
		]) {
			writeSettings(content);
			const result = await connector.install(workspace());
			expect(result.success).toBe(false);
			expect(readFileSync(settingsPath(), "utf-8")).toBe(content);
		}
		expect(readMuseSettings(settingsPath()).kind).toBe("invalid");
	});

	test("uninstall removes only Signet entries", async () => {
		writeSettings({
			schema_version: 1,
			hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
			mcp_servers: { other: { transport: "stdio", command: "other-mcp" } },
		});
		const connector = new MuseCodeConnector();
		await connector.install(workspace());

		const result = await connector.uninstall();

		expect(result.configsPatched).toEqual([settingsPath()]);
		expect(readSettings()).toEqual({
			schema_version: 1,
			hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
			mcp_servers: { other: { transport: "stdio", command: "other-mcp" } },
		});
		expect(connector.isInstalled()).toBe(false);
	});

	test("uninstall fails loudly on a file it cannot parse and still reports it installed", async () => {
		const connector = new MuseCodeConnector();
		await connector.install(workspace());
		const broken = `${readFileSync(settingsPath(), "utf-8")}{`;
		writeFileSync(settingsPath(), broken);

		await expect(connector.uninstall()).rejects.toThrow("Cannot remove Signet entries");
		expect(readFileSync(settingsPath(), "utf-8")).toBe(broken);
		expect(connector.isInstalled()).toBe(true);
	});

	test("gives hooks and the MCP server the same daemon, workspace, and timeouts", async () => {
		process.env.SIGNET_PORT = "4123";
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "9000";
		const custom = join(root, "custom-agents");
		mkdirSync(custom, { recursive: true });

		const result = await new MuseCodeConnector().install(custom);

		const settings = readSettings();
		const env = `SIGNET_DAEMON_URL=http://127.0.0.1:4123 SIGNET_PATH=${custom} SIGNET_PROMPT_SUBMIT_TIMEOUT=9000`;
		expect(commands(settings, "SessionStart")).toEqual([`${env} signet hook session-start -H muse-code --codex-json`]);
		expect(mcpEnv(settings)).toMatchObject({
			SIGNET_DAEMON_URL: "http://127.0.0.1:4123",
			SIGNET_PATH: custom,
			SIGNET_PROMPT_SUBMIT_TIMEOUT: "9000",
		});
		expect(result.warnings?.some((warning) => warning.includes("skills"))).toBe(true);
	});

	test("resolves a relative workspace once for hooks and MCP", async () => {
		const previous = process.cwd();
		process.chdir(root);
		try {
			await new MuseCodeConnector().install("./rel-agents");
		} finally {
			process.chdir(previous);
		}

		const settings = readSettings();
		expect(mcpEnv(settings).SIGNET_PATH).toBe(join(root, "rel-agents"));
		expect(commands(settings, "Stop")[0]).toStartWith(`SIGNET_PATH=${join(root, "rel-agents")} `);
	});

	test("refuses a non-default agent the hooks cannot carry", async () => {
		process.env.SIGNET_AGENT_ID = "agent-x";

		const result = await new MuseCodeConnector().install(workspace());

		expect(result.success).toBe(false);
		expect(result.message).toContain("agent-x");
		expect(() => readFileSync(settingsPath())).toThrow();
	});

	test("writes through a symlinked settings file", async () => {
		const real = join(root, "dotfiles", "muse-settings.json");
		mkdirSync(join(root, "dotfiles"), { recursive: true });
		writeFileSync(real, '{"schema_version":1}');
		mkdirSync(join(root, "config", "muse"), { recursive: true });
		symlinkSync(real, settingsPath());

		await new MuseCodeConnector().install(workspace());

		expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
		expect(commands(JSON.parse(readFileSync(real, "utf-8")), "Stop")).toHaveLength(1);
	});

	test("detects Muse from its config or data directory", () => {
		const connector = new MuseCodeConnector();
		expect(connector.isDetected()).toBe(false);
		mkdirSync(join(root, "data", "muse"), { recursive: true });
		expect(connector.isDetected()).toBe(true);
	});
});

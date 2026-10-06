import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MuseCodeConnector, buildMuseHookCommand, readMuseSettings } from "./index";

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
] as const;

let root = "";
let saved: Record<string, string | undefined> = {};

function settingsPath(): string {
	return join(root, "config", "muse", "settings.json");
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

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
	root = mkdtempSync(join(tmpdir(), "signet-muse-"));
	process.env.HOME = join(root, "home");
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_DATA_HOME = join(root, "data");
	mkdirSync(join(root, "home", ".agents"), { recursive: true });
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
	test("pins the workspace and omits default daemon settings", () => {
		expect(buildMuseHookCommand(["signet"], "session-start", { signetPath: "/home/u/.agents" })).toBe(
			"SIGNET_PATH=/home/u/.agents signet hook session-start -H muse-code --codex-json",
		);
	});

	test("carries non-default settings inside the command because Muse clears hook env", () => {
		const command = buildMuseHookCommand(["signet"], "user-prompt-submit", {
			daemonUrl: "http://10.0.0.5:4000",
			apiKey: "it's secret",
			signetPath: "/srv/my agents",
		});
		expect(command).toBe(
			"SIGNET_DAEMON_URL=http://10.0.0.5:4000 SIGNET_API_KEY='it'\\''s secret' SIGNET_PATH='/srv/my agents' signet hook user-prompt-submit -H muse-code --codex-json",
		);
	});
});

describe("MuseCodeConnector", () => {
	test("creates a schema_version 1 settings file with hooks and an optional MCP server", async () => {
		const connector = new MuseCodeConnector();
		expect(connector.isInstalled()).toBe(false);

		const result = await connector.install(join(root, "home", ".agents"));

		expect(result.success).toBe(true);
		expect(result.configsPatched).toEqual([settingsPath()]);
		const settings = readSettings();
		expect(settings.schema_version).toBe(1);
		const pin = `SIGNET_PATH=${join(root, "home", ".agents")}`;
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
			hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }] },
			mcp_servers: { other: { transport: "stdio", command: "other-mcp" } },
		});
		const connector = new MuseCodeConnector();

		await connector.install(join(root, "home", ".agents"));
		const second = await connector.install(join(root, "home", ".agents"));

		expect(second.configsPatched).toEqual([]);
		const settings = readSettings();
		expect(settings.model).toBe("muse-spark-1.2");
		expect(commands(settings, "SessionStart")).toEqual([
			"echo mine",
			`SIGNET_PATH=${join(root, "home", ".agents")} signet hook session-start -H muse-code --codex-json`,
		]);
		expect(Object.keys(settings.mcp_servers as object).sort()).toEqual(["other", "signet"]);
	});

	test("replaces stale Signet hooks under any event on reinstall", async () => {
		writeSettings({
			schema_version: 1,
			hooks: {
				SessionEnd: [{ hooks: [{ type: "command", command: "signet hook session-end -H muse-code", timeout: 30 }] }],
			},
		});

		await new MuseCodeConnector().install(join(root, "home", ".agents"));

		const settings = readSettings();
		expect(commands(settings, "SessionEnd")).toEqual([]);
		expect(commands(settings, "Stop")).toHaveLength(1);
	});

	test("refuses to touch settings Muse itself would reject", async () => {
		const connector = new MuseCodeConnector();
		for (const content of ['{"model":"x"}', "{not json", '{"schema_version":2}', '{"schema_version":1,"hooks":[]}']) {
			writeSettings(content);
			const result = await connector.install(join(root, "home", ".agents"));
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
		await connector.install(join(root, "home", ".agents"));

		const result = await connector.uninstall();

		expect(result.configsPatched).toEqual([settingsPath()]);
		expect(readSettings()).toEqual({
			schema_version: 1,
			hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }] },
			mcp_servers: { other: { transport: "stdio", command: "other-mcp" } },
		});
		expect(connector.isInstalled()).toBe(false);
	});

	test("bakes a non-default daemon address and workspace into hooks and MCP env", async () => {
		process.env.SIGNET_PORT = "4123";
		const workspace = join(root, "custom-agents");
		mkdirSync(workspace, { recursive: true });

		const result = await new MuseCodeConnector().install(workspace);

		const settings = readSettings();
		expect(commands(settings, "SessionStart")).toEqual([
			`SIGNET_DAEMON_URL=http://127.0.0.1:4123 SIGNET_PATH=${workspace} signet hook session-start -H muse-code --codex-json`,
		]);
		const signet = (settings.mcp_servers as Record<string, { env: Record<string, string> }>).signet;
		expect(signet.env.SIGNET_PATH).toBe(workspace);
		expect(result.warnings?.some((warning) => warning.includes("skills"))).toBe(true);
	});

	test("detects Muse from its config or data directory", () => {
		const connector = new MuseCodeConnector();
		expect(connector.isDetected()).toBe(false);
		mkdirSync(join(root, "data", "muse"), { recursive: true });
		expect(connector.isDetected()).toBe(true);
	});
});

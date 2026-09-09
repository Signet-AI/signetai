/**
 * Integration tests for CodexConnector MCP config.toml management.
 *
 * Tests exercise real production code via CodexConnector.install() and
 * CodexConnector.uninstall(). A subclass redirects getCodexHome() to a
 * temp directory so the real ~/.codex is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexConnector, buildHooksFile, buildMcpBlock, resolveCodexCli, resolveCodexDesktopNode } from "./index.js";

class TempConnector extends CodexConnector {
	constructor(private home: string) {
		super();
	}
	protected override getCodexHome(): string {
		return join(this.home, ".codex");
	}
	protected override supportsNativePluginInstall(): boolean {
		return false;
	}
}

class DesktopRuntimeTempConnector extends TempConnector {
	constructor(
		home: string,
		private appPath: string,
		private runtime?: string,
	) {
		super(home);
	}
	protected override getCodexDesktopAppPaths(): readonly string[] {
		return [this.appPath];
	}
	protected override resolveCodexDesktopNode(): string | null {
		return this.runtime
			? resolveCodexDesktopNode([this.appPath], (path) => path === this.runtime)
			: super.resolveCodexDesktopNode();
	}
}

class NativePluginTempConnector extends TempConnector {
	protected override supportsNativePluginInstall(): boolean {
		return true;
	}
	protected override installNativePlugin(codexHome: string): { success: boolean; filesWritten: readonly string[] } {
		const installedRoot = join(codexHome, "plugins", "cache", "signet-local", "signet", "0.1.0");
		mkdirSync(installedRoot, { recursive: true });
		if (!readFileIfExists(this.getConfigPath()).includes('[plugins."signet@signet-local"]')) {
			writeFileSync(
				this.getConfigPath(),
				`${readFileIfExists(this.getConfigPath())}\n[marketplaces.signet-local]\nsource_type = 'local'\nsource = '/tmp/signet-plugin-marketplace'\n\n[plugins."signet@signet-local"]\nenabled = true\n`,
			);
		}
		return { success: true, filesWritten: [installedRoot] };
	}
	protected override removeNativePlugin(codexHome: string): void {
		rmSync(join(codexHome, "plugins", "cache", "signet-local", "signet"), { recursive: true, force: true });
	}
}

function readFileIfExists(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8").trimEnd() : "";
}

function tomlBasicString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hookStateHeader(event: string): string {
	return `[hooks.state."${tomlBasicString(hooksPath)}:${event}:0:0"]`;
}

function selectedHookCommand(handler: Record<string, unknown>): string {
	const command = process.platform === "win32" ? handler.commandWindows : handler.command;
	if (typeof command !== "string") throw new Error("Expected a string Codex hook command");
	return command;
}

class NativePluginFailingTempConnector extends TempConnector {
	protected override supportsNativePluginInstall(): boolean {
		return true;
	}
	protected override installNativePlugin(): { success: boolean; filesWritten: readonly string[]; warning: string } {
		return { success: false, filesWritten: [], warning: "native plugin add failed in test" };
	}
}

class NativePluginCommandTempConnector extends TempConnector {
	constructor(
		home: string,
		private codexCommand: string,
	) {
		super(home);
	}
	protected override resolveCodexCli(): string {
		return this.codexCommand;
	}
	protected override supportsNativePluginInstall(): boolean {
		return true;
	}
}

class NativePluginConfigParsingTempConnector extends TempConnector {
	protected override supportsNativePluginInstall(): boolean {
		return true;
	}
	protected override installNativePlugin(codexHome: string): {
		success: boolean;
		filesWritten: readonly string[];
		warning?: string;
	} {
		if (readFileSync(this.getConfigPath(), "utf-8").includes("[mcp_servers.signet]")) {
			return { success: false, filesWritten: [], warning: "codex refused stale mcp_servers.signet" };
		}
		const installedRoot = join(codexHome, "plugins", "cache", "signet-local", "signet", "0.1.0");
		mkdirSync(installedRoot, { recursive: true });
		if (!readFileIfExists(this.getConfigPath()).includes('[plugins."signet@signet-local"]')) {
			writeFileSync(
				this.getConfigPath(),
				`${readFileIfExists(this.getConfigPath())}\n[marketplaces.signet-local]\nsource_type = 'local'\nsource = '/tmp/signet-plugin-marketplace'\n\n[plugins."signet@signet-local"]\nenabled = true\n`,
			);
		}
		return { success: true, filesWritten: [installedRoot] };
	}
}

let tempHome: string;
let codexDir: string;
let configPath: string;
let hooksPath: string;
let previousSessionStartTimeout: string | undefined;
let previousFetchTimeout: string | undefined;
let previousPromptSubmitTimeout: string | undefined;
let previousDaemonUrl: string | undefined;
let previousApiKey: string | undefined;
let previousToken: string | undefined;
let previousForceCompatHooks: string | undefined;
let previousWrapperDir: string | undefined;
let previousCodexHome: string | undefined;
let previousArgvEntry: string | undefined;
let previousExecPath: string;

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
	previousForceCompatHooks = process.env.SIGNET_CODEX_FORCE_COMPAT_HOOKS;
	previousWrapperDir = process.env.SIGNET_WRAPPER_DIR;
	previousCodexHome = process.env.CODEX_HOME;
	previousArgvEntry = process.argv[1];
	previousExecPath = process.execPath;
	Reflect.deleteProperty(process.env, "SIGNET_SESSION_START_TIMEOUT");
	Reflect.deleteProperty(process.env, "SIGNET_FETCH_TIMEOUT");
	Reflect.deleteProperty(process.env, "SIGNET_PROMPT_SUBMIT_TIMEOUT");
	Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
	Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
	Reflect.deleteProperty(process.env, "SIGNET_TOKEN");
	Reflect.deleteProperty(process.env, "SIGNET_CODEX_FORCE_COMPAT_HOOKS");
	Reflect.deleteProperty(process.env, "SIGNET_WRAPPER_DIR");
	Reflect.deleteProperty(process.env, "CODEX_HOME");
	tempHome = join(tmpdir(), `signet-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	codexDir = join(tempHome, ".codex");
	configPath = join(codexDir, "config.toml");
	hooksPath = join(codexDir, "hooks.json");
	mkdirSync(codexDir, { recursive: true });
});

afterEach(() => {
	restoreEnv("SIGNET_SESSION_START_TIMEOUT", previousSessionStartTimeout);
	restoreEnv("SIGNET_FETCH_TIMEOUT", previousFetchTimeout);
	restoreEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT", previousPromptSubmitTimeout);
	restoreEnv("SIGNET_DAEMON_URL", previousDaemonUrl);
	restoreEnv("SIGNET_API_KEY", previousApiKey);
	restoreEnv("SIGNET_TOKEN", previousToken);
	restoreEnv("SIGNET_CODEX_FORCE_COMPAT_HOOKS", previousForceCompatHooks);
	restoreEnv("SIGNET_WRAPPER_DIR", previousWrapperDir);
	restoreEnv("CODEX_HOME", previousCodexHome);
	if (previousArgvEntry === undefined) process.argv.splice(1, 1);
	else process.argv[1] = previousArgvEntry;
	process.execPath = previousExecPath;
	rmSync(tempHome, { recursive: true, force: true });
});

function connector(): TempConnector {
	return new TempConnector(tempHome);
}

function desktopRuntimeConnector(appPath: string, runtime?: string): TempConnector {
	return new DesktopRuntimeTempConnector(tempHome, appPath, runtime);
}

function nativePluginConnector(): TempConnector {
	return new NativePluginTempConnector(tempHome);
}

function failingNativePluginConnector(): TempConnector {
	return new NativePluginFailingTempConnector(tempHome);
}

function nativePluginCommandConnector(codexCommand: string): TempConnector {
	return new NativePluginCommandTempConnector(tempHome, codexCommand);
}

function configParsingNativePluginConnector(): TempConnector {
	return new NativePluginConfigParsingTempConnector(tempHome);
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
		expect(content).not.toContain("disabled_tools");
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

	test("removes stale disabled_tools from existing signet entry on re-install", async () => {
		writeFileSync(
			configPath,
			[
				"[model]",
				'name = "gpt-4o"',
				"",
				"# Signet MCP server",
				"[mcp_servers.signet]",
				"command = 'signet-mcp'",
				"disabled_tools = ['memory_search', 'memory_store']",
				"",
				"[history]",
				"enabled = true",
				"",
			].join("\n"),
		);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).toContain("[history]");
		expect(content).toContain("command = 'signet-mcp'");
		expect(content).not.toContain("disabled_tools");
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

	test("trusts and enables generated Signet lifecycle hooks", async () => {
		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		const prefix = `[hooks.state."${tomlBasicString(hooksPath)}:`;
		expect(content).toContain(`${prefix}session_start:0:0"]`);
		expect(content).toMatch(/trusted_hash = 'sha256:[0-9a-f]{64}'/);
		expect(content).toContain(`${prefix}user_prompt_submit:0:0"]`);
		expect(content).toContain(`${prefix}stop:0:0"]`);
		expect(content).toContain(`${prefix}pre_tool_use:0:0"]`);
		expect(content.match(/trusted_hash = 'sha256:[0-9a-f]{64}'/g)?.length).toBe(4);
		expect(content.match(/enabled = true/g)?.length).toBe(4);
	});

	test("repairs disabled Signet hook state on reinstall", async () => {
		await connector().install(tempHome);
		const userPromptState = hookStateHeader("user_prompt_submit");
		const disabled = readFileSync(configPath, "utf-8").replace(
			`${userPromptState}\nenabled = true`,
			`${userPromptState}\nenabled = false`,
		);
		writeFileSync(configPath, disabled);

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain(`${userPromptState}\nenabled = true`);
		expect(content).not.toContain(`${userPromptState}\nenabled = false`);
		expect(content.match(new RegExp(userPromptState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
	});

	test("uses remote HTTP MCP URL when SIGNET_DAEMON_URL is configured", async () => {
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850";

		await connector().install(tempHome);

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).toContain("url = 'http://192.168.0.60:3850/mcp'");
		expect(content).toContain("startup_timeout_sec = 10");
		expect(content).toContain("tool_timeout_sec = 30");
		expect(content).not.toContain("disabled_tools");
		expect(content).not.toContain("command = 'signet-mcp'");
	});

	test("removes stale remote MCP auth header tables on reinstall without an API key", async () => {
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850";
		process.env.SIGNET_API_KEY = "sig_sk_codex_old_secret";

		await connector().install(tempHome);
		let content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[mcp_servers.signet.http_headers]");
		expect(content).toContain("Authorization = 'Bearer sig_sk_codex_old_secret'");

		Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
		await connector().install(tempHome);

		content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[mcp_servers.signet]");
		expect(content).not.toContain("[mcp_servers.signet.http_headers]");
		expect(content).not.toContain("sig_sk_codex_old_secret");
	});

	test("still writes Codex lifecycle hooks when remote HTTP MCP is configured", async () => {
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850/";

		const result = await connector().install(tempHome);

		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];
		const promptHandler = (
			(hooks.UserPromptSubmit[0] as Record<string, unknown>).hooks as Record<string, unknown>[]
		)[0];
		const stopHandler = ((hooks.Stop[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];

		if (process.platform === "win32") {
			for (const [handler, subcommand] of [
				[startHandler, "session-start"],
				[promptHandler, "user-prompt-submit"],
				[stopHandler, "session-end"],
			] as const) {
				expect(selectedHookCommand(handler)).toMatch(
					new RegExp(`signet-codex-hook-[0-9a-f]{16}\\.cmd.*hook ${subcommand}`),
				);
			}
			const wrapper = result.filesWritten.find((path) => path.toLowerCase().endsWith(".cmd"));
			expect(wrapper).toBeDefined();
			expect(readFileSync(wrapper as string, "utf-8")).toContain('set "SIGNET_DAEMON_URL=http://192.168.0.60:3850"');
		} else {
			expect(selectedHookCommand(startHandler)).toBe(
				"SIGNET_DAEMON_URL='http://192.168.0.60:3850' signet hook session-start -H codex --codex-json",
			);
			expect(selectedHookCommand(promptHandler)).toBe(
				"SIGNET_DAEMON_URL='http://192.168.0.60:3850' signet hook user-prompt-submit -H codex --codex-json",
			);
			expect(selectedHookCommand(stopHandler)).toBe(
				"SIGNET_DAEMON_URL='http://192.168.0.60:3850' signet hook session-end -H codex",
			);
		}
	});

	test("remote lifecycle hooks remain idempotent across repeated installs", async () => {
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850/";

		await connector().install(tempHome);
		await connector().install(tempHome);

		const hooks = readHooksJson().hooks as Record<string, Record<string, unknown>[]>;
		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	test("rejects unsafe remote daemon URLs before writing Codex config", async () => {
		process.env.SIGNET_DAEMON_URL = 'http://192.168.0.60:3850/" && calc';

		await expect(connector().install(tempHome)).rejects.toThrow("SIGNET_DAEMON_URL must point at the daemon origin");

		expect(existsSync(configPath)).toBe(false);
	});
});

describe("CodexConnector.install — native plugin bundle", () => {
	test("installs a local Codex plugin marketplace when plugin support is available", async () => {
		const result = await nativePluginConnector().install(tempHome);

		const marketplacePath = join(
			codexDir,
			".tmp",
			"signet-plugin-marketplace",
			".agents",
			"plugins",
			"marketplace.json",
		);
		const pluginManifestPath = join(
			codexDir,
			".tmp",
			"signet-plugin-marketplace",
			"plugins",
			"signet",
			".codex-plugin",
			"plugin.json",
		);
		const mcpPath = join(codexDir, ".tmp", "signet-plugin-marketplace", "plugins", "signet", ".mcp.json");
		const pluginHooksPath = join(
			codexDir,
			".tmp",
			"signet-plugin-marketplace",
			"plugins",
			"signet",
			"hooks",
			"hooks.json",
		);
		expect(existsSync(marketplacePath)).toBe(true);
		expect(existsSync(pluginManifestPath)).toBe(true);
		expect(existsSync(mcpPath)).toBe(true);
		expect(codexHookContractErrors(JSON.parse(readFileSync(pluginHooksPath, "utf-8")))).toEqual([]);
		expect(result.filesWritten).toContain(pluginManifestPath);

		const config = readFileSync(configPath, "utf-8");
		expect(config).toContain("[marketplaces.signet-local]");
		expect(config).toContain('[plugins."signet@signet-local"]');
		expect(config).toContain("enabled = true");
		expect(config).not.toContain("[mcp_servers.signet]");
		expect(config).not.toContain(`[hooks.state."${hooksPath}:`);
		expect(existsSync(hooksPath)).toBe(false);

		const plugin = JSON.parse(readFileSync(pluginManifestPath, "utf-8")) as {
			mcpServers?: string;
			skills?: string;
			hooks?: string;
		};
		expect(plugin.mcpServers).toBe("./.mcp.json");
		expect(plugin.skills).toBe("./skills/");
		expect(plugin.hooks).toBeUndefined();
	});

	test("native plugin install remains idempotent", async () => {
		await nativePluginConnector().install(tempHome);
		const firstConfig = readFileSync(configPath, "utf-8");
		await nativePluginConnector().install(tempHome);

		expect(readFileSync(configPath, "utf-8")).toBe(firstConfig);
		expect(firstConfig.match(/\[plugins\."signet@signet-local"\]/g)).toHaveLength(1);
		expect(firstConfig.match(/\[marketplaces\.signet-local\]/g)).toHaveLength(1);
	});

	test("registers the generated marketplace before installing the native plugin", async () => {
		if (process.platform === "win32") return;
		const logPath = join(tempHome, "codex-commands.log");
		const fakeCodex = join(tempHome, "fake-codex");
		writeFileSync(
			fakeCodex,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${logPath}'`,
				'case "$1 $2" in',
				'  "plugin marketplace") exit 0 ;;',
				'  "plugin add") echo "Installed plugin root: /fake/signet" ;;',
				"esac",
			].join("\n"),
			"utf-8",
		);
		chmodSync(fakeCodex, 0o755);

		await nativePluginCommandConnector(fakeCodex).install(tempHome);

		const calls = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(calls[0]).toStartWith("plugin marketplace add ");
		expect(calls[1]).toBe("plugin add signet@signet-local");
	});

	test("native plugin install removes stale compatibility Signet hooks", async () => {
		await connector().install(tempHome);
		expect(existsSync(hooksPath)).toBe(true);
		expect(readFileSync(configPath, "utf-8")).toContain(hookStateHeader("user_prompt_submit"));

		await nativePluginConnector().install(tempHome);

		const config = readFileSync(configPath, "utf-8");
		expect(config).toContain('[plugins."signet@signet-local"]');
		expect(config).not.toContain("[mcp_servers.signet]");
		expect(config).not.toContain(`[hooks.state."${tomlBasicString(hooksPath)}:`);
		expect(existsSync(hooksPath)).toBe(false);
	});

	test("can force compatibility hooks when native plugin hooks are unavailable", async () => {
		process.env.SIGNET_CODEX_FORCE_COMPAT_HOOKS = "1";

		const result = await nativePluginConnector().install(tempHome);

		const config = readFileSync(configPath, "utf-8");
		expect(result.warnings).toContain(
			"Codex plugin support detected, but lifecycle hooks still require the compatibility hooks.json path in this Codex version",
		);
		expect(config).toContain(hookStateHeader("user_prompt_submit"));
		expect(existsSync(hooksPath)).toBe(true);
		expect(config).not.toContain("[mcp_servers.signet]");
	});

	test("removes stale compatibility MCP before native plugin add reads Codex config", async () => {
		writeFileSync(
			configPath,
			[
				"[model]",
				'name = "gpt-5.4-mini"',
				"",
				"[mcp_servers.signet]",
				"transport = 'sse'",
				"command = 'signet-mcp'",
				"",
			].join("\n"),
		);

		const result = await configParsingNativePluginConnector().install(tempHome);

		const config = readFileSync(configPath, "utf-8");
		expect(result.message).toBe("Codex integration installed — native plugin bundle");
		expect(result.warnings).not.toContain("codex refused stale mcp_servers.signet");
		expect(config).toContain('[plugins."signet@signet-local"]');
		expect(config).not.toContain("[mcp_servers.signet]");
		expect(config).not.toContain("transport = 'sse'");
	});

	test("falls back to compatibility hooks and MCP when native plugin add fails", async () => {
		const result = await failingNativePluginConnector().install(tempHome);

		const config = readFileSync(configPath, "utf-8");
		expect(result.message).toBe("Codex integration installed — native hooks + MCP server");
		expect(result.warnings).toContain("native plugin add failed in test");
		expect(config).toContain("[mcp_servers.signet]");
		expect(config).not.toContain('[plugins."signet@signet-local"]');
		expect(config).not.toContain("[marketplaces.signet-local]");
		expect(existsSync(hooksPath)).toBe(true);
	});

	test("uninstall removes native plugin registration without deleting Codex memories", async () => {
		const c = nativePluginConnector();
		await c.install(tempHome);
		const nativeMemory = join(codexDir, "memories", "extensions", "ad_hoc", "notes", "keep.md");
		mkdirSync(join(nativeMemory, ".."), { recursive: true });
		writeFileSync(nativeMemory, "Keep this Codex-owned note.\n");
		const pluginCache = join(codexDir, "plugins", "cache", "signet-local", "signet");
		expect(existsSync(pluginCache)).toBe(true);

		await c.uninstall();

		const config = readFileSync(configPath, "utf-8");
		expect(config).not.toContain('[plugins."signet@signet-local"]');
		expect(config).not.toContain("[marketplaces.signet-local]");
		expect(existsSync(pluginCache)).toBe(false);
		expect(existsSync(join(codexDir, ".tmp", "signet-plugin-marketplace"))).toBe(false);
		expect(readFileSync(nativeMemory, "utf-8")).toBe("Keep this Codex-owned note.\n");
	});
});

describe("CodexConnector.uninstall — config.toml cleanup", () => {
	test("removes signet section from config.toml", async () => {
		const c = connector();
		await c.install(tempHome);
		expect(readFileSync(configPath, "utf-8")).toContain("[mcp_servers.signet]");
		expect(readFileSync(configPath, "utf-8")).toContain("[hooks.state.");

		await c.uninstall();

		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content).not.toContain("[mcp_servers.signet]");
		expect(content).not.toContain("[hooks.state.");
	});

	test("removes native plugin descendant tables without touching other config", async () => {
		writeFileSync(
			configPath,
			[
				"[model]",
				'name = "gpt-4o"',
				"",
				"[marketplaces.signet-local]",
				"source_type = 'local'",
				"",
				'[plugins."signet@signet-local"]',
				"enabled = true",
				"",
				'[plugins."signet@signet-local".metadata]',
				"managed = true",
				"",
				"[history]",
				"enabled = true",
				"",
			].join("\n"),
		);

		await connector().uninstall();

		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("[model]");
		expect(content).toContain("[history]");
		expect(content).not.toContain("[marketplaces.signet-local]");
		expect(content).not.toContain('[plugins."signet@signet-local"]');
		expect(content).not.toContain("managed = true");
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
		expect(block).not.toContain("disabled_tools");
		expect(block).not.toContain("command = [");
	});

	test("uses remote HTTP MCP without disabling memory tools", () => {
		const block = buildMcpBlock({
			url: "https://signet.example.com:3850/mcp",
			startupTimeoutSec: 10,
			toolTimeoutSec: 30,
		});

		expect(block).toContain("url = 'https://signet.example.com:3850/mcp'");
		expect(block).not.toContain("disabled_tools");
	});

	test("persists HTTP authorization header for remote MCP", () => {
		const block = buildMcpBlock({
			url: "https://signet.example.com:3850/mcp",
			startupTimeoutSec: 10,
			toolTimeoutSec: 30,
			httpHeaders: { Authorization: "Bearer sig_sk_codex_test_secret" },
		});

		expect(block).toContain("[mcp_servers.signet.http_headers]");
		expect(block).toContain("Authorization = 'Bearer sig_sk_codex_test_secret'");
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

	test("includes environment for an absolute native MCP worker", () => {
		const block = buildMcpBlock({
			command: "/Users/example/.local/bin/signet",
			args: [],
			env: { SIGNET_MCP_STDIO_WORKER: "1" },
		});

		expect(block).toContain("[mcp_servers.signet.env]");
		expect(block).toContain("SIGNET_MCP_STDIO_WORKER = '1'");
	});
});

// ---------------------------------------------------------------------------
// hooks.json regression tests (issue #481)
// ---------------------------------------------------------------------------

function readHooksJson(): Record<string, unknown> {
	return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

const CODEX_HOOK_EVENTS = new Set([
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"SubagentStart",
	"SubagentStop",
	"Stop",
]);

function codexHookContractErrors(value: unknown): string[] {
	const errors: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return ["root must be an object"];
	const root = value as Record<string, unknown>;
	for (const key of Object.keys(root)) {
		if (key !== "description" && key !== "hooks") errors.push(`unknown root field: ${key}`);
	}
	if (root.description !== undefined && typeof root.description !== "string")
		errors.push("description must be a string");
	if (typeof root.hooks !== "object" || root.hooks === null || Array.isArray(root.hooks)) {
		errors.push("hooks must be an object");
		return errors;
	}
	for (const [event, groups] of Object.entries(root.hooks as Record<string, unknown>)) {
		if (!CODEX_HOOK_EVENTS.has(event)) errors.push(`unknown hook event: ${event}`);
		if (!Array.isArray(groups)) {
			errors.push(`${event} must be an array`);
			continue;
		}
		for (const [groupIndex, group] of groups.entries()) {
			if (typeof group !== "object" || group === null || Array.isArray(group)) {
				errors.push(`${event}[${groupIndex}] must be an object`);
				continue;
			}
			const matcherGroup = group as Record<string, unknown>;
			for (const key of Object.keys(matcherGroup)) {
				if (key !== "matcher" && key !== "hooks") errors.push(`unknown matcher field: ${event}[${groupIndex}].${key}`);
			}
			if (!Array.isArray(matcherGroup.hooks)) errors.push(`${event}[${groupIndex}].hooks must be an array`);
		}
	}
	return errors;
}

describe("CodexConnector.install — hooks.json schema", () => {
	test("contract fixture rejects private ownership fields", () => {
		const errors = codexHookContractErrors({
			_signet: true,
			hooks: { SessionStart: [{ _signet: true, hooks: [] }] },
		});

		expect(errors).toContain("unknown root field: _signet");
		expect(errors).toContain("unknown matcher field: SessionStart[0]._signet");
	});

	test("writes hooks under a top-level 'hooks' key with PascalCase event names", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		expect(codexHookContractErrors(json)).toEqual([]);

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
		expect(handler.command as string).toContain("--codex-json");
		expect(handler.timeout).toBe(20);
	});

	test("sets correct timeouts per event", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;

		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];
		expect(startHandler.timeout).toBe(20);

		const promptHandler = (
			(hooks.UserPromptSubmit[0] as Record<string, unknown>).hooks as Record<string, unknown>[]
		)[0];
		expect(promptHandler.timeout).toBe(7);

		const stopHandler = ((hooks.Stop[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];
		expect(stopHandler.timeout).toBe(30);
	});

	test("sets Codex session-start timeout to Signet timeout plus grace", async () => {
		process.env.SIGNET_SESSION_START_TIMEOUT = "18000";

		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];

		expect(startHandler.timeout).toBe(23);
	});

	test("sets Codex prompt-submit timeout to Signet timeout plus grace", async () => {
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "9000";

		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const promptHandler = (
			(hooks.UserPromptSubmit[0] as Record<string, unknown>).hooks as Record<string, unknown>[]
		)[0];

		expect(promptHandler.timeout).toBe(11);
	});

	test("refreshes existing Signet-owned hooks to current timeouts", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				_signet: true,
				hooks: {
					SessionStart: [
						{ _signet: true, hooks: [{ type: "command", command: "signet hook session-start -H codex", timeout: 10 }] },
					],
					UserPromptSubmit: [
						{
							_signet: true,
							hooks: [{ type: "command", command: "signet hook user-prompt-submit -H codex", timeout: 5 }],
						},
					],
					Stop: [
						{ _signet: true, hooks: [{ type: "command", command: "signet hook session-end -H codex", timeout: 30 }] },
					],
				},
			}),
		);

		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];

		expect(codexHookContractErrors(json)).toEqual([]);
		expect(startHandler.timeout).toBe(20);
	});

	test("preserves the schema-supported description when refreshing Signet hooks", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				_signet: true,
				description: "third-party hooks",
				hooks: {
					SessionStart: [
						{ _signet: true, hooks: [{ type: "command", command: "signet hook session-start -H codex", timeout: 10 }] },
					],
				},
			}),
		);

		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];

		expect(json.description).toBe("third-party hooks");
		expect(json._signet).toBeUndefined();
		expect(codexHookContractErrors(json)).toEqual([]);
		expect(startHandler.timeout).toBe(20);
	});

	test("refreshes node-shim Signet hook commands without duplicating entries", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "/usr/bin/node /tmp/signet/bin/signet.js hook session-start -H codex",
									timeout: 10,
								},
							],
						},
					],
				},
			}),
		);

		await connector().install(tempHome);
		const json = readHooksJson();
		expect(JSON.stringify(json)).not.toContain('"_signet"');
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const startGroups = hooks.SessionStart;
		const signetHandlers = startGroups.flatMap((group) =>
			((group as Record<string, unknown>).hooks as Record<string, unknown>[]).filter((handler) =>
				(handler.command as string).includes("hook session-start"),
			),
		);

		expect(signetHandlers.length).toBe(1);
		expect(signetHandlers[0]?.timeout).toBe(20);
	});

	test("migrates a stale Codex Desktop MCP runtime path after a packaging update", async () => {
		const appPath = join(tempHome, "Applications", "Codex.app");
		const runtime = join(appPath, "Contents", "Resources", "runtime", "node", "bin", "node");
		mkdirSync(join(runtime, ".."), { recursive: true });
		writeFileSync(runtime, "#!/bin/sh\necho v22.14.0\n", "utf-8");
		chmodSync(runtime, 0o755);

		const packageRoot = join(tempHome, "signetai");
		const signetEntry = join(packageRoot, "bin", "signet.js");
		const mcpEntry = join(packageRoot, "dist", "mcp-stdio.js");
		mkdirSync(join(signetEntry, ".."), { recursive: true });
		mkdirSync(join(mcpEntry, ".."), { recursive: true });
		writeFileSync(signetEntry, "// fixture\n", "utf-8");
		writeFileSync(mcpEntry, "// fixture\n", "utf-8");
		const signetBinary = join(packageRoot, "bin", "signet");
		writeFileSync(signetBinary, "binary fixture\n", "utf-8");
		process.execPath = signetBinary;
		process.argv[1] = "/$bunfs/root/signet";

		writeFileSync(
			configPath,
			"[mcp_servers.signet]\ncommand = '/old/Codex.app/Contents/Resources/node'\nargs = ['/old/mcp-stdio.js']\n",
		);

		const result = await desktopRuntimeConnector(appPath, runtime).install(tempHome);
		const hooks = readHooksJson().hooks as Record<string, Record<string, unknown>[]>;
		for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
			const handler = ((hooks[event]?.[0]?.hooks as Record<string, unknown>[]) ?? [])[0];
			if (process.platform === "win32") {
				const wrapper = result.filesWritten.find((path) => path.toLowerCase().endsWith(".cmd"));
				expect(wrapper).toBeDefined();
				expect(readFileSync(wrapper as string, "utf-8")).toContain(`${runtime} ${signetEntry}`);
			} else {
				expect(handler?.command).toContain(`${runtime} ${signetEntry}`);
			}
		}
		expect(readFileSync(configPath, "utf-8")).toContain(`command = '${runtime}'`);
		expect(readFileSync(configPath, "utf-8")).toContain(`args = ['${mcpEntry}']`);
		expect(result.warnings).toContain(
			"Detected a missing Signet Codex runtime path; refreshed only Signet-owned hooks and MCP configuration.",
		);
	});

	test("uses the wrapper entry when an optional native binary runs without postinstall", async () => {
		const appPath = join(tempHome, "Applications", "Codex.app");
		const runtime = join(appPath, "Contents", "Resources", "runtime", "node", "bin", "node");
		mkdirSync(join(runtime, ".."), { recursive: true });
		writeFileSync(runtime, "#!/bin/sh\necho v22.14.0\n", "utf-8");
		chmodSync(runtime, 0o755);

		const packageRoot = join(tempHome, "signetai");
		const signetEntry = join(packageRoot, "bin", "signet.js");
		const mcpEntry = join(packageRoot, "dist", "mcp-stdio.js");
		const optionalNative = join(packageRoot, "node_modules", "signetai-darwin-arm64", "bin", "signet");
		mkdirSync(join(signetEntry, ".."), { recursive: true });
		mkdirSync(join(mcpEntry, ".."), { recursive: true });
		mkdirSync(join(optionalNative, ".."), { recursive: true });
		writeFileSync(signetEntry, "// fixture\n", "utf-8");
		writeFileSync(mcpEntry, "// fixture\n", "utf-8");
		writeFileSync(optionalNative, "binary fixture\n", "utf-8");
		process.execPath = optionalNative;
		process.argv[1] = "/$bunfs/root/signet";
		process.env.SIGNET_WRAPPER_DIR = packageRoot;

		const result = await desktopRuntimeConnector(appPath, runtime).install(tempHome);
		const hooks = readHooksJson().hooks as Record<string, Record<string, unknown>[]>;
		for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
			const handler = ((hooks[event]?.[0]?.hooks as Record<string, unknown>[]) ?? [])[0];
			if (process.platform === "win32") {
				const wrapper = result.filesWritten.find((path) => path.toLowerCase().endsWith(".cmd"));
				expect(wrapper).toBeDefined();
				expect(readFileSync(wrapper as string, "utf-8")).toContain(`${runtime} ${signetEntry}`);
			} else {
				expect(handler?.command).toContain(`${runtime} ${signetEntry}`);
			}
		}
		const config = readFileSync(configPath, "utf-8");
		expect(config).toContain(`command = '${runtime}'`);
		expect(config).toContain(`args = ['${mcpEntry}']`);
	});

	test("discovers nested Codex Desktop runtimes", async () => {
		const appPath = join(tempHome, "Applications", "Codex.app");
		const resourcesDir = join(appPath, "Contents", "Resources");
		const runtime = join(resourcesDir, "runtime", process.platform === "win32" ? "node.exe" : "node");
		mkdirSync(join(runtime, ".."), { recursive: true });
		if (process.platform === "win32") {
			writeFileSync(runtime, "node fixture\n", "utf-8");
		} else {
			const runtimeDir = join(tempHome, "node-runtime");
			const versionedNode = join(runtimeDir, "node-v22.14.0");
			mkdirSync(runtimeDir, { recursive: true });
			writeFileSync(versionedNode, "#!/bin/sh\necho v22.14.0\n", "utf-8");
			chmodSync(versionedNode, 0o755);
			rmSync(runtime, { force: true });
			symlinkSync(versionedNode, runtime);
		}

		expect(resolveCodexDesktopNode([appPath], (path) => path === runtime, process.platform)).toBe(runtime);
	});

	test("discovers the Codex executable bundled by ChatGPT.app", () => {
		const appPath = join(tempHome, "Applications", "ChatGPT.app");
		const codex = join(appPath, "Contents", "Resources", "codex");
		mkdirSync(join(codex, ".."), { recursive: true });
		writeFileSync(
			codex,
			'#!/bin/sh\nif [ "$1" = "plugin" ]; then echo plugin-help; else echo codex-cli 0.153.4; fi\n',
			"utf-8",
		);
		chmodSync(codex, 0o755);

		expect(resolveCodexCli([appPath], (path) => path === codex, "darwin")).toBe(codex);
	});

	test("discovers Linux ChatGPT resource layouts", () => {
		const appPath = join(tempHome, "chatgpt");
		const codex = join(appPath, "resources", "codex");
		mkdirSync(join(codex, ".."), { recursive: true });
		writeFileSync(codex, "codex fixture\n", "utf-8");

		expect(resolveCodexCli([appPath], (path) => path === codex, "linux")).toBe(codex);
	});

	test("discovers Windows ChatGPT resource layouts and node.exe", () => {
		const appPath = join(tempHome, "ChatGPT");
		const codex = join(appPath, "app", "resources", "codex.exe");
		const node = join(appPath, "resources", "runtime", "node.exe");
		mkdirSync(join(codex, ".."), { recursive: true });
		mkdirSync(join(node, ".."), { recursive: true });
		writeFileSync(codex, "codex fixture\n", "utf-8");
		writeFileSync(node, "node fixture\n", "utf-8");

		expect(resolveCodexCli([appPath], (path) => path === codex, "win32")).toBe(codex);
		expect(resolveCodexDesktopNode([appPath], (path) => path === node, "win32")).toBe(node);
	});

	test("discovers versioned Windows Codex binaries without PATH", () => {
		const appPath = join(tempHome, "OpenAI", "Codex");
		const codex = join(appPath, "bin", "8e5b6932251c2c1c", "codex.exe");
		mkdirSync(join(codex, ".."), { recursive: true });
		writeFileSync(codex, "codex fixture\n", "utf-8");

		expect(resolveCodexCli([appPath], (path) => path === codex, "win32")).toBe(codex);
	});

	test("discovers Windows Store package roots", () => {
		const packagesRoot = join(tempHome, "Packages");
		const codex = join(packagesRoot, "OpenAI.ChatGPT-Desktop_1.0.0", "resources", "codex.exe");
		mkdirSync(join(codex, ".."), { recursive: true });
		writeFileSync(codex, "codex fixture\n", "utf-8");

		expect(resolveCodexCli([packagesRoot], (path) => path === codex, "win32")).toBe(codex);
	});

	test("honors CODEX_HOME for the desktop connector", async () => {
		const configuredHome = join(tempHome, "configured-codex-home");
		process.env.CODEX_HOME = configuredHome;
		const c = new (class extends CodexConnector {
			protected override supportsNativePluginInstall(): boolean {
				return false;
			}
		})();

		await c.install(tempHome);

		expect(existsSync(join(configuredHome, "config.toml"))).toBe(true);
		expect(existsSync(join(configuredHome, "hooks.json"))).toBe(true);
		expect(existsSync(join(codexDir, "config.toml"))).toBe(false);
	});

	test("uses an absolute native Signet binary for hooks and MCP when no wrapper entry exists", async () => {
		const nativeBinary = join(tempHome, "bin", "signet");
		mkdirSync(join(nativeBinary, ".."), { recursive: true });
		writeFileSync(nativeBinary, "native fixture\n", "utf-8");
		chmodSync(nativeBinary, 0o755);
		process.execPath = nativeBinary;
		process.argv[1] = "/$bunfs/root/signet";

		const result = await connector().install(tempHome);

		const hooks = readHooksJson().hooks as Record<string, Record<string, unknown>[]>;
		const startHandler = ((hooks.SessionStart[0] as Record<string, unknown>).hooks as Record<string, unknown>[])[0];
		if (process.platform === "win32") {
			const wrapper = result.filesWritten.find((path) => path.toLowerCase().endsWith(".cmd"));
			expect(wrapper).toBeDefined();
			expect(readFileSync(wrapper as string, "utf-8")).toContain(nativeBinary);
			expect(selectedHookCommand(startHandler)).toContain("hook session-start -H codex --codex-json");
		} else {
			expect(startHandler.command).toBe(`${nativeBinary} hook session-start -H codex --codex-json`);
		}

		const config = readFileSync(configPath, "utf-8");
		expect(config).toContain(`command = '${nativeBinary}'`);
		expect(config).toContain("[mcp_servers.signet.env]");
		expect(config).toContain("SIGNET_MCP_STDIO_WORKER = '1'");
	});

	test("installs with malformed but valid hooks.json", async () => {
		for (const hooks of [
			{ SessionStart: "x" },
			{ SessionStart: [{ hooks: "x" }] },
			{ SessionStart: [{ hooks: [null] }] },
		]) {
			writeFileSync(hooksPath, JSON.stringify({ hooks }));
			await expect(connector().install(tempHome)).resolves.toMatchObject({ success: true });
		}
	});

	test("preserves third-party commands that only mention hook subcommands", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "command",
									command: "python ./scripts/custom-reviewer.py --note ' hook session-start '",
									timeout: 7,
								},
							],
						},
					],
				},
			}),
		);

		await connector().install(tempHome);
		const json = readHooksJson();
		const hooks = json.hooks as Record<string, Record<string, unknown>[]>;
		const commands = hooks.SessionStart.flatMap((group) =>
			((group as Record<string, unknown>).hooks as Record<string, unknown>[]).map(
				(handler) => handler.command as string,
			),
		);

		expect(commands).toContain("python ./scripts/custom-reviewer.py --note ' hook session-start '");
		expect(commands.some((command) => command === "signet hook session-start -H codex --codex-json")).toBe(true);
	});

	test("preserves third-party handlers in a mixed matcher group", async () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							matcher: "*",
							hooks: [
								{ type: "command", command: "third-party-reviewer --session", timeout: 4 },
								{ type: "command", command: "signet hook session-start -H codex", timeout: 4 },
							],
						},
					],
				},
			}),
		);

		await connector().install(tempHome);
		const installed = readHooksJson().hooks as Record<string, Record<string, unknown>[]>;
		const handlers = installed.SessionStart.flatMap((group) => group.hooks as Record<string, unknown>[]);
		expect(handlers.some((handler) => handler.command === "third-party-reviewer --session")).toBe(true);
		expect(handlers.filter((handler) => String(handler.command).includes("signet hook session-start")).length).toBe(1);

		await connector().uninstall();
		const remaining = readHooksJson().hooks as Record<string, Record<string, unknown>[]>;
		expect(remaining.SessionStart).toHaveLength(1);
		expect((remaining.SessionStart[0].hooks as Record<string, unknown>[])[0].command).toBe(
			"third-party-reviewer --session",
		);
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

	test("does not serialize private ownership markers", async () => {
		await connector().install(tempHome);
		const json = readHooksJson();
		expect(JSON.stringify(json)).not.toContain('"_signet"');
	});

	test("bundled plugin hooks satisfy the Codex contract", () => {
		const bundledPath = join(import.meta.dir, "..", "..", "plugin", "plugins", "signet", "hooks", "hooks.json");
		const bundled = JSON.parse(readFileSync(bundledPath, "utf-8"));

		expect(codexHookContractErrors(bundled)).toEqual([]);
	});

	test("uses a quote-safe Windows wrapper command when one is available", () => {
		const hooks = buildHooksFile(
			["C:\\Program Files\\Signet\\signet.exe"],
			"https://signet.example.test",
			"C:\\Users\\Example User\\.codex\\.tmp\\signet-codex-hook-0123456789abcdef.cmd",
			"win32",
		) as unknown as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
		const command = hooks.hooks.SessionStart[0]?.hooks[0]?.commandWindows;
		expect(command).toBe(
			'"C:\\Users\\Example User\\.codex\\.tmp\\signet-codex-hook-0123456789abcdef.cmd" hook session-start -H codex --codex-json',
		);
		expect(command).not.toContain('set "');
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
		expect(json._signet).toBeUndefined();
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

		expect(codexHookContractErrors(json)).toEqual([]);
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
			{ _signet: true, hooks: [{ type: "command", command: "echo pre-tool", timeout: 5 }] },
		];
		writeFileSync(hooksPath, JSON.stringify(json));

		await c.uninstall();

		expect(existsSync(hooksPath)).toBe(true);
		const remaining = JSON.parse(readFileSync(hooksPath, "utf-8"));
		const remHooks = remaining.hooks as Record<string, unknown[]>;
		expect(remHooks.PreToolUse).toBeDefined();
		expect(JSON.stringify(remaining)).not.toContain('"_signet"');
		expect(remHooks.SessionStart).toBeUndefined();
		expect(remHooks.UserPromptSubmit).toBeUndefined();
		expect(remHooks.Stop).toBeUndefined();
	});
});

describe("CodexConnector.isInstalled", () => {
	test("does not treat legacy markers on third-party hooks as ownership", () => {
		writeFileSync(
			hooksPath,
			JSON.stringify({
				hooks: {
					SessionStart: [{ _signet: true, hooks: [{ type: "command", command: "echo third-party", timeout: 5 }] }],
				},
			}),
		);

		expect(connector().isInstalled()).toBe(false);
	});

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

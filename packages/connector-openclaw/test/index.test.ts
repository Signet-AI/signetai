import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawConnector } from "../src/index";

let tmpRoot = "";
const envKeys = [
	"OPENCLAW_CONFIG_PATH",
	"CLAWDBOT_CONFIG_PATH",
	"OPENCLAW_STATE_DIR",
	"CLAWDBOT_STATE_DIR",
	"OPENCLAW_STATE_HOME",
	"OPENCLAW_HOME",
	"CLAWDBOT_HOME",
	"MOLDBOT_HOME",
	"MOLTBOT_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"HOME",
] as const;
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-openclaw-test-"));
	previousEnv.clear();
	for (const key of envKeys) {
		previousEnv.set(key, process.env[key]);
	}
	process.env.HOME = tmpRoot;
});

afterEach(() => {
	for (const key of envKeys) {
		const previous = previousEnv.get(key);
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}

	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("OpenClawConnector config patching", () => {
	it("does not patch workspace when configureWorkspace is false", async () => {
		const configPath = join(tmpRoot, "openclaw.json");
		const hookBasePath = join(tmpRoot, "agents");
		const workspacePath = "/home/test-user/.agents";

		writeFileSync(
			configPath,
			JSON.stringify(
				{
					agents: { defaults: { workspace: "/home/other/.agents" } },
					hooks: { internal: { entries: {} } },
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		await connector.install(hookBasePath, { configureWorkspace: false });

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.agents.defaults.workspace).toBe("/home/other/.agents");
		expect(patched.hooks.internal.entries["signet-memory"].enabled).toBe(true);

		await connector.configureWorkspace(workspacePath);
		const workspacePatched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(workspacePatched.agents.defaults.workspace).toBe(workspacePath);
	});

	it("patches JSON5 config files with comments and trailing commas", async () => {
		const configPath = join(tmpRoot, "openclaw.json5");
		const hookBasePath = join(tmpRoot, "agents");

		writeFileSync(
			configPath,
			`{
  // OpenClaw config
  agents: {
    defaults: {
      workspace: "/home/old/.agents",
    },
  },
  hooks: {
    internal: {
      entries: {},
    },
  },
}
`,
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		const result = await connector.install(hookBasePath, {
			configureWorkspace: false,
			configureHooks: true,
		});

		expect(result.configsPatched).toContain(configPath);

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		// workspace unchanged since configureWorkspace is false
		expect(patched.agents.defaults.workspace).toBe("/home/old/.agents");
		expect(patched.hooks.internal.entries["signet-memory"].enabled).toBe(true);
	});

	it("does not execute non-JSON expressions while parsing configs", async () => {
		const configPath = join(tmpRoot, "openclaw.json");
		const hookBasePath = join(tmpRoot, "agents");

		// This is valid JavaScript expression syntax, but not valid JSON/JSON5.
		writeFileSync(
			configPath,
			`({ agents: { defaults: { workspace: "/home/old/.agents" } }, hooks: { internal: { entries: {} } } })`,
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		const result = await connector.install(hookBasePath, {
			configureWorkspace: false,
			configureHooks: true,
		});

		expect(result.configsPatched).not.toContain(configPath);
		expect(result.warnings?.some((w) => w.includes("could not parse JSON/JSON5 config"))).toBe(true);
		expect(connector.getDiscoveredWorkspacePaths()).toHaveLength(0);
	});

	it("rejects temp directory as workspace", async () => {
		const configPath = join(tmpRoot, "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					agents: { defaults: { workspace: "/home/user/.agents" } },
					hooks: { internal: { entries: {} } },
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		expect(connector.configureWorkspace(tmpRoot)).rejects.toThrow(/temp directory/);
		expect(connector.install(tmpRoot, { configureWorkspace: true })).rejects.toThrow(/temp directory/);
	});

	it("discovers workspace paths from config files", () => {
		const configPath = join(tmpRoot, "openclaw.json");
		const configPath2 = join(tmpRoot, "openclaw-2.json");
		const workspacePath = join(tmpRoot, "clawd");

		writeFileSync(
			configPath,
			JSON.stringify(
				{
					agents: { defaults: { workspace: workspacePath } },
				},
				null,
				2,
			),
		);
		writeFileSync(
			configPath2,
			JSON.stringify(
				{
					agents: { defaults: { workspace: workspacePath } },
				},
				null,
				2,
			),
		);

		process.env.OPENCLAW_CONFIG_PATH = `${configPath}:${configPath2}`;

		const connector = new OpenClawConnector();
		const workspaces = connector.getDiscoveredWorkspacePaths();
		expect(workspaces).toContain(workspacePath);
		expect(workspaces.filter((path) => path === workspacePath)).toHaveLength(1);
	});

	it("discovers config from OPENCLAW_STATE_DIR", () => {
		const stateDir = join(tmpRoot, "state-openclaw");
		const configPath = join(stateDir, "openclaw.json");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		process.env.OPENCLAW_STATE_DIR = stateDir;

		const connector = new OpenClawConnector();
		expect(connector.getDiscoveredConfigPaths()).toContain(configPath);
	});

	it("discovers config from CLAWDBOT_STATE_DIR", () => {
		const stateDir = join(tmpRoot, "state-clawdbot");
		const configPath = join(stateDir, "clawdbot.json");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		process.env.CLAWDBOT_STATE_DIR = stateDir;

		const connector = new OpenClawConnector();
		expect(connector.getDiscoveredConfigPaths()).toContain(configPath);
	});

	it("discovers moldbot and moltbot legacy default directories", () => {
		const moldbotPath = join(tmpRoot, ".moldbot", "moldbot.json");
		const moltbotPath = join(tmpRoot, ".moltbot", "moltbot.json");
		mkdirSync(join(tmpRoot, ".moldbot"), { recursive: true });
		mkdirSync(join(tmpRoot, ".moltbot"), { recursive: true });
		writeFileSync(moldbotPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));
		writeFileSync(moltbotPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		const connector = new OpenClawConnector();
		const discovered = connector.getDiscoveredConfigPaths();
		expect(discovered).toContain(moldbotPath);
		expect(discovered).toContain(moltbotPath);
	});

	it("does not cross-match filenames in legacy default directories", () => {
		const canonicalPath = join(tmpRoot, ".openclaw", "openclaw.json");
		const mismatchedPath = join(tmpRoot, ".openclaw", "clawdbot.json");
		mkdirSync(join(tmpRoot, ".openclaw"), { recursive: true });
		writeFileSync(canonicalPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));
		writeFileSync(mismatchedPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		const connector = new OpenClawConnector();
		const discovered = connector.getDiscoveredConfigPaths();
		expect(discovered).toContain(canonicalPath);
		expect(discovered).not.toContain(mismatchedPath);
	});

	it("keeps legacy OPENCLAW_STATE_HOME compatibility", () => {
		const stateHome = join(tmpRoot, "legacy-state-home");
		const configPath = join(stateHome, "openclaw.json");
		const legacyClawdbotPath = join(stateHome, "clawdbot.json");
		mkdirSync(stateHome, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));
		writeFileSync(legacyClawdbotPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		process.env.OPENCLAW_STATE_HOME = stateHome;

		const connector = new OpenClawConnector();
		const discovered = connector.getDiscoveredConfigPaths();
		expect(discovered).toContain(configPath);
		expect(discovered).not.toContain(legacyClawdbotPath);
	});

	it("discovers legacy-named config files under OPENCLAW_STATE_DIR", () => {
		const stateDir = join(tmpRoot, "state-openclaw-mixed");
		const legacyConfigPath = join(stateDir, "clawdbot.json");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(legacyConfigPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		process.env.OPENCLAW_STATE_DIR = stateDir;

		const connector = new OpenClawConnector();
		expect(connector.getDiscoveredConfigPaths()).toContain(legacyConfigPath);
	});

	it("does not cross-match filenames in XDG fallback directories", () => {
		const xdgConfigHome = join(tmpRoot, "xdg-config");
		process.env.XDG_CONFIG_HOME = xdgConfigHome;

		const canonicalPath = join(xdgConfigHome, "openclaw", "openclaw.json");
		const mismatchedPath = join(xdgConfigHome, "openclaw", "clawdbot.json");
		mkdirSync(join(xdgConfigHome, "openclaw"), { recursive: true });
		writeFileSync(canonicalPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));
		writeFileSync(mismatchedPath, JSON.stringify({ agents: { defaults: {} } }, null, 2));

		const connector = new OpenClawConnector();
		const discovered = connector.getDiscoveredConfigPaths();
		expect(discovered).toContain(canonicalPath);
		expect(discovered).not.toContain(mismatchedPath);
	});

	it("ignores invalid configs when discovering workspaces", () => {
		const goodConfigPath = join(tmpRoot, "openclaw.json");
		const badConfigPath = join(tmpRoot, "broken.json");

		writeFileSync(
			goodConfigPath,
			JSON.stringify(
				{
					agents: { defaults: { workspace: "/home/test-user/workspace" } },
				},
				null,
				2,
			),
		);
		writeFileSync(badConfigPath, "{ not valid json");

		process.env.OPENCLAW_CONFIG_PATH = `${goodConfigPath}:${badConfigPath}`;

		const connector = new OpenClawConnector();
		expect(connector.getDiscoveredWorkspacePaths()).toContain("/home/test-user/workspace");
	});

	it("detects plugin runtime path from config", () => {
		const configPath = join(tmpRoot, "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					plugins: {
						slots: { memory: "signet-memory-openclaw" },
						entries: {
							"signet-memory-openclaw": {
								enabled: true,
							},
						},
					},
				},
				null,
				2,
			),
		);

		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		expect(connector.getConfiguredRuntimePath()).toBe("plugin");
	});

	it("detects legacy runtime path from config", () => {
		const configPath = join(tmpRoot, "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					hooks: {
						internal: {
							entries: {
								"signet-memory": {
									enabled: true,
								},
							},
						},
					},
				},
				null,
				2,
			),
		);

		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		expect(connector.getConfiguredRuntimePath()).toBe("legacy");
	});

	it("adds signet memory plugin to plugins.allow during plugin install", async () => {
		const configPath = join(tmpRoot, "openclaw.json");
		const basePath = join(tmpRoot, "agents");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					plugins: {
						allow: ["existing-plugin"],
						entries: {},
					},
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		await connector.install(basePath, {
			configureWorkspace: false,
			configureHooks: false,
			runtimePath: "plugin",
		});

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.plugins.allow).toContain("existing-plugin");
		expect(patched.plugins.allow).toContain("signet-memory-openclaw");
	});

	it("patchLoadPaths adds signet memory plugin to plugins.allow", () => {
		const configPath = join(tmpRoot, "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					plugins: {
						load: {
							paths: ["/tmp/a"],
						},
						entries: {},
					},
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		const result = connector.patchLoadPaths("/tmp/b");
		expect(result.patched).toContain(configPath);

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.plugins.load.paths).toEqual(["/tmp/a", "/tmp/b"]);
		expect(patched.plugins.allow).toContain("signet-memory-openclaw");
	});

	it("patchLoadPaths patches allowlist when search path already exists", () => {
		const configPath = join(tmpRoot, "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					plugins: {
						load: {
							paths: ["/tmp/a"],
						},
						entries: {},
					},
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		const result = connector.patchLoadPaths("/tmp/a");
		expect(result.patched).toContain(configPath);

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.plugins.load.paths).toEqual(["/tmp/a"]);
		expect(patched.plugins.allow).toContain("signet-memory-openclaw");
	});

	it("uninstall removes signet memory plugin from plugins.allow", async () => {
		const configPath = join(tmpRoot, "openclaw.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					hooks: {
						internal: {
							entries: {
								"signet-memory": {
									enabled: true,
								},
							},
						},
					},
					plugins: {
						allow: ["existing-plugin", "signet-memory-openclaw"],
						slots: {
							memory: "signet-memory-openclaw",
						},
						entries: {
							"signet-memory-openclaw": {
								enabled: true,
							},
						},
					},
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		await connector.uninstall();

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.plugins.allow).toContain("existing-plugin");
		expect(patched.plugins.allow).not.toContain("signet-memory-openclaw");
		expect(patched.plugins.entries["signet-memory-openclaw"].enabled).toBe(false);
		expect(patched.plugins.slots.memory).toBe("memory-core");
	});
});

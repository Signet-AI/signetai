import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenClawConnector } from "../src/index";

let tmpRoot = "";
let previousConfigPath: string | undefined;
let previousHome: string | undefined;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-openclaw-test-"));
	previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
	previousHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});

afterEach(() => {
	if (previousConfigPath === undefined) {
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stringifies it
		delete process.env.OPENCLAW_CONFIG_PATH;
	} else {
		process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
	}

	if (previousHome === undefined) {
		// biome-ignore lint/performance/noDelete: assigning undefined to process.env stringifies it
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
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
});

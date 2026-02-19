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
		process.env.OPENCLAW_CONFIG_PATH = undefined;
	} else {
		process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
	}

	if (previousHome === undefined) {
		process.env.HOME = undefined;
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
		const agentsDir = join(tmpRoot, "agents");

		writeFileSync(
			configPath,
			JSON.stringify(
				{
					agents: { defaults: { workspace: "/tmp/original-workspace" } },
					hooks: { internal: { entries: {} } },
				},
				null,
				2,
			),
		);
		process.env.OPENCLAW_CONFIG_PATH = configPath;

		const connector = new OpenClawConnector();
		await connector.install(agentsDir, { configureWorkspace: false });

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.agents.defaults.workspace).toBe("/tmp/original-workspace");
		expect(patched.hooks.internal.entries["signet-memory"].enabled).toBe(true);

		await connector.configureWorkspace(agentsDir);
		const workspacePatched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(workspacePatched.agents.defaults.workspace).toBe(agentsDir);
	});

	it("patches JSON5 config files with comments and trailing commas", async () => {
		const configPath = join(tmpRoot, "openclaw.json5");
		const agentsDir = join(tmpRoot, "agents");

		writeFileSync(
			configPath,
			`{
  // OpenClaw config
  agents: {
    defaults: {
      workspace: "/tmp/legacy",
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
		const result = await connector.install(agentsDir, {
			configureWorkspace: true,
			configureHooks: true,
		});

		expect(result.configsPatched).toContain(configPath);

		const patched = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patched.agents.defaults.workspace).toBe(agentsDir);
		expect(patched.hooks.internal.entries["signet-memory"].enabled).toBe(true);
	});
});

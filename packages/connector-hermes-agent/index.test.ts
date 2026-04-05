import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAgentConnector } from "./src/index.js";

const originalEnv = {
	HOME: process.env.HOME,
	HERMES_REPO: process.env.HERMES_REPO,
	HERMES_HOME: process.env.HERMES_HOME,
	SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
};

let tmpRoot = "";

function restoreEnv(name: keyof typeof originalEnv): void {
	const value = originalEnv[name];
	if (typeof value === "string") {
		process.env[name] = value;
		return;
	}
	delete process.env[name];
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-hermes-connector-"));
	process.env.HOME = tmpRoot;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.HERMES_REPO;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.HERMES_HOME;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_ID;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_DAEMON_URL;
});

afterEach(() => {
	restoreEnv("HOME");
	restoreEnv("HERMES_REPO");
	restoreEnv("HERMES_HOME");
	restoreEnv("SIGNET_AGENT_ID");
	restoreEnv("SIGNET_DAEMON_URL");
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("HermesAgentConnector.isInstalled()", () => {
	it("returns false when plugin __init__.py is absent", () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("returns true only when signet/__init__.py is present in plugins/memory", () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(join(pluginDir, "__init__.py"), "# signet plugin\n");
		process.env.HERMES_REPO = hermesRepo;

		expect(new HermesAgentConnector().isInstalled()).toBe(true);
	});

	it("returns false when HERMES_REPO is not set and no known install paths exist", () => {
		// HOME is a fresh tmp dir with no hermes paths
		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});
});

describe("HermesAgentConnector.install()", () => {
	it("copies plugin files into plugins/memory/signet/ when HERMES_REPO is set", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		expect(result.success).toBe(true);
		expect(existsSync(join(pluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "client.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "plugin.yaml"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("warns (does not throw) when HERMES_REPO is unset", async () => {
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("HERMES_REPO"))).toBe(true);
	});

	it("writes daemon env vars into ~/.hermes/.env when SIGNET_DAEMON_URL is set", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = hermesHome;
		process.env.SIGNET_DAEMON_URL = "http://127.0.0.1:9999";

		const result = await new HermesAgentConnector().install(tmpRoot);

		const envPath = join(hermesHome, ".env");
		expect(result.configsPatched).toContain(envPath);
		expect(existsSync(envPath)).toBe(true);
		const envContent = await Bun.file(envPath).text();
		expect(envContent).toContain("SIGNET_DAEMON_URL=http://127.0.0.1:9999");
	});
});

describe("HermesAgentConnector.uninstall()", () => {
	it("removes the plugin directory and reports it in filesRemoved", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const connector = new HermesAgentConnector();
		await connector.install(tmpRoot);
		expect(connector.isInstalled()).toBe(true);

		const result = await connector.uninstall();
		const pluginDir = join(hermesRepo, "plugins", "memory", "signet");
		expect(result.filesRemoved).toContain(pluginDir);
		expect(connector.isInstalled()).toBe(false);
	});
});

describe("HermesAgentConnector — AGENTS.md legacy block migration", () => {
	it("strips legacy SIGNET block from AGENTS.md and reports path in filesWritten", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");

		const result = await new HermesAgentConnector().install(tmpRoot);
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});
});

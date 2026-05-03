import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAgentConnector, diagnoseHermesIntegration } from "./src/index.js";

const originalEnv = {
	HOME: process.env.HOME,
	HERMES_REPO: process.env.HERMES_REPO,
	HERMES_HOME: process.env.HERMES_HOME,
	SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
	SIGNET_AGENT_WORKSPACE: process.env.SIGNET_AGENT_WORKSPACE,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
	SIGNET_TOKEN: process.env.SIGNET_TOKEN,
	SIGNET_AGENT_READ_POLICY: process.env.SIGNET_AGENT_READ_POLICY,
	SIGNET_AGENT_MEMORY_POLICY: process.env.SIGNET_AGENT_MEMORY_POLICY,
	SIGNET_AGENT_POLICY_GROUP: process.env.SIGNET_AGENT_POLICY_GROUP,
	SIGNET_SKIP_AGENT_REGISTER: process.env.SIGNET_SKIP_AGENT_REGISTER,
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
	delete process.env.SIGNET_AGENT_WORKSPACE;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_DAEMON_URL;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_TOKEN;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_READ_POLICY;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_MEMORY_POLICY;
	// biome-ignore lint/performance/noDelete: ensure no stale value from outer env
	delete process.env.SIGNET_AGENT_POLICY_GROUP;
	process.env.SIGNET_SKIP_AGENT_REGISTER = "1";
});

afterEach(() => {
	restoreEnv("HOME");
	restoreEnv("HERMES_REPO");
	restoreEnv("HERMES_HOME");
	restoreEnv("SIGNET_AGENT_ID");
	restoreEnv("SIGNET_AGENT_WORKSPACE");
	restoreEnv("SIGNET_DAEMON_URL");
	restoreEnv("SIGNET_TOKEN");
	restoreEnv("SIGNET_AGENT_READ_POLICY");
	restoreEnv("SIGNET_AGENT_MEMORY_POLICY");
	restoreEnv("SIGNET_AGENT_POLICY_GROUP");
	restoreEnv("SIGNET_SKIP_AGENT_REGISTER");
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("HermesAgentConnector.isInstalled()", () => {
	it("returns false when plugin __init__.py is absent", () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("returns false when the plugin exists but Hermes is not configured to use signet", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");
		process.env.HERMES_REPO = hermesRepo;
		await new HermesAgentConnector().install(tmpRoot);
		writeFileSync(join(process.env.HERMES_HOME, "config.yaml"), "memory:\n  provider: honcho\n");

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("returns true when a fixed Signet provider is installed and activated", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");
		process.env.HERMES_REPO = hermesRepo;

		await new HermesAgentConnector().install(tmpRoot);

		expect(new HermesAgentConnector().isInstalled()).toBe(true);
	});

	it("returns true when Hermes uses dotted memory.provider config", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory.provider: signet\n");
		process.env.HERMES_HOME = hermesHome;
		process.env.HERMES_REPO = hermesRepo;

		await new HermesAgentConnector().install(tmpRoot);

		expect(new HermesAgentConnector().isInstalled()).toBe(true);
	});

	it("returns false when dotted memory.provider conflicts with nested Signet provider", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_HOME = hermesHome;
		process.env.HERMES_REPO = hermesRepo;

		await new HermesAgentConnector().install(tmpRoot);
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  provider: signet\nmemory.provider: honcho\n");

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("ignores nested provider keys when checking Hermes memory provider config", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_HOME = hermesHome;
		process.env.HERMES_REPO = hermesRepo;

		await new HermesAgentConnector().install(tmpRoot);
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  some_feature:\n    provider: signet\n");

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("returns false when repo plugin is stale even if the user plugin is fresh", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_HOME = hermesHome;
		process.env.HERMES_REPO = hermesRepo;

		await new HermesAgentConnector().install(tmpRoot);
		writeFileSync(
			join(hermesRepo, "plugins", "memory", "signet", "signet.install.json"),
			JSON.stringify({
				connector: "@signet/connector-hermes-agent",
				schemaVersion: 1,
				connectorVersion: "0.0.0",
				sourceHash: "stale",
				targetKind: "repo",
				installedAt: "2026-01-01T00:00:00.000Z",
			}),
		);

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});
});

describe("HermesAgentConnector.install()", () => {
	it("copies plugin files into both user and repo plugin locations when HERMES_REPO is set", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const repoPluginDir = join(hermesRepo, "plugins", "memory", "signet");
		const userPluginDir = join(process.env.HERMES_HOME, "plugins", "signet");
		expect(result.success).toBe(true);
		expect(existsSync(join(repoPluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(repoPluginDir, "client.py"))).toBe(true);
		expect(existsSync(join(repoPluginDir, "plugin.yaml"))).toBe(true);
		expect(existsSync(join(repoPluginDir, "signet.install.json"))).toBe(true);
		expect(readFileSync(join(repoPluginDir, "__init__.py"), "utf-8")).toContain(
			"Ask a natural-language question with entity, event, and timeframe when possible",
		);
		expect(readFileSync(join(repoPluginDir, "__init__.py"), "utf-8")).toContain("Avoid bag-of-keywords queries");
		expect(existsSync(join(userPluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(userPluginDir, "client.py"))).toBe(true);
		expect(existsSync(join(userPluginDir, "plugin.yaml"))).toBe(true);
		expect(existsSync(join(userPluginDir, "signet.install.json"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("copies plugin files into $HERMES_HOME/plugins/signet when HERMES_REPO is unset", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_HOME = hermesHome;

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const pluginDir = join(hermesHome, "plugins", "signet");
		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("Hermes Agent install not found"))).toBe(false);
		expect(existsSync(join(pluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "client.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "signet.install.json"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("copies plugin files into HERMES_HOME when HERMES_REPO is unset", async () => {
		const hermesHome = join(tmpRoot, "custom-hermes-home");
		process.env.HERMES_HOME = hermesHome;

		const connector = new HermesAgentConnector();
		const result = await connector.install(tmpRoot);

		const pluginDir = join(hermesHome, "plugins", "signet");
		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("Hermes Agent install not found"))).toBe(false);
		expect(existsSync(join(pluginDir, "__init__.py"))).toBe(true);
		expect(existsSync(join(pluginDir, "signet.install.json"))).toBe(true);
		expect(connector.isInstalled()).toBe(true);
	});

	it("fails when the user plugin is the only usable target and cannot be written", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "plugins"), "not a directory");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(false);
		expect(result.message).toContain("could not install the Hermes user Signet provider");
		expect(result.warnings.some((w) => w.includes("Failed to install Hermes user plugin files"))).toBe(true);
		expect(result.configsPatched ?? []).not.toContain(join(hermesHome, "config.yaml"));
		expect(readFileSync(join(hermesHome, "plugins"), "utf-8")).toBe("not a directory");
	});

	it("succeeds when the user plugin copy fails but the repo plugin copy is refreshed", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(hermesHome, { recursive: true });
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		writeFileSync(join(hermesHome, "plugins"), "not a directory");
		process.env.HERMES_HOME = hermesHome;
		process.env.HERMES_REPO = hermesRepo;

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(true);
		expect(result.warnings.some((w) => w.includes("Failed to install Hermes user plugin files"))).toBe(true);
		expect(existsSync(join(hermesRepo, "plugins", "memory", "signet", "signet.install.json"))).toBe(true);
		expect(new HermesAgentConnector().isInstalled()).toBe(true);
	});

	it("fails when a discoverable repo plugin copy cannot be refreshed", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(hermesHome, { recursive: true });
		mkdirSync(join(hermesRepo, "plugins"), { recursive: true });
		writeFileSync(join(hermesRepo, "plugins", "memory"), "not a directory");
		process.env.HERMES_HOME = hermesHome;
		process.env.HERMES_REPO = hermesRepo;

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(false);
		expect(result.message).toContain("could not refresh the Hermes repo Signet provider");
		expect(result.warnings.some((w) => w.includes("Failed to refresh Hermes repo plugin files"))).toBe(true);
		expect(existsSync(join(hermesHome, "plugins", "signet", "signet.install.json"))).toBe(true);
		expect(result.configsPatched ?? []).not.toContain(join(hermesHome, "config.yaml"));
		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("treats stale marker hashes as not installed", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_HOME = hermesHome;

		await new HermesAgentConnector().install(tmpRoot);
		writeFileSync(
			join(hermesHome, "plugins", "signet", "signet.install.json"),
			JSON.stringify({
				connector: "@signet/connector-hermes-agent",
				schemaVersion: 1,
				connectorVersion: "0.0.0",
				sourceHash: "stale",
				targetKind: "user",
				installedAt: "2026-01-01T00:00:00.000Z",
			}),
		);

		expect(new HermesAgentConnector().isInstalled()).toBe(false);
	});

	it("reports Hermes diagnostic failures with repair hints", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_HOME = hermesHome;

		const report = await diagnoseHermesIntegration({
			hermesHome,
			hermesRepo: null,
			daemonUrl: "http://127.0.0.1:1",
		});

		expect(report.ok).toBe(false);
		expect(report.checks.map((check) => check.id)).toContain("tool-routing");
		expect(report.checks.every((check) => typeof check.detail === "string" && check.detail.length > 0)).toBe(true);
		expect(report.warnings.some((warning) => warning.includes("Hermes checkout was not found"))).toBe(true);
	});

	it("accepts a current user-plugin-only install in Hermes diagnostics", async () => {
		const originalFetch = globalThis.fetch;
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_HOME = hermesHome;

		globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;

		try {
			await new HermesAgentConnector().install(tmpRoot);

			const report = await diagnoseHermesIntegration({
				hermesHome,
				hermesRepo: null,
				daemonUrl: "http://127.0.0.1:3850",
			});
			const checks = Object.fromEntries(report.checks.map((check) => [check.id, check]));

			expect(report.ok).toBe(true);
			expect(checks["user-plugin"]?.ok).toBe(true);
			expect(checks["repo-plugin"]?.ok).toBe(true);
			expect(checks["tool-routing"]?.ok).toBe(true);
			expect(checks["repo-plugin"]?.detail).toContain("using user plugin copy only");
			expect(checks["tool-routing"]?.detail).toContain("runtime probe skipped without Hermes checkout");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("activates signet as Hermes memory provider in config.yaml", async () => {
		process.env.HERMES_HOME = join(tmpRoot, ".hermes");

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(true);
		expect(result.configsPatched).toContain(join(process.env.HERMES_HOME, "config.yaml"));
		expect(readFileSync(join(process.env.HERMES_HOME, "config.yaml"), "utf-8")).toContain(
			"memory:\n  provider: signet\n",
		);
	});

	it("preserves existing Hermes config when activating signet", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "model: test\nmemory:\n  nudge_interval: 10\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const config = readFileSync(join(hermesHome, "config.yaml"), "utf-8");

		expect(result.success).toBe(true);
		expect(config).toContain("model: test\n");
		expect(config).toContain("memory:\n  provider: signet\n  nudge_interval: 10\n");
	});

	it("preserves dotted memory.provider config when it is already signet", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "model: test\nmemory.provider: signet\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const config = readFileSync(join(hermesHome, "config.yaml"), "utf-8");

		expect(result.success).toBe(true);
		expect(result.configsPatched ?? []).not.toContain(join(hermesHome, "config.yaml"));
		expect(config).toBe("model: test\nmemory.provider: signet\n");
	});

	it("updates dotted memory.provider config without appending a nested memory block", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "model: test\nmemory.provider: honcho\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const config = readFileSync(join(hermesHome, "config.yaml"), "utf-8");

		expect(result.success).toBe(true);
		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(config).toContain("model: test\n");
		expect(config).toContain("memory.provider: signet\n");
		expect(config).not.toContain("memory:\n  provider: signet\n");
	});

	it("uses dotted memory.provider as the only active provider in mixed-form config", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(
			join(hermesHome, "config.yaml"),
			"model: test\nmemory:\n  nudge_interval: 10\nmemory.provider: honcho\n",
		);
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const config = readFileSync(join(hermesHome, "config.yaml"), "utf-8");

		expect(result.success).toBe(true);
		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(config).toBe("model: test\nmemory:\n  nudge_interval: 10\nmemory.provider: signet\n");
		expect(config).not.toContain("provider: signet\n  nudge_interval");
	});

	it("backs up the dotted provider when both provider forms need cleanup", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(
			join(hermesHome, "config.yaml"),
			"model: test\nmemory:\n  provider: stale\n  nudge_interval: 10\nmemory.provider: honcho\n",
		);
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const backup = JSON.parse(readFileSync(join(hermesHome, "signet.provider.backup.json"), "utf-8"));

		expect(result.success).toBe(true);
		expect(result.filesWritten).toContain(join(hermesHome, "signet.provider.backup.json"));
		expect(backup).toMatchObject({
			providerKind: "dotted",
			previousProvider: "honcho",
		});
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe(
			"model: test\nmemory:\n  nudge_interval: 10\nmemory.provider: signet\n",
		);
	});

	it("removes nested provider when dotted memory.provider is active", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(
			join(hermesHome, "config.yaml"),
			"model: test\nmemory:\n  provider: honcho\n  nudge_interval: 10\nmemory.provider: signet\n",
		);
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const config = readFileSync(join(hermesHome, "config.yaml"), "utf-8");
		const backup = JSON.parse(readFileSync(join(hermesHome, "signet.provider.backup.json"), "utf-8"));

		expect(result.success).toBe(true);
		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(result.filesWritten).toContain(join(hermesHome, "signet.provider.backup.json"));
		expect(backup).toMatchObject({
			providerKind: "nested",
			previousProvider: "honcho",
		});
		expect(config).toBe("model: test\nmemory:\n  nudge_interval: 10\nmemory.provider: signet\n");
	});

	it("adds direct memory provider without rewriting nested provider keys", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "model: test\nmemory:\n  some_feature:\n    provider: honcho\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const config = readFileSync(join(hermesHome, "config.yaml"), "utf-8");

		expect(result.success).toBe(true);
		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(config).toBe("model: test\nmemory:\n  provider: signet\n  some_feature:\n    provider: honcho\n");
	});

	it("records the previous nested memory provider before replacing it", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  provider: honcho\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const backupPath = join(hermesHome, "signet.provider.backup.json");
		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));

		expect(result.filesWritten).toContain(backupPath);
		expect(backup).toMatchObject({
			schemaVersion: 1,
			configPath: join(hermesHome, "config.yaml"),
			providerKind: "nested",
			previousProvider: "honcho",
		});
	});

	it("warns instead of patching unsafe memory config YAML", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory: [\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);

		expect(result.success).toBe(false);
		expect(result.message).toContain("not activated");
		expect(result.message).not.toContain("deployed and activated");
		expect(result.warnings.some((w) => w.includes("Could not safely patch Hermes memory.provider"))).toBe(true);
		expect(new HermesAgentConnector().isInstalled()).toBe(false);
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe("memory: [\n");
	});

	it("fails safely instead of patching non-mapping memory blocks", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "model: test\nmemory:\n  - honcho\n  - archival\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().install(tmpRoot);
		const report = await diagnoseHermesIntegration({ hermesHome, hermesRepo: null });
		const providerCheck = report.checks.find((check) => check.id === "provider-config");

		expect(result.success).toBe(false);
		expect(result.message).toContain("not activated");
		expect(result.message).not.toContain("deployed and activated");
		expect(result.warnings.some((w) => w.includes("Could not safely patch Hermes memory.provider"))).toBe(true);
		expect(result.configsPatched ?? []).not.toContain(join(hermesHome, "config.yaml"));
		expect(new HermesAgentConnector().isInstalled()).toBe(false);
		expect(providerCheck?.ok).toBe(false);
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe(
			"model: test\nmemory:\n  - honcho\n  - archival\n",
		);
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

	it("derives SIGNET_AGENT_WORKSPACE for named agents", async () => {
		const hermesRepo = join(tmpRoot, "hermes-agent");
		mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
		mkdirSync(join(tmpRoot, "agents", "dot"), { recursive: true });
		const hermesHome = join(tmpRoot, ".hermes");
		process.env.HERMES_REPO = hermesRepo;
		process.env.HERMES_HOME = hermesHome;
		process.env.SIGNET_AGENT_ID = "dot";

		const result = await new HermesAgentConnector().install(tmpRoot);

		const envContent = await Bun.file(join(hermesHome, ".env")).text();
		expect(result.configsPatched).toContain(join(hermesHome, ".env"));
		expect(envContent).toContain("SIGNET_AGENT_ID=dot");
		expect(envContent).toContain(`SIGNET_AGENT_WORKSPACE=${join(tmpRoot, "agents", "dot")}`);
	});

	it("uses SIGNET_TOKEN and configured read policy when registering named agents", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(url), init });
			if (String(url).endsWith("/api/agents/dot")) {
				return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
			}
			return new Response(JSON.stringify({ id: "dot" }), { status: 201 });
		}) as typeof fetch;

		try {
			const hermesRepo = join(tmpRoot, "hermes-agent");
			mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
			const hermesHome = join(tmpRoot, ".hermes");
			process.env.HERMES_REPO = hermesRepo;
			process.env.HERMES_HOME = hermesHome;
			process.env.SIGNET_AGENT_ID = "dot";
			process.env.SIGNET_TOKEN = " test-token \n";
			process.env.SIGNET_AGENT_READ_POLICY = "isolated";
			// biome-ignore lint/performance/noDelete: this test exercises registration
			delete process.env.SIGNET_SKIP_AGENT_REGISTER;

			const result = await new HermesAgentConnector().install(tmpRoot);

			expect(result.success).toBe(true);
			expect(calls).toHaveLength(2);
			for (const call of calls) {
				expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer test-token");
			}
			expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
				name: "dot",
				read_policy: "isolated",
				policy_group: null,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not try to create a named agent when the existence check fails with non-404", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(url), init });
			return new Response("unauthorized", { status: 401 });
		}) as typeof fetch;

		try {
			const hermesRepo = join(tmpRoot, "hermes-agent");
			mkdirSync(join(hermesRepo, "plugins", "memory"), { recursive: true });
			const hermesHome = join(tmpRoot, ".hermes");
			process.env.HERMES_REPO = hermesRepo;
			process.env.HERMES_HOME = hermesHome;
			process.env.SIGNET_AGENT_ID = "dot";
			// biome-ignore lint/performance/noDelete: this test exercises registration
			delete process.env.SIGNET_SKIP_AGENT_REGISTER;

			const result = await new HermesAgentConnector().install(tmpRoot);

			expect(result.success).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toContain("/api/agents/dot");
			expect(result.warnings.some((w) => w.includes("HTTP 401"))).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Hermes Agent bundled plugin", () => {
	it("advertises canonical Signet memory tool names", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");

		expect(plugin).toContain('"name": "memory_search"');
		expect(plugin).toContain('"name": "memory_store"');
		expect(plugin).toContain('"name": "memory_get"');
		expect(plugin).toContain('"name": "memory_list"');
		expect(plugin).not.toContain('"name": "signet_search"');
		expect(plugin).toContain('if tool_name in ("memory_search", "recall", "signet_search")');
	});

	it("returns Signet tool schemas before daemon initialization", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");
		const schemasFn = plugin.slice(plugin.indexOf("def get_tool_schemas"), plugin.indexOf("def handle_tool_call"));

		expect(schemasFn).toContain("return list(ALL_TOOL_SCHEMAS)");
		expect(schemasFn).not.toContain("if not self._client");
		expect(plugin).toContain('return json.dumps({"error": "Signet daemon is not connected."})');
	});

	it("registers Signet tools with a Hermes-style memory manager before daemon initialization", () => {
		const fixture = join(tmpRoot, "python-fixture");
		cpSync(join(import.meta.dir, "hermes-plugin"), join(fixture, "plugins", "memory", "signet"), { recursive: true });
		mkdirSync(join(fixture, "agent"), { recursive: true });
		writeFileSync(join(fixture, "agent", "__init__.py"), "");
		writeFileSync(join(fixture, "plugins", "__init__.py"), "");
		writeFileSync(join(fixture, "plugins", "memory", "__init__.py"), "");
		writeFileSync(join(fixture, "agent", "memory_provider.py"), "class MemoryProvider:\n    pass\n");
		writeFileSync(
			join(fixture, "agent", "memory_manager.py"),
			[
				"class MemoryManager:",
				"    def __init__(self):",
				"        self._tool_to_provider = {}",
				"    def add_provider(self, provider):",
				"        for schema in provider.get_tool_schemas():",
				"            self._tool_to_provider[schema['name']] = provider",
				"    def get_all_tool_names(self):",
				"        return set(self._tool_to_provider.keys())",
				"    def has_tool(self, name):",
				"        return name in self._tool_to_provider",
				"",
			].join("\n"),
		);

		const result = spawnSync(
			"python",
			[
				"-c",
				[
					"from plugins.memory.signet import SignetMemoryProvider",
					"from agent.memory_manager import MemoryManager",
					"provider = SignetMemoryProvider()",
					"manager = MemoryManager()",
					"manager.add_provider(provider)",
					"names = manager.get_all_tool_names()",
					"assert 'memory_search' in names",
					"assert 'recall' in names",
					"assert manager.has_tool('memory_store')",
					"print(','.join(sorted(names)))",
				].join("\n"),
			],
			{ env: { ...process.env, PYTHONPATH: fixture }, encoding: "utf-8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("memory_search");
		expect(result.stdout).toContain("remember");
	});

	it("imports the client from a Hermes user-installed provider namespace", () => {
		const fixture = join(tmpRoot, "python-user-fixture");
		const pluginDir = join(fixture, "plugins", "signet");
		cpSync(join(import.meta.dir, "hermes-plugin"), pluginDir, { recursive: true });
		mkdirSync(join(fixture, "agent"), { recursive: true });
		writeFileSync(join(fixture, "agent", "__init__.py"), "");
		writeFileSync(join(fixture, "agent", "memory_provider.py"), "class MemoryProvider:\n    pass\n");

		const result = spawnSync(
			"python",
			[
				"-c",
				[
					"import importlib.util, sys, types",
					"from pathlib import Path",
					`root = Path(${JSON.stringify(fixture)})`,
					"provider_dir = root / 'plugins' / 'signet'",
					"sys.path.insert(0, str(root))",
					"parent = types.ModuleType('_hermes_user_memory')",
					"parent.__path__ = [str(root / 'plugins')]",
					"sys.modules['_hermes_user_memory'] = parent",
					"client_spec = importlib.util.spec_from_file_location('_hermes_user_memory.signet.client', provider_dir / 'client.py')",
					"client_mod = importlib.util.module_from_spec(client_spec)",
					"sys.modules['_hermes_user_memory.signet.client'] = client_mod",
					"client_spec.loader.exec_module(client_mod)",
					"spec = importlib.util.spec_from_file_location('_hermes_user_memory.signet', provider_dir / '__init__.py', submodule_search_locations=[str(provider_dir)])",
					"mod = importlib.util.module_from_spec(spec)",
					"sys.modules['_hermes_user_memory.signet'] = mod",
					"spec.loader.exec_module(mod)",
					"assert mod.SignetClient is not None",
					"provider = mod.SignetMemoryProvider()",
					"assert any(schema['name'] == 'memory_search' for schema in provider.get_tool_schemas())",
					"print(mod.SignetClient.__name__)",
				].join("\n"),
			],
			{ env: { ...process.env, PYTHONPATH: fixture }, encoding: "utf-8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SignetClient");
	});

	it("does not force agentId into explicit recall requests", () => {
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(client).toContain("if agent_scoped and self._agent_id:");
		expect(client).toContain('body["agentId"] = self._agent_id');
		expect(client).not.toContain('"agentId": self._agent_id,\\n        }\\n        if min_score');
	});

	it("lets explicit recall requests opt into agent scoping", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");

		expect(plugin).toContain('"agent_scoped"');
		expect(plugin).toContain("scope recall to SIGNET_AGENT_ID");
		expect(plugin).toContain('agent_scoped=bool(search_args.get("agent_scoped", False))');
	});

	it("uses longer timeouts for recall paths", () => {
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(client).toContain("_RECALL_TIMEOUT_SECS = 30");
		expect(client).toContain("timeout=_LONG_TIMEOUT_SECS,");
		expect(client).toMatch(/def user_prompt_submit[\s\S]+timeout=_RECALL_TIMEOUT_SECS,/);
		expect(client).toContain('self._post("/api/memory/recall", body, timeout=_RECALL_TIMEOUT_SECS)');
	});

	it("treats malformed recall scores as zero during score_min filtering", () => {
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(client).toContain("def _safe_score(value: Any) -> float:");
		expect(client).toContain("except (TypeError, ValueError):");
		expect(client).toContain('if not isinstance(row, dict) or _safe_score(row.get("score")) >= score_min');
	});

	it("does not expose hard-delete force to Hermes memory_forget", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(plugin).toContain('"description": "Soft-delete a memory by ID."');
		expect(plugin).not.toContain('"force"');
		expect(plugin).not.toContain("force=bool");
		expect(client).toContain("def forget_memory(");
		expect(client).not.toContain("force: bool");
		expect(client).not.toContain('"force": "true"');
	});

	it("exposes the complete Signet memory_store schema", () => {
		const plugin = readFileSync(join(import.meta.dir, "hermes-plugin", "__init__.py"), "utf-8");
		const client = readFileSync(join(import.meta.dir, "hermes-plugin", "client.py"), "utf-8");

		expect(plugin).toContain('"hints"');
		expect(plugin).toContain('"required": ["content", "hints"]');
		expect(plugin).toContain('"minItems": 1');
		expect(plugin).toContain('"transcript"');
		expect(plugin).toContain('"structured"');
		expect(plugin).toContain('"entityName"');
		expect(plugin).toContain('"attributes"');
		expect(plugin).toContain("Prospective recall hints");
		expect(plugin).toContain('hints = _string_list(store_args.get("hints"))');
		expect(plugin).toContain('Missing required parameter: hints');
		expect(plugin).toContain('transcript=str(store_args.get("transcript", "") or "")');
		expect(plugin).toContain("structured=structured");
		expect(client).toContain("hints: Optional[List[str]] = None");
		expect(client).toContain('body["hints"] = hints');
		expect(client).toContain('body["transcript"] = transcript');
		expect(client).toContain('body["structured"] = structured');
		expect(client).toContain("def _read_json_response");
		expect(client).toContain("if not body:");
		expect(client).toContain("TimeoutError, ValueError");
		expect(client).toContain('_safe_score(row.get("score"))');
		expect(client).toContain('"noHits": len(kept) == 0');
		expect(plugin).toContain('agent_id not in ("default", "hermes-agent")');
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
		const repoPluginDir = join(hermesRepo, "plugins", "memory", "signet");
		const userPluginDir = join(process.env.HERMES_HOME, "plugins", "signet");
		expect(result.filesRemoved).toContain(repoPluginDir);
		expect(result.filesRemoved).toContain(userPluginDir);
		expect(connector.isInstalled()).toBe(false);
	});

	it("clears memory.provider only when it is signet", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  provider: signet\n  nudge_interval: 10\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().uninstall();

		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toContain("memory:\n  provider: ''\n");
	});

	it("clears dotted memory.provider only when it is signet", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory.provider: signet\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().uninstall();

		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe("memory.provider: ''\n");
	});

	it("restores a previous nested memory provider on uninstall", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  provider: honcho\n  nudge_interval: 10\n");
		process.env.HERMES_HOME = hermesHome;

		const connector = new HermesAgentConnector();
		await connector.install(tmpRoot);
		const result = await connector.uninstall();

		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(result.filesRemoved).toContain(join(hermesHome, "signet.provider.backup.json"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toContain(
			"memory:\n  provider: honcho\n  nudge_interval: 10\n",
		);
	});

	it("restores a previous dotted memory provider on uninstall", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "model: test\nmemory.provider: honcho\n");
		process.env.HERMES_HOME = hermesHome;

		const connector = new HermesAgentConnector();
		await connector.install(tmpRoot);
		const result = await connector.uninstall();

		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(result.filesRemoved).toContain(join(hermesHome, "signet.provider.backup.json"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe("model: test\nmemory.provider: honcho\n");
	});

	it("restores a removed nested provider when dotted signet is uninstalled", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(
			join(hermesHome, "config.yaml"),
			"model: test\nmemory:\n  provider: honcho\n  nudge_interval: 10\nmemory.provider: signet\n",
		);
		process.env.HERMES_HOME = hermesHome;

		const connector = new HermesAgentConnector();
		await connector.install(tmpRoot);
		const result = await connector.uninstall();

		expect(result.configsPatched).toContain(join(hermesHome, "config.yaml"));
		expect(result.filesRemoved).toContain(join(hermesHome, "signet.provider.backup.json"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe(
			"model: test\nmemory:\n  provider: honcho\n  nudge_interval: 10\nmemory.provider: ''\n",
		);
	});

	it("does not clear another active memory provider", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  provider: honcho\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().uninstall();

		expect(result.configsPatched ?? []).not.toContain(join(hermesHome, "config.yaml"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toContain("provider: honcho");
	});

	it("does not clear nested provider keys during uninstall", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		writeFileSync(join(hermesHome, "config.yaml"), "memory:\n  some_feature:\n    provider: signet\n");
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().uninstall();

		expect(result.configsPatched ?? []).not.toContain(join(hermesHome, "config.yaml"));
		expect(readFileSync(join(hermesHome, "config.yaml"), "utf-8")).toBe(
			"memory:\n  some_feature:\n    provider: signet\n",
		);
	});

	it("removes persisted Signet env vars including SIGNET_TOKEN", async () => {
		const hermesHome = join(tmpRoot, ".hermes");
		mkdirSync(hermesHome, { recursive: true });
		const envPath = join(hermesHome, ".env");
		writeFileSync(
			envPath,
			[
				"KEEP_ME=1",
				"SIGNET_DAEMON_URL=http://localhost:3850",
				"SIGNET_AGENT_ID=dot",
				"SIGNET_AGENT_WORKSPACE=/tmp/dot",
				"SIGNET_TOKEN=secret-token",
				"",
			].join("\n"),
		);
		process.env.HERMES_HOME = hermesHome;

		const result = await new HermesAgentConnector().uninstall();

		expect(result.configsPatched).toContain(envPath);
		const envContent = readFileSync(envPath, "utf-8");
		expect(envContent).toContain("KEEP_ME=1");
		expect(envContent).not.toContain("SIGNET_DAEMON_URL");
		expect(envContent).not.toContain("SIGNET_AGENT_ID");
		expect(envContent).not.toContain("SIGNET_AGENT_WORKSPACE");
		expect(envContent).not.toContain("SIGNET_TOKEN");
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

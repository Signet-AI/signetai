import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OhMyPiConnector } from "./src/index.js";

const originalEnv = {
	HOME: process.env.HOME,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
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
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-omp-connector-"));
	process.env.HOME = tmpRoot;
	process.env.XDG_CONFIG_HOME = join(tmpRoot, ".config-home");
	process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
	process.env.SIGNET_AGENT_ID = "agent-from-env";
	process.env.SIGNET_DAEMON_URL = "http://127.0.0.1:4123";
});

afterEach(() => {
	restoreEnv("HOME");
	restoreEnv("XDG_CONFIG_HOME");
	restoreEnv("PI_CODING_AGENT_DIR");
	restoreEnv("SIGNET_AGENT_ID");
	restoreEnv("SIGNET_DAEMON_URL");
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("OhMyPiConnector", () => {
	it("installs a bundled managed extension without external package resolution", async () => {
		const connector = new OhMyPiConnector();
		const result = await connector.install(tmpRoot);
		const installedPath = join(tmpRoot, "agent", "extensions", "signet-oh-my-pi.js");
		const configPath = join(tmpRoot, ".config-home", "signet", "oh-my-pi.json");

		expect(result.success).toBe(true);
		expect(result.filesWritten).toContain(installedPath);
		expect(result.filesWritten).toContain(configPath);
		expect(existsSync(installedPath)).toBe(true);
		expect(existsSync(configPath)).toBe(true);

		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain("SIGNET_MANAGED_OH_MY_PI_EXTENSION");
		expect(content).toContain("Managed by Signet (@signet/oh-my-pi-extension)");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "agent-from-env")');
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", "http://127.0.0.1:4123")');
		expect(content).toContain(`Reflect.set(__signetRuntimeEnv, "SIGNET_PATH", ${JSON.stringify(tmpRoot)})`);
		expect(content.length).toBeGreaterThan(1_000);
	});

	it("falls back to default agent id when none is configured at install time", async () => {
		Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		const connector = new OhMyPiConnector();
		await connector.install(tmpRoot);

		const installedPath = join(tmpRoot, "agent", "extensions", "signet-oh-my-pi.js");
		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "default")');
	});

	it("treats blank runtime env values as missing when generating the managed bootstrap", async () => {
		process.env.SIGNET_AGENT_ID = "   ";
		process.env.SIGNET_DAEMON_URL = "\n\t";
		const connector = new OhMyPiConnector();
		await connector.install(tmpRoot);

		const installedPath = join(tmpRoot, "agent", "extensions", "signet-oh-my-pi.js");
		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "default")');
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", "http://127.0.0.1:3850")');
	});

	it("persists a custom Oh My Pi agent dir so later maintenance still finds the managed install", async () => {
		const customAgentDir = join(tmpRoot, "custom-agent-home");
		process.env.PI_CODING_AGENT_DIR = customAgentDir;
		const connector = new OhMyPiConnector();
		await connector.install(tmpRoot);

		Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
		const reloadedConnector = new OhMyPiConnector();
		expect(reloadedConnector.isInstalled()).toBe(true);

		const uninstall = await reloadedConnector.uninstall();
		expect(uninstall.filesRemoved).toContain(join(customAgentDir, "extensions", "signet-oh-my-pi.js"));
		expect(uninstall.filesRemoved).toContain(join(tmpRoot, ".config-home", "signet", "oh-my-pi.json"));
		expect(reloadedConnector.isInstalled()).toBe(false);
	});
});

describe("root build pipeline", () => {
	it("builds Oh My Pi prerequisites before the shared dependency batch", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const path = resolve(dir, "..", "..", "package.json");
		const text = readFileSync(path, "utf8");

		expect(text).toContain('"build:oh-my-pi-extension"');
		expect(text).toContain('"build:connector-oh-my-pi"');

		const build = text.match(/"build":\s*"([^"]+)"/)?.[1] ?? "";
		const ext = "bun run build:oh-my-pi-extension";
		const connector = "bun run build:connector-oh-my-pi";
		const deps = "bun run build:deps";

		expect(build).toContain(ext);
		expect(build).toContain(connector);
		expect(build).toContain(deps);
		expect(build.indexOf(ext)).toBeLessThan(build.indexOf(connector));
		expect(build.indexOf(connector)).toBeLessThan(build.indexOf(deps));
	});

	it("keeps cli out of the parallel dependency batch", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const path = resolve(dir, "..", "..", "package.json");
		const text = readFileSync(path, "utf8");
		const deps = text.match(/"build:deps":\s*"([^"]+)"/)?.[1] ?? "";

		expect(deps).not.toContain("@signet/cli");
		expect(deps).not.toContain("@signet/connector-oh-my-pi");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiConnector } from "./src/index.js";
import { EXTENSION_BUNDLE } from "./src/extension-bundle.js";

const originalEnv = {
	HOME: process.env.HOME,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
	SIGNET_PATH: process.env.SIGNET_PATH,
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
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-pi-connector-"));
	process.env.HOME = tmpRoot;
	process.env.XDG_CONFIG_HOME = join(tmpRoot, ".config-home");
	process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
	process.env.SIGNET_AGENT_ID = "agent-from-env";
	process.env.SIGNET_DAEMON_URL = "http://127.0.0.1:4123";
	delete process.env.SIGNET_PATH;
});

afterEach(() => {
	restoreEnv("HOME");
	restoreEnv("XDG_CONFIG_HOME");
	restoreEnv("PI_CODING_AGENT_DIR");
	restoreEnv("SIGNET_AGENT_ID");
	restoreEnv("SIGNET_DAEMON_URL");
	restoreEnv("SIGNET_PATH");
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("PiConnector", () => {
	it("installs a bundled managed extension without external package resolution", async () => {
		const connector = new PiConnector();
		const result = await connector.install(tmpRoot);
		const installedPath = join(tmpRoot, "agent", "extensions", "signet-pi.js");
		const configPath = join(tmpRoot, ".config-home", "signet", "pi.json");

		expect(result.success).toBe(true);
		expect(result.filesWritten).toContain(installedPath);
		expect(result.filesWritten).toContain(configPath);
		expect(existsSync(installedPath)).toBe(true);
		expect(existsSync(configPath)).toBe(true);

		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain("SIGNET_MANAGED_PI_EXTENSION");
		expect(content).toContain("Managed by Signet (@signet/pi-extension)");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "agent-from-env")');
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", "http://127.0.0.1:4123")');
		expect(content).toContain(`Reflect.set(__signetRuntimeEnv, "SIGNET_PATH", ${JSON.stringify(tmpRoot)})`);
		expect(content.length).toBeGreaterThan(1_000);
	});

	it("falls back to default agent id when none is configured at install time", async () => {
		Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		const connector = new PiConnector();
		await connector.install(tmpRoot);
		const content = readFileSync(join(tmpRoot, "agent", "extensions", "signet-pi.js"), "utf8");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "default")');
	});

	it("treats blank runtime env values as missing when generating the managed bootstrap", async () => {
		process.env.SIGNET_AGENT_ID = "   ";
		process.env.SIGNET_DAEMON_URL = "\n\t";
		const connector = new PiConnector();
		await connector.install(tmpRoot);
		const content = readFileSync(join(tmpRoot, "agent", "extensions", "signet-pi.js"), "utf8");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "default")');
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", "http://127.0.0.1:3850")');
	});

	it("persists a custom Pi agent dir so later maintenance still finds the managed install", async () => {
		const customAgentDir = join(tmpRoot, "custom-agent-home");
		process.env.PI_CODING_AGENT_DIR = customAgentDir;
		const connector = new PiConnector();
		await connector.install(tmpRoot);

		Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
		const reloadedConnector = new PiConnector();
		expect(reloadedConnector.isInstalled()).toBe(true);

		const uninstall = await reloadedConnector.uninstall();
		expect(uninstall.filesRemoved).toContain(join(customAgentDir, "extensions", "signet-pi.js"));
		expect(uninstall.filesRemoved).toContain(join(tmpRoot, ".config-home", "signet", "pi.json"));
		expect(reloadedConnector.isInstalled()).toBe(false);
	});

	it("returns false for isInstalled when no managed extension exists", () => {
		const connector = new PiConnector();
		expect(connector.isInstalled()).toBe(false);
	});

	it("returns the managed extension path inside PI_CODING_AGENT_DIR/extensions/", () => {
		const connector = new PiConnector();
		expect(connector.getConfigPath()).toBe(join(tmpRoot, "agent", "extensions", "signet-pi.js"));
	});
});

describe("root build pipeline", () => {
	it("builds Pi prerequisites before the shared dependency batch", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const path = resolve(dir, "..", "..", "package.json");
		const text = readFileSync(path, "utf8");

		expect(text).toContain('"build:pi-extension"');
		expect(text).toContain('"build:connector-pi"');

		const build = text.match(/"build":\s*"([^"]+)"/)?.[1] ?? "";
		const ext = "bun run build:pi-extension";
		const connector = "bun run build:connector-pi";
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
		expect(deps).not.toContain("@signet/connector-pi");
	});
});

describe("EXTENSION_BUNDLE integrity", () => {
	// Pi SDK uses different event names than Oh My Pi. These prevent accidental regression
	// to Oh My Pi's event names, which the Pi daemon does not support.
	it("uses Pi SDK session_fork event (not Oh My Pi's session_branch)", () => {
		expect(EXTENSION_BUNDLE).toContain("session_fork");
		expect(EXTENSION_BUNDLE).not.toContain("session_branch");
	});

	it("uses Pi SDK session_before_compact event (not Oh My Pi's session.compacting)", () => {
		expect(EXTENSION_BUNDLE).toContain("session_before_compact");
		expect(EXTENSION_BUNDLE).not.toContain("session.compacting");
	});

	it("includes harness field in remember request body", () => {
		expect(EXTENSION_BUNDLE).toMatch(/hooks\/remember[\s\S]{0,200}harness:/);
	});

	it("uses 127.0.0.1 for the default daemon URL (not localhost)", () => {
		expect(EXTENSION_BUNDLE).toContain("127.0.0.1");
		expect(EXTENSION_BUNDLE).not.toContain("localhost");
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OhMyPiConnector } from "./src/index.js";

const originalEnv = {
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	SIGNET_AGENT_ID: process.env.SIGNET_AGENT_ID,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
};

let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-omp-connector-"));
	process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
	process.env.SIGNET_AGENT_ID = "agent-from-env";
	process.env.SIGNET_DAEMON_URL = "http://127.0.0.1:4123";
});

afterEach(() => {
	process.env.PI_CODING_AGENT_DIR = originalEnv.PI_CODING_AGENT_DIR;
	process.env.SIGNET_AGENT_ID = originalEnv.SIGNET_AGENT_ID;
	process.env.SIGNET_DAEMON_URL = originalEnv.SIGNET_DAEMON_URL;
	if (tmpRoot) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("OhMyPiConnector", () => {
	it("installs a bundled managed extension without external package resolution", async () => {
		const connector = new OhMyPiConnector();
		const result = await connector.install(tmpRoot);
		const installedPath = join(tmpRoot, "agent", "extensions", "signet-oh-my-pi.js");

		expect(result.success).toBe(true);
		expect(result.filesWritten).toContain(installedPath);
		expect(existsSync(installedPath)).toBe(true);

		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain("SIGNET_MANAGED_OH_MY_PI_EXTENSION");
		expect(content).toContain("Managed by Signet (@signet/oh-my-pi-extension)");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "agent-from-env")');
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_DAEMON_URL", "http://127.0.0.1:4123")');
		expect(content).toContain(`Reflect.set(__signetRuntimeEnv, "SIGNET_PATH", ${JSON.stringify(tmpRoot)})`);
		expect(content.length).toBeGreaterThan(1_000);
	});

	it("falls back to default agent id when none is configured at install time", async () => {
		process.env.SIGNET_AGENT_ID = undefined;
		const connector = new OhMyPiConnector();
		await connector.install(tmpRoot);

		const installedPath = join(tmpRoot, "agent", "extensions", "signet-oh-my-pi.js");
		const content = readFileSync(installedPath, "utf8");
		expect(content).toContain('Reflect.set(__signetRuntimeEnv, "SIGNET_AGENT_ID", "default")');
	});
});

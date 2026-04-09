import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	type InstallResult,
	type UninstallResult,
	BaseConnector,
	resolveSignetDaemonUrl,
	resolveSignetWorkspacePath,
} from "./src/index";

class TestConnector extends BaseConnector {
	readonly name = "Test";
	readonly harnessId = "test";

	public cleanup(path: string): string | null {
		return this.stripLegacySignetBlock(path);
	}

	async install(_basePath: string): Promise<InstallResult> {
		return { success: true, message: "ok", filesWritten: [] };
	}

	async uninstall(): Promise<UninstallResult> {
		return { filesRemoved: [] };
	}

	isInstalled(): boolean {
		return false;
	}

	getConfigPath(): string {
		return "";
	}
}

let dir = "";
const originalEnv = {
	SIGNET_PATH: process.env.SIGNET_PATH,
	SIGNET_DAEMON_URL: process.env.SIGNET_DAEMON_URL,
	SIGNET_HOST: process.env.SIGNET_HOST,
	SIGNET_PORT: process.env.SIGNET_PORT,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
			continue;
		}
		process.env[key] = value;
	}
});

describe("BaseConnector.stripLegacySignetBlock", () => {
	it("removes SIGNET marker block from AGENTS.md in place", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-test-"));
		const file = join(dir, "AGENTS.md");
		writeFileSync(
			file,
			`before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n`,
			"utf-8",
		);

		const connector = new TestConnector();
		const strippedPath = connector.cleanup(dir);
		expect(strippedPath).toBe(file);
		expect(readFileSync(file, "utf-8")).toBe("before\nafter\n");
	});

	it("does nothing when AGENTS.md has no SIGNET block", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-test-"));
		const file = join(dir, "AGENTS.md");
		writeFileSync(file, "plain content\n", "utf-8");

		const connector = new TestConnector();
		const strippedPath = connector.cleanup(dir);
		expect(strippedPath).toBeNull();
		expect(readFileSync(file, "utf-8")).toBe("plain content\n");
	});

	it("does nothing when AGENTS.md is missing", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-test-"));

		const connector = new TestConnector();
		const strippedPath = connector.cleanup(dir);
		expect(strippedPath).toBeNull();
		expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
	});
});

describe("resolveSignetDaemonUrl", () => {
	it("uses the parsed numeric port rather than the raw env string", () => {
		delete process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_HOST = "127.0.0.1";
		process.env.SIGNET_PORT = "3850abc";

		expect(resolveSignetDaemonUrl()).toBe("http://127.0.0.1:3850");
	});

	it("falls back to localhost-safe defaults when host contains URL control characters", () => {
		delete process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_HOST = "127.0.0.1@evil.com";
		process.env.SIGNET_PORT = "4123";

		expect(resolveSignetDaemonUrl()).toBe("http://127.0.0.1:4123");
	});
});

describe("resolveSignetWorkspacePath", () => {
	it("normalizes SIGNET_PATH when provided directly", () => {
		const relativeWorkspace = "./tmp/signet-workspace";
		process.env.SIGNET_PATH = relativeWorkspace;

		expect(resolveSignetWorkspacePath()).toBe(resolve(relativeWorkspace));
	});

	it("expands and normalizes the configured workspace path", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-workspace-"));
		process.env.XDG_CONFIG_HOME = dir;
		const rel = relative(homedir(), dir);
		const tildeWorkspace = `~/${rel}/../${relative(homedir(), dir)}/agents`;
		const cfgDir = join(dir, "signet");
		const cfgPath = join(cfgDir, "workspace.json");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(
			cfgPath,
			JSON.stringify({
				version: 1,
				workspace: tildeWorkspace,
				updatedAt: new Date().toISOString(),
			}),
			"utf-8",
		);

		expect(resolveSignetWorkspacePath()).toBe(
			resolve(join(homedir(), rel, "..", rel, "agents")),
		);
	});
});

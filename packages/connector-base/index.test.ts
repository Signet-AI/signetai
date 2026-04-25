import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	removeManagedExtensionFile,
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
		writeFileSync(file, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");

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
	it("uses a valid explicit daemon URL override", () => {
		process.env.SIGNET_DAEMON_URL = " https://example.test/ ";

		expect(resolveSignetDaemonUrl()).toBe("https://example.test");
	});

	it("rejects invalid explicit daemon URLs instead of falling back to loopback defaults", () => {
		process.env.SIGNET_DAEMON_URL = "file:///tmp/signet.sock";
		process.env.SIGNET_HOST = "127.0.0.1";
		process.env.SIGNET_PORT = "4123";

		expect(() => resolveSignetDaemonUrl()).toThrow("SIGNET_DAEMON_URL must use http or https");
	});

	it("rejects explicit daemon URLs with a non-root path", () => {
		process.env.SIGNET_DAEMON_URL = "https://example.test/custom";
		process.env.SIGNET_HOST = "127.0.0.1";
		process.env.SIGNET_PORT = "4123";

		expect(() => resolveSignetDaemonUrl()).toThrow("SIGNET_DAEMON_URL must point at the daemon origin");
	});

	it("rejects invalid port values instead of falling back to the default port", () => {
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_HOST = "127.0.0.1";
		process.env.SIGNET_PORT = "3850abc";

		expect(() => resolveSignetDaemonUrl()).toThrow("SIGNET_PORT must be an integer");
	});

	it("rejects hosts that contain URL control characters", () => {
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_HOST = "127.0.0.1@evil.com";
		process.env.SIGNET_PORT = "4123";

		expect(() => resolveSignetDaemonUrl()).toThrow("SIGNET_HOST must be a hostname or IP address");
	});

	it("rejects degenerate host values that only contain separators", () => {
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_HOST = "...";
		process.env.SIGNET_PORT = "4123";

		expect(() => resolveSignetDaemonUrl()).toThrow("SIGNET_HOST must be a hostname or IP address");
	});

	it("rejects out-of-range port values", () => {
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_HOST = "127.0.0.1";
		process.env.SIGNET_PORT = "70000";

		expect(() => resolveSignetDaemonUrl()).toThrow("SIGNET_PORT must be an integer");
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

		expect(resolveSignetWorkspacePath()).toBe(resolve(join(homedir(), rel, "..", rel, "agents")));
	});
});

describe("removeManagedExtensionFile", () => {
	it("removes files that contain the managed marker", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-managed-file-"));
		const filePath = join(dir, "managed.js");
		writeFileSync(filePath, "// signet-managed\nconst x = 1;\n", "utf-8");

		expect(removeManagedExtensionFile(filePath, "signet-managed")).toBe(true);
		expect(existsSync(filePath)).toBe(false);
	});

	it("leaves unmanaged files in place", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-unmanaged-file-"));
		const filePath = join(dir, "plain.js");
		writeFileSync(filePath, "const x = 1;\n", "utf-8");

		expect(removeManagedExtensionFile(filePath, "signet-managed")).toBe(false);
		expect(existsSync(filePath)).toBe(true);
	});
});

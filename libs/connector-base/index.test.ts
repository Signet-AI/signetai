import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
	atomicWriteText,
	removeManagedExtensionFile,
	resolveSignetCliCommand,
	resolveSignetDaemonUrl,
	resolveSignetMcpCommand,
	resolveSignetWorkspacePath,
} from "./src/index";
import { parseLenientJsonObject } from "./src/lenient-json";

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

describe("atomicWriteText", () => {
	it("replaces text without changing its contents", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-atomic-"));
		const file = join(dir, "config.jsonc");
		writeFileSync(file, "old\n", "utf-8");
		if (process.platform !== "win32") chmodSync(file, 0o600);

		atomicWriteText(file, "{\n  // preserved\n}\n");

		expect(readFileSync(file, "utf-8")).toBe("{\n  // preserved\n}\n");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe("packaged Signet command resolution", () => {
	const originalPlatform = process.platform;
	const originalArgv = process.argv;
	const originalExecPath = process.execPath;
	const originalWarn = console.warn;

	afterEach(() => {
		process.platform = originalPlatform;
		process.argv = originalArgv;
		process.execPath = originalExecPath;
		console.warn = originalWarn;
	});

	it("uses bare commands outside Windows", () => {
		process.platform = "darwin";

		expect(resolveSignetMcpCommand()).toEqual({ command: "signet-mcp", args: [] });
		expect(resolveSignetCliCommand()).toEqual({ command: "signet", args: [] });
	});

	it("resolves packaged Windows entry points from the Signet CLI path", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-command-resolution-"));
		const cliEntry = join(dir, "bin", "signet.js");
		const mcpEntry = join(dir, "dist", "mcp-stdio.js");
		mkdirSync(join(dir, "bin"), { recursive: true });
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(cliEntry, "", "utf8");
		writeFileSync(mcpEntry, "", "utf8");
		process.platform = "win32";
		process.argv = ["node", cliEntry];
		process.execPath = "C:\\Program Files\\nodejs\\node.exe";

		expect(resolveSignetMcpCommand()).toEqual({ command: process.execPath, args: [mcpEntry] });
		expect(resolveSignetCliCommand()).toEqual({ command: process.execPath, args: [cliEntry] });
	});

	it("warns once and returns the bare MCP command when the Windows entry point is missing", () => {
		const warnings: string[] = [];
		process.platform = "win32";
		process.argv = ["node", "C:\\missing\\signetai\\bin\\signet.js"];
		console.warn = (message?: unknown) => warnings.push(String(message));

		expect(resolveSignetMcpCommand()).toEqual({ command: "signet-mcp", args: [] });
		expect(warnings).toEqual([
			'[signet] Warning: could not resolve mcp-stdio.js from argv[1]="C:\\missing\\signetai\\bin\\signet.js". MCP server config will use "signet-mcp" which may fail on Windows without shell:true.',
		]);
	});
});

describe("parseLenientJsonObject", () => {
	it("parses BOM-prefixed JSONC with line and block comments and trailing commas", () => {
		const parsed = parseLenientJsonObject(
			'\uFEFF{\n  // line comment\n  "nested": {\n    /* block comment */\n    "enabled": true,\n  },\n}\n',
			{ label: "Test config" },
		);

		expect(parsed).toEqual({ nested: { enabled: true } });
	});

	it("preserves OpenClaw JSON5 compatibility for unquoted keys and single-quoted strings", () => {
		const parsed = parseLenientJsonObject("{ gateway: { mode: 'local' } }", {
			label: "OpenClaw config",
		});

		expect(parsed).toEqual({ gateway: { mode: "local" } });
	});

	it.each(["[]", "null", '"value"', "42"])("rejects a non-object top level: %s", (raw) => {
		expect(() => parseLenientJsonObject(raw, { label: "Test config" })).toThrow(
			"Invalid Test config: expected a top-level object",
		);
	});

	it("reports malformed input with the caller label, offset, and parse code", () => {
		expect(() => parseLenientJsonObject("{ invalid", { label: "OpenCode config" })).toThrow(
			/^Invalid OpenCode config at offset \d+ \([A-Za-z]+\)$/,
		);
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

	it("uses the default workspace path when no persisted config exists", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-workspace-"));
		process.env.XDG_CONFIG_HOME = dir;

		expect(resolveSignetWorkspacePath()).toBe(join(homedir(), ".agents"));
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

	it("rejects malformed persisted workspace config instead of falling back to ~/.agents", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-workspace-"));
		process.env.XDG_CONFIG_HOME = dir;
		const cfgDir = join(dir, "signet");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(join(cfgDir, "workspace.json"), "{not json", "utf-8");

		expect(() => resolveSignetWorkspacePath()).toThrow("Invalid Signet workspace config");
	});

	it("rejects persisted workspace config without a non-empty workspace path", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-connector-base-workspace-"));
		process.env.XDG_CONFIG_HOME = dir;
		const cfgDir = join(dir, "signet");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(join(cfgDir, "workspace.json"), JSON.stringify({ version: 1, workspace: "  " }), "utf-8");

		expect(() => resolveSignetWorkspacePath()).toThrow("workspace must be a non-empty string");
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

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import {
	cliFromMcp,
	parseHookLauncher,
	readMcpLauncher,
	resolveSignetCliCommand,
	resolveSignetMcpCommand,
} from "./src/index";

const keys = ["SIGNET_HOOK_COMMAND", "SIGNET_CLI_PATH", "SIGNET_DIR", "SIGNET_WRAPPER_DIR"];
const saved = new Map<string, string | undefined>();
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "signet-launcher-"));
	for (const key of keys) {
		saved.set(key, process.env[key]);
		Reflect.deleteProperty(process.env, key);
	}
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	for (const [key, value] of saved) {
		if (value === undefined) Reflect.deleteProperty(process.env, key);
		if (value !== undefined) process.env[key] = value;
	}
});

test.each([
	{ command: "/usr/bin/python3", args: ["srv.py"], env: { SIGNET_MCP_STDIO_WORKER: "1" } },
	{ command: "/host/foo-signet-mcp", args: [] },
	{ command: "/host/python3", args: ["/host/dist/mcp-stdio.js"] },
])("never converts an unrelated MCP launcher into a hook: %j", (launcher) => {
	expect(cliFromMcp(launcher)).toBeUndefined();
});

test.each([
	{ command: "/usr/bin/python3", args: ["srv.py"] },
	{ command: "/host/foo-signet-mcp", args: [] },
	{ command: "/host/signet", args: ["--config", "unrelated"] },
])("does not retain a third-party MCP server named signet: %j", (launcher) => {
	expect(readMcpLauncher(launcher)).toBeUndefined();
});

test("keeps recognized MCP arguments without reusing them as hook arguments", () => {
	const launcher = { command: "/host/signet-mcp", args: ["--fixture"], env: { CUSTOM: "keep" } };
	expect(resolveSignetMcpCommand(readMcpLauncher(launcher))).toEqual(launcher);
	expect(cliFromMcp(launcher)).toBeUndefined();
});

test.each([
	"/usr/bin/signet -c custom hook session-start -H claude-code",
	"signet $(touch marker) hook session-start -H claude-code",
	"node --eval payload /x/signet.js hook session-start -H claude-code",
	"$(echo /usr/bin/signet) hook session-start -H claude-code",
])("does not carry arbitrary hook launcher arguments forward: %s", (command) => {
	expect(parseHookLauncher(command)).toBeUndefined();
});

test.each(["node /x/signet.js", "[broken", "[]", '["signet",1]'])(
	"rejects malformed overrides with an actionable error: %s",
	(value) => {
		process.env.SIGNET_HOOK_COMMAND = value;
		for (const resolve of [resolveSignetCliCommand, resolveSignetMcpCommand]) {
			expect(() => resolve()).toThrow(
				/SIGNET_HOOK_COMMAND must be an executable path without whitespace or a nonempty JSON argv array/,
			);
		}
	},
);

test("explicit paths outrank existing launchers without a local existence check", () => {
	const command = join(root, "missing", "signet");
	process.env.SIGNET_CLI_PATH = command;
	const existing = { command: "/old/signet", args: [] };
	expect(resolveSignetCliCommand(existing)).toEqual({ command, args: [] });
	expect(resolveSignetMcpCommand({ ...existing, env: { SIGNET_MCP_STDIO_WORKER: "1" } })).toEqual({
		command,
		args: [],
		env: { SIGNET_MCP_STDIO_WORKER: "1" },
	});
	const runtime = join(root, "missing", "node");
	const script = join(root, "missing", "bin", "signet.js");
	process.env.SIGNET_HOOK_COMMAND = JSON.stringify([runtime, script]);
	expect(resolveSignetCliCommand(existing)).toEqual({ command: runtime, args: [script] });
});

test.each([resolveSignetCliCommand, resolveSignetMcpCommand])(
	"replaces stale nvm launchers only in a visible namespace: %p",
	(resolve) => {
		mkdirSync(join(root, "bin"), { recursive: true });
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "bin", "signet.js"), "");
		writeFileSync(join(root, "dist", "mcp-stdio.js"), "");
		process.env.SIGNET_WRAPPER_DIR = root;
		const runtime = join(root, ".nvm", "versions", "old", "node");
		const script = join(root, ".nvm", "versions", "old", "bin", "signet.js");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const present of ["neither", "runtime", "script"]) {
				rmSync(join(root, ".nvm"), { recursive: true, force: true });
				mkdirSync(join(script, ".."), { recursive: true });
				if (present === "runtime") writeFileSync(runtime, "");
				if (present === "script") writeFileSync(script, "");
				warn.mockClear();
				const existing = { command: runtime, args: [script] };
				const replacement = resolve(undefined, process.execPath);
				expect(resolve(existing, process.execPath)).toEqual(replacement);
				expect(warn).toHaveBeenCalledTimes(1);
				expect(warn.mock.calls[0]?.join(" ")).toContain(runtime);
				expect(warn.mock.calls[0]?.join(" ")).toContain(replacement.command);
				expect(warn.mock.calls[0]?.join(" ")).toContain(replacement.args[0] ?? "");
			}
		} finally {
			warn.mockRestore();
		}
	},
);

test.each([resolveSignetCliCommand, resolveSignetMcpCommand])(
	"keeps an invisible-root host launcher with one actionable warning: %p",
	(resolve) => {
		const base = parse(root).root;
		const first = root.slice(base.length).split(/[\\/]/)[0] ?? "";
		const missing = `signet-unmounted-${crypto.randomUUID()}`;
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const command of [join(base, missing, "host", "signet"), join(base, first, missing, "signet")]) {
				const existing = { command, args: [], env: { SIGNET_MCP_STDIO_WORKER: "1" } };
				warn.mockClear();
				expect(resolve(existing)).toEqual(existing);
				expect(warn).toHaveBeenCalledTimes(1);
				expect(warn.mock.calls[0]?.join(" ")).toContain("could not be verified from this environment");
				expect(warn.mock.calls[0]?.join(" ")).toContain("SIGNET_HOOK_COMMAND");
			}
		} finally {
			warn.mockRestore();
		}
	},
);

test.each([resolveSignetCliCommand, resolveSignetMcpCommand])(
	"keeps a launcher whose path cannot be inspected instead of aborting: %p",
	(resolve) => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const command of [join(root, "bad\0name", "signet"), join(root, "x".repeat(300), "signet")]) {
				const existing = { command, args: [], env: { SIGNET_MCP_STDIO_WORKER: "1" } };
				warn.mockClear();
				expect(resolve(existing)).toEqual(existing);
				expect(warn.mock.calls[0]?.join(" ")).toContain("could not be verified from this environment");
			}
		} finally {
			warn.mockRestore();
		}
	},
);

test.each([resolveSignetCliCommand, resolveSignetMcpCommand])(
	"keeps valid existing launchers and bare commands without a warning: %p",
	(resolve) => {
		const runtime = join(root, "node");
		const script = join(root, "signet.js");
		writeFileSync(runtime, "");
		writeFileSync(script, "");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (const existing of [
				{ command: runtime, args: [script] },
				{ command: "signet", args: [], env: { SIGNET_MCP_STDIO_WORKER: "1" } },
			])
				expect(resolve(existing)).toEqual(existing);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	},
);

test("runs the MCP worker for an overridden signet.js outside bin", () => {
	const script = join(root, "signet.js");
	process.env.SIGNET_HOOK_COMMAND = JSON.stringify([process.execPath, script]);
	expect(resolveSignetMcpCommand()).toEqual({
		command: process.execPath,
		args: [script],
		env: { SIGNET_MCP_STDIO_WORKER: "1" },
	});
});

test.each([
	"'/host/My Tools/signet' hook session-start -H claude-code",
	'"C:\\Program Files\\Bun\\bun.exe" "C:\\signet\\bin\\signet.js" hook session-start -H claude-code',
	"SIGNET_API_KEY='old' /host/signet hook session-start -H claude-code",
])("retains generated launcher forms: %s", (command) => {
	expect(parseHookLauncher(command)).toBeDefined();
});

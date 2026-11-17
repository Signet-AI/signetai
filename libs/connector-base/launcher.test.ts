import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	cliFromMcp,
	parseHookLauncher,
	readMcpLauncher,
	resolveSignetCliCommand,
	resolveSignetMcpCommand,
} from "./src/index";

const keys = ["SIGNET_HOOK_COMMAND", "SIGNET_CLI_PATH", "SIGNET_DIR", "SIGNET_WRAPPER_DIR"];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of keys) {
		saved.set(key, process.env[key]);
		Reflect.deleteProperty(process.env, key);
	}
});

afterEach(() => {
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
	process.env.SIGNET_CLI_PATH = "/unmounted/host/signet";
	const existing = { command: "/old/signet", args: [] };
	expect(resolveSignetCliCommand(existing)).toEqual({ command: "/unmounted/host/signet", args: [] });
	expect(resolveSignetMcpCommand({ ...existing, env: { SIGNET_MCP_STDIO_WORKER: "1" } })).toEqual({
		command: "/unmounted/host/signet",
		args: [],
		env: { SIGNET_MCP_STDIO_WORKER: "1" },
	});
	process.env.SIGNET_HOOK_COMMAND = '["/preferred/node","/host/bin/signet.js"]';
	expect(resolveSignetCliCommand(existing)).toEqual({ command: "/preferred/node", args: ["/host/bin/signet.js"] });
});

test.each([
	"'/host/My Tools/signet' hook session-start -H claude-code",
	'"C:\\Program Files\\Bun\\bun.exe" "C:\\signet\\bin\\signet.js" hook session-start -H claude-code',
	"SIGNET_API_KEY='old' /host/signet hook session-start -H claude-code",
])("retains generated launcher forms: %s", (command) => {
	expect(parseHookLauncher(command)).toBeDefined();
});

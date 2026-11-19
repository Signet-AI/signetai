import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("node:os", () => ({
	...realOs,
	default: { ...realOs, homedir: () => process.env.HOME ?? realOs.homedir() },
	homedir: () => process.env.HOME ?? realOs.homedir(),
}));

const { ClaudeCodeConnector, dispatchSessionEndFireAndForget } = await import("./src/index.js");
type SessionEndFireAndForgetPayload = import("./src/index.js").SessionEndFireAndForgetPayload;

const origHome = process.env.HOME;
let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-claude-code-test-"));
	process.env.HOME = tmpRoot;
});

afterAll(() => {
	mock.module("node:os", () => realOs);
});

afterEach(() => {
	if (origHome !== undefined) process.env.HOME = origHome;
	else Reflect.deleteProperty(process.env, "HOME");
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ClaudeCodeConnector.install — legacy SIGNET block migration", () => {
	it("dispatches session-end through a detached child process", () => {
		let capturedCommand = "";
		let capturedArgs: string[] = [];
		let capturedOptions: Record<string, unknown> | undefined;
		let unrefCalled = false;
		const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
			capturedCommand = command;
			capturedArgs = args;
			capturedOptions = options;
			return {
				unref() {
					unrefCalled = true;
				},
			};
		}) as never;

		const ok = dispatchSessionEndFireAndForget(
			"http://localhost:3850/",
			{
				harness: "claude-code",
				sessionId: "session-123",
				transcriptPath: "/tmp/transcript.jsonl",
			},
			fakeSpawn,
		);

		expect(ok).toBe(true);
		expect(capturedCommand).toBe(process.execPath);
		expect(capturedArgs[0]).toBe("--eval");
		expect(capturedArgs).toHaveLength(2);
		const capturedEnv = capturedOptions?.env as Record<string, string | undefined> | undefined;
		expect(capturedEnv?.SIGNET_SESSION_END_URL).toBe("http://localhost:3850/api/hooks/session-end");
		expect(JSON.parse(capturedEnv?.SIGNET_SESSION_END_BODY ?? "{}")).toEqual({
			harness: "claude-code",
			sessionId: "session-123",
			transcriptPath: "/tmp/transcript.jsonl",
		});
		expect(capturedOptions).toMatchObject({ detached: true, stdio: "ignore" });
		expect(unrefCalled).toBe(true);
	});

	it("posts session-end payload from the detached child process", async () => {
		let server: ReturnType<typeof Bun.serve> | undefined;
		try {
			const received = new Promise<{ path: string; body: unknown; contentType: string | null }>((resolve) => {
				server = Bun.serve({
					port: 0,
					async fetch(req) {
						const url = new URL(req.url);
						const body = await req.json();
						resolve({
							path: url.pathname,
							body,
							contentType: req.headers.get("content-type"),
						});
						return new Response("ok");
					},
				});
			});
			const ok = dispatchSessionEndFireAndForget(`http://127.0.0.1:${server.port}`, {
				harness: "claude-code",
				sessionId: "session-real-child",
				transcriptPath: "/tmp/real-child.jsonl",
			});
			expect(ok).toBe(true);

			const result = await Promise.race([
				received,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timed out waiting for child POST")), 2500),
				),
			]);
			expect(result.path).toBe("/api/hooks/session-end");
			expect(result.contentType).toContain("application/json");
			expect(result.body).toEqual({
				harness: "claude-code",
				sessionId: "session-real-child",
				transcriptPath: "/tmp/real-child.jsonl",
			});
		} finally {
			server?.stop(true);
		}
	});

	it("reports session-end dispatch startup failures", async () => {
		class TestConnector extends ClaudeCodeConnector {
			lastPayload: SessionEndFireAndForgetPayload | undefined;

			protected override dispatchSessionEnd(payload: SessionEndFireAndForgetPayload): boolean {
				this.lastPayload = payload;
				return false;
			}
		}

		const connector = new TestConnector();
		const result = await connector.onSessionEnd({
			sessionId: "session-failed-dispatch",
			transcriptPath: "/tmp/failed-dispatch.jsonl",
		});

		expect(result).toEqual({ success: false, memoriesExtracted: 0 });
		expect(connector.lastPayload).toEqual({
			harness: "claude-code",
			sessionId: "session-failed-dispatch",
			transcriptPath: "/tmp/failed-dispatch.jsonl",
		});
	});

	it("strips legacy block from AGENTS.md and reports path in filesWritten", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "before\n<!-- SIGNET:START -->\nmanaged block\n<!-- SIGNET:END -->\nafter\n", "utf-8");
		const result = await new ClaudeCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("before\nafter\n");
		expect(result.filesWritten).toContain(agentsPath);
	});

	it("leaves AGENTS.md untouched when no legacy block present", async () => {
		const agentsPath = join(tmpRoot, "AGENTS.md");
		writeFileSync(agentsPath, "plain content\n", "utf-8");
		const result = await new ClaudeCodeConnector().install(tmpRoot);
		expect(readFileSync(agentsPath, "utf-8")).toBe("plain content\n");
		expect(result.filesWritten).not.toContain(agentsPath);
	});
});

const settingsFile = () => join(tmpRoot, ".claude", "settings.json");
const readHooks = () => JSON.parse(readFileSync(settingsFile(), "utf-8")).hooks as Record<string, unknown[]>;
const commandsOf = (groups: unknown[]) =>
	groups.flatMap((g) => (g as { hooks: Array<Record<string, unknown>> }).hooks ?? []);

describe("ClaudeCodeConnector wake hooks", () => {
	const stopHooksMatching = (hooks: Record<string, unknown[]>, pattern: RegExp) =>
		commandsOf(hooks.Stop ?? []).filter((h) => pattern.test(String(h.command)));
	const stopCapture = (hooks: Record<string, unknown[]>) => stopHooksMatching(hooks, /\bhook stop\b/);
	const stopWake = (hooks: Record<string, unknown[]>) => stopHooksMatching(hooks, /\bhook wake\b/);

	it("installs asyncRewake wake hooks on SessionStart and Stop", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		const hooks = readHooks();
		const start = commandsOf(hooks.SessionStart ?? []);
		expect(String(start[0]?.command)).toContain("hook session-start");
		const wakeStart = start.filter((h) => String(h.command).includes("hook wake"));
		expect(wakeStart).toHaveLength(1);
		expect(wakeStart[0]?.asyncRewake).toBe(true);
		expect(wakeStart[0]?.timeout).toBe(3600);
		expect(String(wakeStart[0]?.command)).toContain('hook wake -H claude-code --project "');
		const stop = stopWake(hooks);
		expect(stop).toHaveLength(1);
		expect(stop[0]?.asyncRewake).toBe(true);
	});

	it("installs an async Stop hook that records the turn-end reply, and no SubagentStop hook", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		const hooks = readHooks();
		const capture = stopCapture(hooks);
		expect(capture).toHaveLength(1);
		expect(String(capture[0]?.command)).toContain("hook stop -H claude-code");
		expect(capture[0]?.async).toBe(true);
		expect(capture[0]?.asyncRewake).toBeUndefined();
		expect(hooks.SubagentStop).toBeUndefined();
	});

	it("stop:false leaves the reply capture out and keeps the wake hook", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		await new ClaudeCodeConnector({ hooks: { stop: false } } as never).install(tmpRoot);
		const hooks = readHooks();
		expect(stopCapture(hooks)).toHaveLength(0);
		expect(stopWake(hooks)).toHaveLength(1);
	});

	it("is idempotent and preserves user Stop hooks", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
		writeFileSync(
			settingsFile(),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
			"utf-8",
		);
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		await connector.install(tmpRoot);
		const hooks = readHooks();
		const stop = commandsOf(hooks.Stop ?? []);
		expect(stop.filter((h) => String(h.command).includes("hook wake"))).toHaveLength(1);
		expect(stopCapture(hooks)).toHaveLength(1);
		expect(stop.filter((h) => h.command === "echo mine")).toHaveLength(1);
		expect(commandsOf(hooks.SessionStart ?? []).filter((h) => String(h.command).includes("hook wake"))).toHaveLength(1);
	});

	it("uninstall removes wake hooks but keeps user Stop hooks", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
		writeFileSync(
			settingsFile(),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
			"utf-8",
		);
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		await connector.uninstall();
		const hooks = readHooks();
		expect(hooks.SessionStart).toBeUndefined();
		const stop = commandsOf(hooks.Stop ?? []);
		expect(stop.map((h) => h.command)).toEqual(["echo mine"]);
	});

	it("sessionStart:false removes Signet session-start and wake hooks but keeps user hooks", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
		await new ClaudeCodeConnector().install(tmpRoot);
		const installed = JSON.parse(readFileSync(settingsFile(), "utf-8"));
		installed.hooks.SessionStart.push({ hooks: [{ type: "command", command: "echo start" }] });
		writeFileSync(settingsFile(), JSON.stringify(installed), "utf-8");
		await new ClaudeCodeConnector({ hooks: { sessionStart: false } } as never).install(tmpRoot);
		const hooks = readHooks();
		expect(commandsOf(hooks.SessionStart ?? []).map((h) => h.command)).toEqual(["echo start"]);
		expect(stopWake(hooks)).toHaveLength(0);
		expect(stopCapture(hooks)).toHaveLength(1);
	});

	it("sessionStart:false drops empty SessionStart", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		await new ClaudeCodeConnector({ hooks: { sessionStart: false } } as never).install(tmpRoot);
		const hooks = readHooks();
		expect(hooks.SessionStart).toBeUndefined();
		expect(stopWake(hooks)).toHaveLength(0);
	});

	it("drops an empty Stop when both the wake hook and the reply capture are off", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		await new ClaudeCodeConnector({ hooks: { sessionStart: false, stop: false } } as never).install(tmpRoot);
		expect(readHooks().Stop).toBeUndefined();
	});
});

describe("ClaudeCodeConnector hook timeouts", () => {
	const budgetVars = ["SIGNET_SESSION_START_TIMEOUT", "SIGNET_FETCH_TIMEOUT", "SIGNET_PROMPT_SUBMIT_TIMEOUT"];
	const savedBudgets = new Map<string, string | undefined>();
	const timeoutsByHook = () =>
		Object.fromEntries(
			commandsOf(Object.values(readHooks()).flat())
				.filter((h) => h.timeout !== undefined)
				.map((h) => [/\bhook ([a-z-]+)/.exec(String(h.command))?.[1], h.timeout]),
		);

	beforeEach(() => {
		for (const name of budgetVars) {
			savedBudgets.set(name, process.env[name]);
			Reflect.deleteProperty(process.env, name);
		}
	});

	afterEach(() => {
		for (const [name, value] of savedBudgets) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
	});

	it("writes every Signet hook timeout in seconds", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		expect(timeoutsByHook()).toEqual({
			"session-start": 17,
			wake: 3600,
			"user-prompt-submit": 7,
			notifications: 7,
			"pre-compaction": 7,
			"session-end": 15,
		});
	});

	it("rounds a millisecond budget plus the grace up to whole seconds", async () => {
		process.env.SIGNET_SESSION_START_TIMEOUT = "20500";
		process.env.SIGNET_PROMPT_SUBMIT_TIMEOUT = "7500";
		await new ClaudeCodeConnector().install(tmpRoot);
		expect(timeoutsByHook()).toMatchObject({ "session-start": 23, "user-prompt-submit": 10, notifications: 10 });
	});
});

describe("ClaudeCodeConnector user hooks", () => {
	const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PreCompact", "SessionEnd", "Stop"] as const;
	const commands = (groups: unknown[] | undefined) =>
		(groups ?? []).flatMap((g) =>
			((g as { hooks?: Array<{ command?: unknown }> }).hooks ?? []).map((h) => String(h.command)),
		);
	const userCommand = (event: string) => (event === "PreToolUse" ? "rtk hook claude" : `other-tool ${event}`);
	const userGroup = (event: string) => ({
		matcher: event === "PreToolUse" ? "Bash" : "*",
		hooks: [{ type: "command", command: userCommand(event) }],
	});

	const writeSettings = (settings: Record<string, unknown>) => {
		mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
		writeFileSync(settingsFile(), JSON.stringify(settings), "utf-8");
	};
	const userGroups = (event: string) =>
		event === "PreToolUse"
			? [userGroup(event), { matcher: "Bash", hooks: [{ type: "command", command: "caveman-blocks hook" }] }]
			: [userGroup(event)];
	const writeUserHooks = () =>
		writeSettings({ hooks: Object.fromEntries(events.map((event) => [event, userGroups(event)])), model: "opus" });

	it("keeps user hooks on every event across repeated installs", async () => {
		writeUserHooks();
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		await connector.install(tmpRoot);
		expect(connector.isInstalled()).toBe(true);
		const hooks = readHooks();
		for (const event of events) {
			const cmds = commands(hooks[event]);
			expect(hooks[event]?.slice(0, userGroups(event).length)).toEqual(userGroups(event));
			expect(cmds.filter((c) => c === userCommand(event))).toHaveLength(1);
			expect(cmds.some((c) => c.includes("-H claude-code"))).toBe(true);
			expect(new Set(cmds).size).toBe(cmds.length);
		}
	});

	it("uninstall removes only Signet hooks and keeps other settings", async () => {
		writeUserHooks();
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		await connector.uninstall();
		const settings = JSON.parse(readFileSync(settingsFile(), "utf-8"));
		expect(settings.model).toBe("opus");
		for (const event of events) {
			expect(settings.hooks[event]).toEqual(userGroups(event));
		}
	});

	it("uninstall drops the hooks key when only Signet hooks were there", async () => {
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		await connector.uninstall();
		expect(readHooks()).toBeUndefined();
	});

	it("removes a disabled Signet hook but keeps the user hook on that event", async () => {
		writeUserHooks();
		await new ClaudeCodeConnector().install(tmpRoot);
		await new ClaudeCodeConnector({ hooks: { preCompact: false } } as never).install(tmpRoot);
		expect(readHooks().PreCompact).toEqual([userGroup("PreCompact")]);
	});

	it("removes Signet entries from the legacy PreCompaction event and keeps user entries", async () => {
		writeSettings({
			hooks: {
				PreCompaction: [
					{ hooks: [{ type: "command", command: 'signet hook pre-compaction -H claude-code --project "$(pwd)"' }] },
					userGroup("PreCompaction"),
				],
			},
		});
		await new ClaudeCodeConnector().install(tmpRoot);
		expect(readHooks().PreCompaction).toEqual([userGroup("PreCompaction")]);
	});

	it("keeps user commands that only look like Signet hooks", async () => {
		const lookalikes = [
			{ hooks: [{ type: "command", command: "my-wrapper hook wake -H claude-code" }] },
			{ hooks: [{ type: "command", command: "my-signet hook session-start -H claude-code" }] },
			{ hooks: [{ type: "command", command: "signet hook custom -H claude-code" }] },
			{ hooks: [{ type: "command", command: "/usr/bin/signet -c custom hook session-start -H claude-code" }] },
			{ hooks: [{ type: "command", command: "signet $(touch marker) hook session-start -H claude-code" }] },
			{ hooks: [{ type: "command", command: "echo /tmp/signet hook wake -H claude-code" }] },
			{ hooks: [{ type: "command", command: 'echo "/opt/my tools/signet" hook wake -H claude-code' }] },
			{ hooks: [{ type: "command", command: "echo '/opt/my tools/signet' hook wake -H claude-code" }] },
			{ hooks: [{ type: "command", command: '"/opt/wrapper" "/opt/signet/bin/signet.js" hook wake -H claude-code' }] },
		];
		writeSettings({ hooks: { Stop: lookalikes } });
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		expect(readHooks().Stop?.slice(0, lookalikes.length)).toEqual(lookalikes);
		await connector.uninstall();
		expect(readHooks().Stop).toEqual(lookalikes);
	});

	for (const executable of [
		"signet",
		"/opt/signet",
		'"/opt/my tools/signet"',
		"'/opt/my tools/signet'",
		'"C:\\node.exe" "C:\\signet\\bin\\signet.js"',
		'"C:\\Program Files\\Bun\\bun.exe" "C:\\signet\\bin\\signet.js"',
	]) {
		it(`detects, replaces and removes hooks invoked with ${executable}`, async () => {
			const command = `${executable} hook session-start -H claude-code --project "$(pwd)"`;
			const stop = `${executable} hook stop -H claude-code`;
			const userStop = { type: "command", command: "my-wrapper hook stop -H claude-code" };
			const settings = {
				hooks: {
					SessionStart: [userGroup("SessionStart"), { hooks: [{ type: "command", command }] }],
					Stop: [{ matcher: "*", hooks: [userStop, { type: "command", command: stop }] }],
				},
			};
			writeSettings(settings);
			const connector = new ClaudeCodeConnector();
			expect(connector.isInstalled()).toBe(true);
			await connector.install(tmpRoot);
			await connector.install(tmpRoot);
			expect(commands(readHooks().SessionStart).filter((value) => value.includes("hook session-start"))).toHaveLength(
				1,
			);
			expect(
				commands(readHooks().Stop).filter((value) => value.replace(/['"]/g, "") === stop.replace(/['"]/g, "")),
			).toHaveLength(1);
			expect(readHooks().Stop?.[0]).toEqual({ matcher: "*", hooks: [userStop] });
			writeSettings(settings);
			await connector.uninstall();
			expect(readHooks().SessionStart).toEqual([userGroup("SessionStart")]);
			expect(readHooks().Stop).toEqual([{ matcher: "*", hooks: [userStop] }]);
			expect(connector.isInstalled()).toBe(false);
		});
	}

	for (const [mcp, cli] of [
		[{ command: "/host/bin/signet", args: [], env: { SIGNET_MCP_STDIO_WORKER: "1" } }, "/host/bin/signet"],
		[
			{ command: "/host/bin/node", args: ["/host/package/dist/mcp-stdio.js"] },
			"/host/bin/node /host/package/bin/signet.js",
		],
	] as const) {
		it(`uses the existing MCP launcher when hooks are absent: ${cli}`, async () => {
			writeFileSync(join(tmpRoot, ".claude.json"), JSON.stringify({ mcpServers: { signet: mcp } }));
			await new ClaudeCodeConnector().install(tmpRoot);
			expect(commands(readHooks().SessionStart)).toHaveLength(2);
			expect(commands(readHooks().SessionStart).every((cmd) => cmd.startsWith(`${cli} hook `))).toBe(true);
			expect(JSON.parse(readFileSync(join(tmpRoot, ".claude.json"), "utf-8")).mcpServers.signet).toMatchObject(mcp);
		});
	}

	it.each(["node /x/signet.js", "[broken"])(
		"rejects invalid overrides before changing config: %s",
		async (override) => {
			writeSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "user-hook" }] }] } });
			const settings = readFileSync(join(tmpRoot, ".claude", "settings.json"), "utf-8");
			const agents = "before\n<!-- SIGNET:START -->\nmanaged\n<!-- SIGNET:END -->\nafter\n";
			writeFileSync(join(tmpRoot, "AGENTS.md"), agents);
			const previous = process.env.SIGNET_HOOK_COMMAND;
			process.env.SIGNET_HOOK_COMMAND = override;
			try {
				await expect(new ClaudeCodeConnector().install(tmpRoot)).rejects.toThrow("SIGNET_HOOK_COMMAND must be");
				expect(readFileSync(join(tmpRoot, ".claude", "settings.json"), "utf-8")).toBe(settings);
				expect(readFileSync(join(tmpRoot, "AGENTS.md"), "utf-8")).toBe(agents);
			} finally {
				if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_HOOK_COMMAND");
				if (previous !== undefined) process.env.SIGNET_HOOK_COMMAND = previous;
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"executes an override with spaces and quotes without relying on PATH",
		async () => {
			const launcher = join(tmpRoot, "My 'Tools", "signet");
			const output = join(tmpRoot, "argv.json");
			mkdirSync(join(launcher, ".."), { recursive: true });
			writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > '${output}'\n`, { mode: 0o755 });
			writeSettings({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "command", command: "/host/bin/signet hook session-start -H claude-code" }] },
					],
				},
			});
			const previous = process.env.SIGNET_HOOK_COMMAND;
			const executable = process.execPath;
			try {
				process.execPath = "/app/bin/signet";
				process.env.SIGNET_HOOK_COMMAND = JSON.stringify([launcher]);
				const connector = new ClaudeCodeConnector();
				await connector.install(tmpRoot);
				await connector.install(tmpRoot);
				const start = commands(readHooks().SessionStart).filter((cmd) => cmd.includes("hook session-start"));
				expect(start).toHaveLength(1);
				expect(start[0]).toContain("My '");
				const child = Bun.spawnSync(["/bin/sh", "-c", start[0] ?? "exit 1"], {
					env: { PATH: "/usr/bin:/bin" },
					cwd: tmpRoot,
				});
				expect(child.exitCode).toBe(0);
				expect(readFileSync(output, "utf-8").split("\n")).toEqual([
					"hook",
					"session-start",
					"-H",
					"claude-code",
					"--project",
					tmpRoot,
					"",
				]);
				Reflect.deleteProperty(process.env, "SIGNET_HOOK_COMMAND");
				await connector.install(tmpRoot);
				expect(commands(readHooks().SessionStart).filter((cmd) => cmd.includes("hook session-start"))).toHaveLength(1);
				await connector.uninstall();
				expect(readHooks()).toBeUndefined();
			} finally {
				process.execPath = executable;
				if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_HOOK_COMMAND");
				if (previous !== undefined) process.env.SIGNET_HOOK_COMMAND = previous;
			}
		},
	);

	it("keeps a user hook that shares a group with a Signet hook", async () => {
		const signetEntry = { type: "command", command: 'signet hook session-start -H claude-code --project "$(pwd)"' };
		const userEntry = { type: "command", command: userCommand("SessionStart") };
		writeSettings({ hooks: { SessionStart: [{ matcher: "startup", hooks: [userEntry, signetEntry] }] } });
		const connector = new ClaudeCodeConnector();
		await connector.install(tmpRoot);
		expect(readHooks().SessionStart?.[0]).toEqual({ matcher: "startup", hooks: [userEntry] });
		writeSettings({ hooks: { SessionStart: [{ matcher: "startup", hooks: [userEntry, signetEntry] }] } });
		await connector.uninstall();
		expect(readHooks().SessionStart).toEqual([{ matcher: "startup", hooks: [userEntry] }]);
	});

	it("removes only the Signet MCP registration when settings.json is absent", async () => {
		const path = join(tmpRoot, ".claude.json");
		const other = { command: "other-mcp", args: [] };
		writeFileSync(path, JSON.stringify({ mcpServers: { signet: { command: "signet-mcp" }, other }, model: "opus" }));
		const result = await new ClaudeCodeConnector().uninstall();
		expect(result.filesRemoved).toEqual([]);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ mcpServers: { other }, model: "opus" });
	});

	const operations = {
		install: (connector: InstanceType<typeof ClaudeCodeConnector>) => connector.install(tmpRoot),
		uninstall: (connector: InstanceType<typeof ClaudeCodeConnector>) => connector.uninstall(),
	};
	for (const [label, content] of [
		["settings that are not valid JSON", "{ not json"],
		["settings whose hooks value is not an object", JSON.stringify({ hooks: [] })],
	] as const) {
		for (const [name, run] of Object.entries(operations)) {
			it(`${name} refuses ${label} and leaves the file unchanged`, async () => {
				mkdirSync(join(tmpRoot, ".claude"), { recursive: true });
				writeFileSync(settingsFile(), content, "utf-8");
				await expect(run(new ClaudeCodeConnector())).rejects.toThrow("Refusing to modify");
				expect(readFileSync(settingsFile(), "utf-8")).toBe(content);
			});
		}
	}
});

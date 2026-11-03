import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("ClaudeCodeConnector wake hooks", () => {
	const settingsFile = () => join(tmpRoot, ".claude", "settings.json");
	const readHooks = () => JSON.parse(readFileSync(settingsFile(), "utf-8")).hooks as Record<string, unknown[]>;
	const commandsOf = (groups: unknown[]) =>
		groups.flatMap((g) => ((g as { hooks: Array<Record<string, unknown>> }).hooks ?? []).map((h) => h));

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
		const stop = commandsOf(hooks.Stop ?? []).filter((h) => String(h.command).includes("hook wake"));
		expect(stop).toHaveLength(1);
		expect(stop[0]?.asyncRewake).toBe(true);
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
		expect(hooks.Stop).toBeUndefined();
	});

	it("sessionStart:false drops empty SessionStart", async () => {
		await new ClaudeCodeConnector().install(tmpRoot);
		await new ClaudeCodeConnector({ hooks: { sessionStart: false } } as never).install(tmpRoot);
		const hooks = readHooks();
		expect(hooks.SessionStart).toBeUndefined();
		expect(hooks.Stop).toBeUndefined();
	});
});

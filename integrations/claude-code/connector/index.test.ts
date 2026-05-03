import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeConnector, dispatchSessionEndFireAndForget } from "./src/index.js";

const origHome = process.env.HOME;
let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "signet-claude-code-test-"));
	process.env.HOME = tmpRoot;
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
		expect(capturedArgs[2]).toBe("http://localhost:3850/api/hooks/session-end");
		expect(JSON.parse(capturedArgs[3] ?? "{}")).toEqual({
			harness: "claude-code",
			sessionId: "session-123",
			transcriptPath: "/tmp/transcript.jsonl",
		});
		expect(capturedOptions).toMatchObject({ detached: true, stdio: "ignore" });
		expect(unrefCalled).toBe(true);
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

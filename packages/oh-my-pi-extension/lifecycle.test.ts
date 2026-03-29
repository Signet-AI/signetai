import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LifecycleDeps, endCurrentSession, endPreviousSession, flushPendingSessionEnds } from "./src/lifecycle.js";
import { createSessionState } from "./src/session-state.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTestContext(sessionId: string, project = "/tmp/project") {
	return {
		cwd: project,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [{ type: "message", message: { role: "user", content: "hello" } }],
			getHeader: () => ({ id: sessionId, cwd: project }),
			getSessionFile: () => undefined,
			getSessionId: () => sessionId,
		},
	} as const;
}

describe("Oh My Pi lifecycle session-end handling", () => {
	it("defers marking a previous session ended until its session file can be reconstructed and submitted", async () => {
		const calls: Array<{ path: string; body: unknown }> = [];
		let shouldSucceed = false;
		const deps: LifecycleDeps = {
			agentId: "agent-1",
			client: {
				async post(path, body) {
					calls.push({ path, body });
					return shouldSucceed ? { ok: true } : null;
				},
			},
			state: createSessionState(),
		};

		const dir = mkdtempSync(join(tmpdir(), "omp-lifecycle-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "previous-session.jsonl");
		deps.state.setActiveSession("prev-session", sessionFile);

		await endPreviousSession(deps, { previousSessionFile: sessionFile }, "session_switch");
		expect(calls).toHaveLength(0);
		expect(deps.state.sessionAlreadyEnded("prev-session")).toBe(false);
		expect(deps.state.getPendingSessionEnds()).toHaveLength(1);

		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", id: "prev-session", cwd: "/tmp/project" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: "hello" },
				}),
			].join("\n"),
		);

		await flushPendingSessionEnds(deps);
		expect(calls).toHaveLength(1);
		expect(deps.state.sessionAlreadyEnded("prev-session")).toBe(false);
		expect(deps.state.getPendingSessionEnds()).toHaveLength(1);

		shouldSucceed = true;
		await flushPendingSessionEnds(deps);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.path).toBe("/api/hooks/session-end");
		expect(calls[1]?.body).toMatchObject({
			sessionKey: "prev-session",
			reason: "session_switch",
			transcript: "User: hello",
		});
		expect(deps.state.sessionAlreadyEnded("prev-session")).toBe(true);
		expect(deps.state.getPendingSessionEnds()).toHaveLength(0);
	});

	it("does not mark the current session ended when session-end submission fails", async () => {
		const deps: LifecycleDeps = {
			agentId: "agent-1",
			client: {
				async post() {
					return null;
				},
			},
			state: createSessionState(),
		};

		await endCurrentSession(deps, createTestContext("current-session") as never, "session_shutdown");
		expect(deps.state.sessionAlreadyEnded("current-session")).toBe(false);
	});
});

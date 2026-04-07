import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LifecycleDeps, OMP_LIFECYCLE_CONFIG, endCurrentSession, endPreviousSession, flushPendingSessionEnds } from "./src/lifecycle.js";
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
				async postResult() {
					return { ok: false as const, reason: "offline" as const };
				},
			},
			state: createSessionState(),
			config: OMP_LIFECYCLE_CONFIG,
		};

		const dir = mkdtempSync(join(tmpdir(), "omp-lifecycle-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "previous-session.jsonl");
		deps.state.setActiveSession("prev-session", sessionFile);

		await endPreviousSession(deps, { previousSessionFile: sessionFile }, "session_switch");
		// Release call sent even without transcript (to free daemon claim)
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/api/hooks/session-end");
		expect((calls[0]?.body as Record<string, unknown>).transcript).toBeUndefined();
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
		expect(calls).toHaveLength(2);
		expect(deps.state.sessionAlreadyEnded("prev-session")).toBe(false);
		expect(deps.state.getPendingSessionEnds()).toHaveLength(1);

		shouldSucceed = true;
		await flushPendingSessionEnds(deps);
		expect(calls).toHaveLength(3);
		expect(calls[2]?.path).toBe("/api/hooks/session-end");
		expect(calls[2]?.body).toMatchObject({
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
				async postResult() {
					return { ok: false as const, reason: "offline" as const };
				},
			},
			state: createSessionState(),
			config: OMP_LIFECYCLE_CONFIG,
		};

		await endCurrentSession(deps, createTestContext("current-session") as never, "session_shutdown");
		expect(deps.state.sessionAlreadyEnded("current-session")).toBe(false);
	});
});

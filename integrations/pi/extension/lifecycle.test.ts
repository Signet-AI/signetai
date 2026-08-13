import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LifecycleDeps,
	PI_LIFECYCLE_CONFIG,
	endCurrentSession,
	endPreviousSession,
	flushPendingSessionEnds,
	refreshSessionStart,
	requestRecallForPrompt,
} from "./src/lifecycle.js";
import {
	assertLifecycleObservationInvariants,
	LifecycleObservationRecorder,
	setLifecycleObservers,
	type LifecycleObservationInput,
} from "@signet/pi-extension-base";
import { createSessionState } from "./src/session-state.js";

const tempDirs: string[] = [];

afterEach(() => {
	setLifecycleObservers(undefined);
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

describe("pi lifecycle session-end handling", () => {
	it("proves the real session rotation owner preserves ordering and attribution", async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
		const recorder = new LifecycleObservationRecorder();
		setLifecycleObservers({ observation: (observation: LifecycleObservationInput) => recorder.record(observation) });
		const deps: LifecycleDeps = {
			agentId: "agent-1",
			client: {
				async post(path, body) {
					calls.push({ path, body: body as Record<string, unknown> });
					return { ok: true };
				},
				async postResult(path, body) {
					calls.push({ path, body: body as Record<string, unknown> });
					if (path.endsWith("session-start")) return { ok: true as const, data: {} };
					return { ok: true as const, data: { sessionKnown: true } };
				},
			},
			state: createSessionState(),
			config: PI_LIFECYCLE_CONFIG,
		};
		const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-proof-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "previous-session.jsonl");
		writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "old-session", cwd: "/tmp/project" }));
		deps.state.setActiveSession("old-session", sessionFile);
		await endPreviousSession(deps, { previousSessionFile: sessionFile }, "session_switch");
		await refreshSessionStart(deps, createTestContext("new-session") as never);
		await requestRecallForPrompt(deps, createTestContext("new-session") as never, "hello");
		const promptCall = calls.find((call) => call.path.endsWith("user-prompt-submit"));
		expect(promptCall?.body.sessionKey).toBe("new-session");
		const proof = assertLifecycleObservationInvariants(recorder.observations);
		expect(proof.observations).toBe(5);
	});
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
			config: PI_LIFECYCLE_CONFIG,
		};

		const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "previous-session.jsonl");
		deps.state.setActiveSession("prev-session", sessionFile);

		await endPreviousSession(deps, { previousSessionFile: sessionFile }, "session_switch");
		// Release call sent even without transcript (to free daemon claim)
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/api/hooks/session-end");
		expect((calls[0]?.body as Record<string, unknown> | undefined)?.transcript).toBeUndefined();
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
			config: PI_LIFECYCLE_CONFIG,
		};

		await endCurrentSession(deps, createTestContext("current-session") as never, "session_shutdown");
		expect(deps.state.sessionAlreadyEnded("current-session")).toBe(false);
	});
});

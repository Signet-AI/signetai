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

function createTestContext(sessionId: string, project = "/tmp/project", sessionFile?: string) {
	return {
		cwd: project,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [{ type: "message", message: { role: "user", content: "hello" } }],
			getHeader: () => ({ id: sessionId, cwd: project }),
			getSessionFile: () => sessionFile,
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

	it("preserves multiple deferred session switches in queue order", async () => {
		const recorder = new LifecycleObservationRecorder();
		setLifecycleObservers({ observation: (observation: LifecycleObservationInput) => recorder.record(observation) });
		let shouldSucceed = false;
		const deps: LifecycleDeps = {
			agentId: "agent-1",
			client: {
				async post<T>(_path: string, _body: unknown): Promise<T | null> {
					return shouldSucceed ? ({} as T) : null;
				},
				async postResult<T>(_path: string, _body: unknown): Promise<{ ok: true; data: T }> {
					return { ok: true, data: {} as T };
				},
			},
			state: createSessionState(),
			config: PI_LIFECYCLE_CONFIG,
		};
		const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-switch-queue-"));
		tempDirs.push(dir);
		const oldFile = join(dir, "old-session.jsonl");
		const newFile = join(dir, "new-session.jsonl");
		deps.state.setActiveSession("old-session", oldFile);

		await endPreviousSession(deps, { previousSessionFile: oldFile }, "session_switch");
		await refreshSessionStart(deps, createTestContext("new-session", "/tmp/project", newFile) as never);
		expect(deps.state.getPendingSessionSwitch()).toEqual({
			fromSessionId: "old-session",
			toSessionId: "new-session",
		});

		await endPreviousSession(deps, { previousSessionFile: newFile }, "session_switch");
		await refreshSessionStart(deps, createTestContext("third-session") as never);
		// The second deferred rotation must not replace the first one.
		expect(deps.state.getPendingSessionSwitch()).toEqual({
			fromSessionId: "old-session",
			toSessionId: "new-session",
		});

		writeFileSync(oldFile, JSON.stringify({ type: "session", id: "old-session", cwd: "/tmp/project" }));
		writeFileSync(newFile, JSON.stringify({ type: "session", id: "new-session", cwd: "/tmp/project" }));
		shouldSucceed = true;
		await flushPendingSessionEnds(deps);

		expect(
			recorder.observations
				.filter((observation) => observation.stage === "session-switch")
				.map((observation) => [observation.fromSessionId, observation.toSessionId]),
		).toEqual([
			["old-session", "new-session"],
			["new-session", "third-session"],
		]);
		expect(deps.state.getPendingSessionSwitch()).toBeUndefined();
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

	it("records deferred session-end before session-switch when the previous file appears later", async () => {
		const recorder = new LifecycleObservationRecorder();
		setLifecycleObservers({ observation: (observation: LifecycleObservationInput) => recorder.record(observation) });
		let shouldSucceed = false;
		const deps: LifecycleDeps = {
			agentId: "agent-1",
			client: {
				async post<T>(_path: string, _body: unknown): Promise<T | null> {
					return shouldSucceed ? ({ ok: true } as T) : null;
				},
				async postResult() {
					return { ok: false as const, reason: "offline" as const };
				},
			},
			state: createSessionState(),
			config: PI_LIFECYCLE_CONFIG,
		};
		const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-order-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "previous-session.jsonl");
		deps.state.setActiveSession("prev-session", sessionFile);

		await endPreviousSession(deps, { previousSessionFile: sessionFile }, "session_switch");
		expect(deps.state.sessionAlreadyEnded("prev-session")).toBe(false);
		await refreshSessionStart(deps, createTestContext("new-session") as never);
		expect(recorder.observations.map((observation) => observation.stage)).toEqual(["startup", "session-start"]);

		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", id: "prev-session", cwd: "/tmp/project" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			].join("\n"),
		);
		shouldSucceed = true;
		await flushPendingSessionEnds(deps);
		expect(recorder.observations.map((observation) => observation.stage)).toEqual([
			"startup",
			"session-start",
			"session-end",
			"session-switch",
		]);
	});

	it("records session-end before session-switch when a deferred submission initially fails", async () => {
		const recorder = new LifecycleObservationRecorder();
		setLifecycleObservers({ observation: (observation: LifecycleObservationInput) => recorder.record(observation) });
		let shouldSucceed = false;
		const deps: LifecycleDeps = {
			agentId: "agent-1",
			client: {
				async post<T>(_path: string, _body: unknown): Promise<T | null> {
					return shouldSucceed ? ({ ok: true } as T) : null;
				},
				async postResult() {
					return { ok: false as const, reason: "offline" as const };
				},
			},
			state: createSessionState(),
			config: PI_LIFECYCLE_CONFIG,
		};
		const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-submit-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "previous-session.jsonl");
		writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "prev-session", cwd: "/tmp/project" }));
		deps.state.setActiveSession("prev-session", sessionFile);

		await endPreviousSession(deps, { previousSessionFile: sessionFile }, "session_switch");
		await refreshSessionStart(deps, createTestContext("new-session") as never);
		expect(recorder.observations.map((observation) => observation.stage)).toEqual(["startup", "session-start"]);

		shouldSucceed = true;
		await flushPendingSessionEnds(deps);
		expect(recorder.observations.map((observation) => observation.stage)).toEqual([
			"startup",
			"session-start",
			"session-end",
			"session-switch",
		]);
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

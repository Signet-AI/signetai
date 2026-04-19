import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import {
	initContinuity,
	recordPrompt,
	recordRemember,
	shouldCheckpoint,
	consumeState,
	clearContinuity,
	getState,
	getActiveSessionKeys,
} from "./continuity-state";
import type { PipelineContinuityConfig } from "@signet/core";

const defaultConfig: PipelineContinuityConfig = {
	enabled: true,
	promptInterval: 5,
	timeIntervalMs: 900_000,
	maxCheckpointsPerSession: 50,
	retentionDays: 7,
	recoveryBudgetChars: 2000,
};

const SESSION = "test-session-snippets";

describe("continuity-state", () => {
	beforeEach(() => {
		// Clean up any leftover state
		for (const key of getActiveSessionKeys()) {
			clearContinuity(key);
		}
	});

	test("initContinuity creates session state", () => {
		initContinuity("s1", "claude-code", "/tmp/project");
		const state = getState("s1");
		expect(state).toBeDefined();
		expect(state?.sessionKey).toBe("s1");
		expect(state?.harness).toBe("claude-code");
		expect(state?.promptCount).toBe(0);
		expect(state?.pendingQueries).toEqual([]);
	});

	test("recordPrompt increments count and stores query", () => {
		initContinuity("s2", "test", "/tmp/p");
		recordPrompt("s2", "typescript config", undefined);
		recordPrompt("s2", "database setup", undefined);
		const state = getState("s2");
		expect(state?.promptCount).toBe(2);
		expect(state?.pendingQueries).toEqual(["typescript config", "database setup"]);
	});

	test("recordPrompt caps queries at 20", () => {
		initContinuity("s3", "test", "/tmp/p");
		for (let i = 0; i < 25; i++) {
			recordPrompt("s3", `query-${i}`, undefined);
		}
		const state = getState("s3");
		expect(state?.pendingQueries.length).toBe(20);
		expect(state?.pendingQueries[0]).toBe("query-5"); // oldest dropped
		expect(state?.pendingQueries[19]).toBe("query-24");
	});

	test("recordRemember stores content capped at 10", () => {
		initContinuity("s4", "test", "/tmp/p");
		for (let i = 0; i < 12; i++) {
			recordRemember("s4", `remember-${i}`);
		}
		const state = getState("s4");
		expect(state?.pendingRemembers.length).toBe(10);
		expect(state?.pendingRemembers[0]).toBe("remember-2");
	});

	test("shouldCheckpoint returns true after promptInterval", () => {
		initContinuity("s5", "test", "/tmp/p");
		for (let i = 0; i < 4; i++) {
			recordPrompt("s5", undefined, undefined);
		}
		expect(shouldCheckpoint("s5", defaultConfig)).toBe(false);
		recordPrompt("s5", undefined, undefined);
		expect(shouldCheckpoint("s5", defaultConfig)).toBe(true);
	});

	test("shouldCheckpoint returns false when disabled", () => {
		initContinuity("s6", "test", "/tmp/p");
		for (let i = 0; i < 10; i++) {
			recordPrompt("s6", undefined, undefined);
		}
		expect(shouldCheckpoint("s6", { ...defaultConfig, enabled: false })).toBe(false);
	});

	test("shouldCheckpoint returns false for unknown session", () => {
		expect(shouldCheckpoint("nonexistent", defaultConfig)).toBe(false);
	});

	test("consumeState returns snapshot and resets accumulators", () => {
		initContinuity("s7", "test", "/tmp/p");
		recordPrompt("s7", "q1", undefined);
		recordRemember("s7", "r1");

		const snap = consumeState("s7");
		expect(snap?.promptCount).toBe(1);
		expect(snap?.pendingQueries).toEqual(["q1"]);
		expect(snap?.pendingRemembers).toEqual(["r1"]);

		// State should be reset
		const after = getState("s7");
		expect(after?.promptCount).toBe(0);
		expect(after?.pendingQueries).toEqual([]);
		expect(after?.pendingRemembers).toEqual([]);
	});

	test("clearContinuity removes session state", () => {
		initContinuity("s8", "test", "/tmp/p");
		clearContinuity("s8");
		expect(getState("s8")).toBeUndefined();
	});

	test("no-ops on undefined/empty session key", () => {
		// None of these should throw
		recordPrompt(undefined, "test", undefined);
		recordPrompt("", "test", undefined);
		recordRemember(undefined, "test");
		expect(shouldCheckpoint(undefined, defaultConfig)).toBe(false);
		expect(consumeState(undefined)).toBeUndefined();
		clearContinuity(undefined);
	});

	test("getActiveSessionKeys returns all tracked sessions", () => {
		initContinuity("a1", "test", undefined);
		initContinuity("a2", "test", undefined);
		const keys = getActiveSessionKeys();
		expect(keys).toContain("a1");
		expect(keys).toContain("a2");
	});

	// === Snippet tracking ===

	describe("recordPrompt with snippets", () => {
		afterEach(() => {
			clearContinuity(SESSION);
		});

		it("stores snippet in pendingPromptSnippets", () => {
			initContinuity(SESSION, "claude-code", "/tmp/project");
			recordPrompt(SESSION, "hello world", "What is the meaning of life?");
			const s = getState(SESSION);
			expect(s?.pendingPromptSnippets).toEqual(["What is the meaning of life?"]);
		});

		it("truncates snippets beyond 200 chars", () => {
			initContinuity(SESSION, "claude-code", "/tmp/project");
			const longPrompt = "x".repeat(300);
			recordPrompt(SESSION, undefined, longPrompt);
			const s = getState(SESSION);
			expect(s?.pendingPromptSnippets[0]?.length).toBe(200);
		});

		it("evicts oldest snippet when exceeding max 10", () => {
			initContinuity(SESSION, "claude-code", "/tmp/project");
			for (let i = 0; i < 12; i++) {
				recordPrompt(SESSION, undefined, `prompt ${i}`);
			}
			const s = getState(SESSION);
			expect(s?.pendingPromptSnippets.length).toBe(10);
			expect(s?.pendingPromptSnippets[0]).toBe("prompt 2");
			expect(s?.pendingPromptSnippets[9]).toBe("prompt 11");
		});

		it("skips empty/whitespace snippets", () => {
			initContinuity(SESSION, "claude-code", "/tmp/project");
			recordPrompt(SESSION, undefined, "   ");
			recordPrompt(SESSION, undefined, "");
			recordPrompt(SESSION, undefined, undefined);
			const s = getState(SESSION);
			expect(s?.pendingPromptSnippets.length).toBe(0);
		});
	});

	describe("consumeState snapshots and resets snippets", () => {
		afterEach(() => {
			clearContinuity(SESSION);
		});

		it("returns snippets in snapshot and clears them", () => {
			initContinuity(SESSION, "claude-code", "/tmp/project");
			recordPrompt(SESSION, "q1", "first prompt");
			recordPrompt(SESSION, "q2", "second prompt");

			const snap = consumeState(SESSION);
			expect(snap?.pendingPromptSnippets).toEqual(["first prompt", "second prompt"]);
			expect(snap?.promptCount).toBe(2);

			// After consume, state should be reset
			const s = getState(SESSION);
			expect(s?.pendingPromptSnippets.length).toBe(0);
			expect(s?.promptCount).toBe(0);
		});

		it("totalPromptCount survives across consumes", () => {
			initContinuity(SESSION, "claude-code", "/tmp/project");
			recordPrompt(SESSION, undefined, "prompt 1");
			recordPrompt(SESSION, undefined, "prompt 2");
			recordPrompt(SESSION, undefined, "prompt 3");

			// First consume — interval resets, total stays
			const snap1 = consumeState(SESSION);
			expect(snap1?.promptCount).toBe(3);
			expect(snap1?.totalPromptCount).toBe(3);

			// Record more prompts
			recordPrompt(SESSION, undefined, "prompt 4");
			recordPrompt(SESSION, undefined, "prompt 5");

			// Second consume — interval is 2, total is 5
			const snap2 = consumeState(SESSION);
			expect(snap2?.promptCount).toBe(2);
			expect(snap2?.totalPromptCount).toBe(5);
		});
	});
});

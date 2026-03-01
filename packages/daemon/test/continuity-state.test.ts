import { describe, test, expect, beforeEach } from "bun:test";
import {
	initContinuity,
	recordPrompt,
	recordRemember,
	shouldCheckpoint,
	consumeState,
	clearContinuity,
	getState,
	getActiveSessionKeys,
} from "../src/continuity-state";
import type { PipelineContinuityConfig } from "@signet/core";

const defaultConfig: PipelineContinuityConfig = {
	enabled: true,
	promptInterval: 5,
	timeIntervalMs: 900_000,
	maxCheckpointsPerSession: 50,
	retentionDays: 7,
	recoveryBudgetChars: 2000,
};

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
		recordPrompt("s2", "typescript config");
		recordPrompt("s2", "database setup");
		const state = getState("s2");
		expect(state?.promptCount).toBe(2);
		expect(state?.pendingQueries).toEqual(["typescript config", "database setup"]);
	});

	test("recordPrompt caps queries at 20", () => {
		initContinuity("s3", "test", "/tmp/p");
		for (let i = 0; i < 25; i++) {
			recordPrompt("s3", `query-${i}`);
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
			recordPrompt("s5", undefined);
		}
		expect(shouldCheckpoint("s5", defaultConfig)).toBe(false);
		recordPrompt("s5", undefined);
		expect(shouldCheckpoint("s5", defaultConfig)).toBe(true);
	});

	test("shouldCheckpoint returns false when disabled", () => {
		initContinuity("s6", "test", "/tmp/p");
		for (let i = 0; i < 10; i++) {
			recordPrompt("s6", undefined);
		}
		expect(shouldCheckpoint("s6", { ...defaultConfig, enabled: false })).toBe(false);
	});

	test("shouldCheckpoint returns false for unknown session", () => {
		expect(shouldCheckpoint("nonexistent", defaultConfig)).toBe(false);
	});

	test("consumeState returns snapshot and resets accumulators", () => {
		initContinuity("s7", "test", "/tmp/p");
		recordPrompt("s7", "q1");
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
		recordPrompt(undefined, "test");
		recordPrompt("", "test");
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
});

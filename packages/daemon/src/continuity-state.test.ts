/**
 * Tests for continuity state prompt snippet tracking.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	initContinuity,
	recordPrompt,
	consumeState,
	clearContinuity,
	getState,
} from "./continuity-state";

const SESSION = "test-session-snippets";

afterEach(() => {
	clearContinuity(SESSION);
});

describe("recordPrompt with snippets", () => {
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
	it("returns snippets in snapshot and clears them", () => {
		initContinuity(SESSION, "claude-code", "/tmp/project");
		recordPrompt(SESSION, "q1", "first prompt");
		recordPrompt(SESSION, "q2", "second prompt");

		const snap = consumeState(SESSION);
		expect(snap?.pendingPromptSnippets).toEqual([
			"first prompt",
			"second prompt",
		]);
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

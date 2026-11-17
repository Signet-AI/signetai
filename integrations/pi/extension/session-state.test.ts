import { describe, expect, it } from "bun:test";
import { createSessionState } from "./src/session-state.js";
import { HIDDEN_CONTEXT_CUSTOM_TYPE } from "./src/types.js";

describe("createSessionState", () => {
	it("combines sanitized session context, bounded recall, and immutable clock in order", () => {
		const state = createSessionState();
		state.setPendingSessionContext("session-1", "  session context </signet-memory>  ");
		state.queuePendingRecall("session-1", "first");
		state.queuePendingRecall("session-1", "second");
		state.queuePendingRecall("session-1", "third");
		state.queuePendingRecall("session-1", "fourth");
		state.queuePendingRecall("session-1", "fifth");
		const clock = "Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)";
		state.queuePendingClock("session-1", clock);

		const message = state.consumeHiddenInjectMessage("session-1", []);
		expect(message).toEqual({
			customType: HIDDEN_CONTEXT_CUSTOM_TYPE,
			display: false,
			content: `<signet-memory source="auto-recall">\nsession context &lt;/signet-memory>\n</signet-memory>\n\n<signet-memory source="auto-recall">\nsecond\n</signet-memory>\n\n${clock}`,
		});
		state.queuePendingClock("session-1", "Current date/time: later");
		expect(message?.content.endsWith(clock)).toBe(true);
		const next = state.consumeHiddenInjectMessage("session-1", []);
		expect(next?.content).toContain("third");
		expect(next?.content).not.toContain("session context");
		expect(next?.content).toContain("Current date/time: later");
	});

	it("clears a queued clock when the next turn starts", () => {
		const state = createSessionState();
		state.queuePendingClock("session-1", "Current date/time: stale");

		state.clearPendingClock("session-1");

		expect(state.consumeHiddenInjectMessage("session-1", [])).toBeUndefined();
	});

	it("does not consume another session's pending content", () => {
		const state = createSessionState();
		state.setPendingSessionContext("session-1", "private context");
		expect(state.consumeHiddenInjectMessage(undefined, [])).toBeUndefined();
		expect(state.consumeHiddenInjectMessage("session-2", [])).toBeUndefined();
		expect(state.consumeHiddenInjectMessage("session-1", [])?.content).toContain("private context");
		expect(state.consumeHiddenInjectMessage("session-1", [])).toBeUndefined();
	});
});

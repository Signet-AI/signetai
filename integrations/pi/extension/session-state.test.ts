import { describe, expect, it } from "bun:test";
import { createSessionState } from "./src/session-state.js";
import { HIDDEN_CLOCK_CUSTOM_TYPE } from "./src/types.js";

describe("createSessionState", () => {
	it("injects hidden session context and bounded recall in order", () => {
		const state = createSessionState();
		state.setPendingSessionContext("session-1", "  session context  ");
		state.queuePendingRecall("session-1", "first");
		state.queuePendingRecall("session-1", "second");
		state.queuePendingRecall("session-1", "third");
		state.queuePendingRecall("session-1", "fourth");
		state.queuePendingRecall("session-1", "fifth");
		state.queuePendingClock("session-1", "Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)");

		const firstMessages = state.consumeHiddenInjectMessages("session-1");
		expect(firstMessages).toHaveLength(3);
		expect(firstMessages[0]?.customType).toBe("signet-pi-session-context");
		expect(firstMessages[0]?.display).toBe(false);
		expect(firstMessages[0]?.content).toContain("session context");
		expect(firstMessages[1]?.customType).toBe("signet-pi-hidden-recall");
		expect(firstMessages[1]?.content).toContain("second");
		expect(firstMessages[2]?.customType).toBe(HIDDEN_CLOCK_CUSTOM_TYPE);
		expect(firstMessages[2]?.display).toBe(false);
		expect(firstMessages[2]?.content).toBe("Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)");

		const secondMessages = state.consumeHiddenInjectMessages("session-1");
		expect(secondMessages).toHaveLength(1);
		expect(secondMessages[0]?.content).toContain("third");
	});

	it("clears a queued clock when the next turn starts", () => {
		const state = createSessionState();
		state.queuePendingClock("session-1", "Current date/time: stale");

		state.clearPendingClock("session-1");

		expect(state.consumeHiddenInjectMessages("session-1")).toEqual([]);
	});
});

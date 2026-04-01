import { describe, expect, it } from "bun:test";
import { createSessionState } from "./src/session-state.js";

describe("createSessionState", () => {
	it("injects hidden session context and bounded recall in order", () => {
		const state = createSessionState();
		state.setPendingSessionContext("session-1", "  session context  ");
		state.queuePendingRecall("session-1", "first");
		state.queuePendingRecall("session-1", "second");
		state.queuePendingRecall("session-1", "third");
		state.queuePendingRecall("session-1", "fourth");
		state.queuePendingRecall("session-1", "fifth");

		const firstMessages = state.consumeHiddenInjectMessages("session-1");
		expect(firstMessages).toHaveLength(2);
		expect(firstMessages[0]?.customType).toBe("signet-pi-session-context");
		expect(firstMessages[0]?.display).toBe(false);
		expect(firstMessages[0]?.content).toContain("session context");
		expect(firstMessages[1]?.customType).toBe("signet-pi-hidden-recall");
		expect(firstMessages[1]?.content).toContain("second");

		const secondMessages = state.consumeHiddenInjectMessages("session-1");
		expect(secondMessages).toHaveLength(1);
		expect(secondMessages[0]?.content).toContain("third");
	});
});

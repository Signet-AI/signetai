import { describe, expect, it } from "bun:test";
import { createSessionState } from "./src/session-state.js";

describe("createSessionState", () => {
	it("combines hidden session context with the next persisted recall message", () => {
		const state = createSessionState();
		state.setPendingSessionContext("session-1", "  session context  ");
		state.queuePendingRecall("session-1", "first");
		state.queuePendingRecall("session-1", "second");
		state.queuePendingRecall("session-1", "third");
		state.queuePendingRecall("session-1", "fourth");
		state.queuePendingRecall("session-1", "fifth");

		const firstMessage = state.consumePersistentHiddenInject("session-1");
		expect(firstMessage?.customType).toBe("signet-oh-my-pi-hidden-recall");
		expect(firstMessage?.display).toBe(false);
		expect(firstMessage?.attribution).toBe("agent");
		expect(firstMessage?.content).toContain("session context");
		expect(firstMessage?.content).toContain("second");

		const secondMessage = state.consumePersistentHiddenInject("session-1");
		expect(secondMessage?.customType).toBe("signet-oh-my-pi-hidden-recall");
		expect(secondMessage?.content).toContain("third");
	});

	it("preserves a session-context-only inject when no recall is pending", () => {
		const state = createSessionState();
		state.setPendingSessionContext("session-2", "  session context only  ");

		const message = state.consumePersistentHiddenInject("session-2");
		expect(message?.customType).toBe("signet-oh-my-pi-session-context");
		expect(message?.attribution).toBe("agent");
		expect(message?.content).toContain("session context only");
		expect(state.consumePersistentHiddenInject("session-2")).toBeUndefined();
	});
});

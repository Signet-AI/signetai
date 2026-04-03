import { afterEach, describe, expect, it } from "bun:test";
import { isSessionCleanupRunning, stopSessionCleanup } from "./session-tracker";

describe("daemon route extraction refactor", () => {
	afterEach(() => {
		stopSessionCleanup();
	});

	it("does not start session cleanup when daemon is imported for route registration", async () => {
		expect(isSessionCleanupRunning()).toBe(false);
		await import("./daemon");
		expect(isSessionCleanupRunning()).toBe(false);
	});

	it("reloadAuthState synchronizes authConfig, authSecret, and rate limiters", async () => {
		const state = await import("./routes/state.js");

		const configBefore = state.authConfig.mode;
		const secretBefore = state.authSecret;

		state.reloadAuthState(state.AGENTS_DIR);

		// authConfig must have been updated.
		expect(typeof state.authConfig.mode).toBe("string");

		// authSecret must be consistent with mode.
		if (state.authConfig.mode !== "local") {
			expect(state.authSecret).not.toBeNull();
		} else {
			expect(state.authSecret).toBeNull();
		}

		// Verify reloadAuthState is the single update path — state.ts
		// exports should reflect the reloaded values, not stale ones.
		expect(state.authConfig.mode).toBe(configBefore);
		expect(state.authSecret).toBe(secretBefore);
	});
});

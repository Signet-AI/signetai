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

	it("reloadAuthState is idempotent and produces consistent auth state", async () => {
		const state = await import("./routes/state.js");

		// First reload — captures on-disk auth config.
		state.reloadAuthState(state.AGENTS_DIR);
		const mode1 = state.authConfig.mode;
		const secret1 = state.authSecret;

		// Second reload — must produce identical values (idempotency).
		state.reloadAuthState(state.AGENTS_DIR);
		const mode2 = state.authConfig.mode;
		const secret2 = state.authSecret;

		expect(mode2).toBe(mode1);
		expect(secret2).toBe(secret1);

		// authSecret must be consistent with mode after every reload.
		if (state.authConfig.mode !== "local") {
			expect(state.authSecret).not.toBeNull();
		} else {
			expect(state.authSecret).toBeNull();
		}
	});
});

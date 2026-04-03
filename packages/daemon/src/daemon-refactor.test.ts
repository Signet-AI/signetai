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
});

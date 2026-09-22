import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionCleanupRunning, stopSessionCleanup } from "./session-tracker";

describe("daemon route extraction refactor", () => {
	beforeEach(() => {
		stopSessionCleanup();
	});
	it("does not start session cleanup when daemon is imported for route registration", async () => {
		expect.assertions(2);
		expect(isSessionCleanupRunning()).toBe(false);
		await import("./daemon");
		expect(isSessionCleanupRunning()).toBe(false);
	});

	it("reloadAuthState is idempotent and produces consistent auth state", async () => {
		const state = await import("./routes/state.js");

		state.reloadAuthState(state.AGENTS_DIR);
		const mode1 = state.authConfig.mode;
		const secret1 = state.authSecret;

		state.reloadAuthState(state.AGENTS_DIR);
		const mode2 = state.authConfig.mode;
		const secret2 = state.authSecret;

		expect(mode2).toBe(mode1);
		expect(secret2?.toString("hex")).toBe(secret1?.toString("hex"));
		if (state.authConfig.mode === "local") {
			expect(state.authSecret).toBeNull();
		} else {
			expect(state.authSecret).not.toBeNull();
		}
	});
	it("reloadAuthState completes without error in team mode", async () => {
		expect.assertions(1);
		const state = await import("./routes/state.js");

		const tmpDir = join(tmpdir(), `signet-test-auth-${Date.now()}`);
		mkdirSync(join(tmpDir, "memory"), { recursive: true });
		mkdirSync(join(tmpDir, ".daemon"), { recursive: true });
		writeFileSync(join(tmpDir, ".daemon", "auth-secret"), "test-secret-key-for-auth-mode");
		writeFileSync(
			join(tmpDir, "agent.yaml"),
			[
				"auth:",
				"  mode: team",
				"  rateLimits:",
				"    forget:",
				"      windowMs: 60000",
				"      max: 30",
				"    modify:",
				"      windowMs: 60000",
				"      max: 60",
				"    batchForget:",
				"      windowMs: 60000",
				"      max: 5",
				"    admin:",
				"      windowMs: 60000",
				"      max: 10",
				"    recallLlm:",
				"      windowMs: 60000",
				"      max: 60",
			].join("\n"),
		);

		try {
			expect(() => state.reloadAuthState(tmpDir)).not.toThrow();
		} finally {
			state.reloadAuthState(state.AGENTS_DIR);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

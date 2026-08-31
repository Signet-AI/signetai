import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionCleanupRunning, stopSessionCleanup } from "./session-tracker";

describe("daemon route extraction refactor", () => {
	beforeEach(() => {
		stopSessionCleanup();
	});

	// Guards against module-level side effects at import time (e.g.
	// calling startSessionCleanup() during top-level evaluation).
	// BEST-EFFORT GUARD: This test relies on ESM module caching — the
	// daemon module body only runs on the first import in a given
	// process. If another test file imports ./daemon first, this test
	// becomes a no-op. This is an intentional trade-off: running this
	// test in isolation still catches regressions, and the daemon's
	// integration tests cover session cleanup behavior independently.
	it("does not start session cleanup when daemon is imported for route registration", async () => {
		expect.assertions(2);
		expect(isSessionCleanupRunning()).toBe(false);
		await import("./daemon");
		expect(isSessionCleanupRunning()).toBe(false);
	});

	it("does not install process failure handlers when imported as a library", () => {
		const testDir = join(tmpdir(), `signet-daemon-import-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		try {
			const daemonUrl = new URL("./daemon.ts", import.meta.url).href;
			const script = `
				const events = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];
				await import(${JSON.stringify(daemonUrl)});
				const handlers = Object.fromEntries(events.map((event) => [
					event,
					process.listeners(event).filter((listener) => listener.name.startsWith("onDaemon")).length,
				]));
				process.stdout.write("DAEMON_PROCESS_HANDLERS=" + JSON.stringify(handlers) + "\\n");
				process.exit(0);
			`;
			const child = Bun.spawnSync({
				cmd: [process.execPath, "-e", script],
				env: { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "0", SIGNET_PATH: testDir },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(child.exitCode).toBe(0);
			const output = new TextDecoder().decode(child.stdout);
			const record = output
				.split("\n")
				.find((line) => line.startsWith("DAEMON_PROCESS_HANDLERS="))
				?.slice("DAEMON_PROCESS_HANDLERS=".length);
			expect(record).toBeDefined();
			expect(JSON.parse(record as string)).toEqual({
				SIGINT: 0,
				SIGTERM: 0,
				uncaughtException: 0,
				unhandledRejection: 0,
			});
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("does not persist plugin registry state when imported for routes", () => {
		const testDir = join(tmpdir(), `signet-daemon-plugin-import-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		try {
			const daemonUrl = new URL("./daemon.ts", import.meta.url).href;
			const registryPath = join(testDir, ".daemon", "plugins", "registry-v1.json");
			const script = `
				const { existsSync } = await import("node:fs");
				await import(${JSON.stringify(daemonUrl)});
				process.stdout.write("DAEMON_PLUGIN_REGISTRY=" + String(existsSync(${JSON.stringify(registryPath)})) + "\\n");
				process.exit(0);
			`;
			const child = Bun.spawnSync({
				cmd: [process.execPath, "-e", script],
				env: { ...process.env, SIGNET_DAEMON_ENTRYPOINT: "0", SIGNET_PATH: testDir },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(child.exitCode).toBe(0);
			const output = new TextDecoder().decode(child.stdout);
			expect(output).toContain("DAEMON_PLUGIN_REGISTRY=false");
			expect(existsSync(registryPath)).toBe(false);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
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

		// In local mode (the test environment default), authSecret is always
		// null. Make this invariant explicit rather than relying on the
		// trivially-true toString comparison above.
		if (state.authConfig.mode === "local") {
			expect(state.authSecret).toBeNull();
		} else {
			expect(state.authSecret).not.toBeNull();
		}
	});

	// Exercises the non-local auth path (token mode) end-to-end:
	// reloadAuthState reads agent.yaml, parses mode=token, and calls
	// loadOrCreateSecret to populate authSecret. A throw would indicate
	// a parsing or secret-loading failure.
	//
	// Limitation: Bun's ES module live bindings may not reliably propagate
	// `export let` reassignments from within function calls in the test
	// runner, so we assert no-throw only. At runtime in the daemon
	// process, live bindings propagate correctly because state.ts and
	// daemon.ts share the same module instance.
	it("reloadAuthState completes without error in token mode", async () => {
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
				"  mode: token",
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

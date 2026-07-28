/**
 * Regression tests for issue #606 dual-mode daemon bugs, introduced in PR #615 (commit 64fbfa20).
 *
 * Bug 1 — fd race: createWriteStream opened file lazily; the underlying fd was undefined when
 *   Node's child_process.spawn validated stdio descriptors synchronously. Fix: use openSync to
 *   get a real integer fd before calling spawn.
 *
 * Bug 2 — update drift: the daemon always spawned a bundled version and then applied version
 *   checks / auto-updates, causing a restart loop when a CLI-managed daemon was already running.
 *   Fix: probe health first; attach (skip spawn) when a healthy daemon is already listening.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import EventEmitter from "node:events";

// ---------------------------------------------------------------------------
// Module mocks — declared before any dynamic import of the module under test.
// bun:test hoists mock.module calls so substitutes are in place when the
// module graph is first evaluated. Dynamic imports (await import) below pick
// up the mocked versions automatically.
// ---------------------------------------------------------------------------

// Stub electron: DaemonManager#spawnBundled calls app.getPath("userData"),
// which would crash without an Electron runtime. We provide a real path so
// that mkdirSync/openSync stubs receive a predictable argument.
mock.module("electron", () => ({
	default: {
		app: { getPath: (_name: string) => "/tmp/signet-test-userdata", isPackaged: false },
	},
	app: { getPath: (_name: string) => "/tmp/signet-test-userdata", isPackaged: false },
}));

// Stub ./paths.js so tests never touch Electron resource paths or the real filesystem.
mock.module("./paths.js", () => ({
	bunPath: () => "/usr/local/bin/bun",
	daemonEntry: () => "/tmp/signet-test-daemon/dist/daemon.js",
	daemonRoot: () => "/tmp/signet-test-daemon",
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mock.module declarations so the mocked
// dependencies are in scope when DaemonManager is evaluated.
// ---------------------------------------------------------------------------
const { DaemonManager } = await import("./daemon-manager.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake ChildProcess that satisfies DaemonManager's needs. */
function makeFakeChild(): ChildProcess {
	const emitter = new EventEmitter() as unknown as ChildProcess;
	(emitter as unknown as Record<string, unknown>).exitCode = null;
	(emitter as unknown as Record<string, unknown>).signalCode = null;
	(emitter as unknown as Record<string, unknown>).pid = 99999;
	(emitter as unknown as Record<string, unknown>).kill = (_signal?: string) => true;
	return emitter;
}

/** Healthy /health JSON payload that satisfies the HealthStatus schema. */
const HEALTHY_PAYLOAD = {
	version: "1.0.0-test",
	pid: 42,
	uptime: 100,
	agentsDir: "/tmp/signet-workspace",
};

/** Minimal Response-like object that represents a 200 /health response. */
function healthyFetchResponse(): Response {
	return {
		ok: true,
		json: () => Promise.resolve(HEALTHY_PAYLOAD),
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DaemonManager dual-mode regressions (#606 / PR #615)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});

	// -----------------------------------------------------------------------
	// Regression 1 — fd race fix
	// -----------------------------------------------------------------------
	test("spawnBundled passes synchronous fd, not lazy WriteStream (regression for #606 fd race)", async () => {
		// Arrange: the initial probe throws (no daemon running), so DaemonManager
		// falls through to #spawnBundled. Subsequent probes in the health-wait loop
		// succeed so the function returns quickly.
		let fetchCallCount = 0;
		globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			fetchCallCount += 1;
			// First call: initial 500ms probe in #ensureStarted — simulate no daemon.
			// All subsequent calls: health-wait loop after spawn — return healthy.
			if (fetchCallCount <= 1) throw new Error("ECONNREFUSED");
			return healthyFetchResponse();
		};

		// Stub node:fs — avoid touching real filesystem; capture fd arguments.
		const fs = await import("node:fs");
		const STDOUT_FD = 17;
		const STDERR_FD = 18;
		let openSyncCallCount = 0;
		const openedPaths: string[] = [];
		const openSyncSpy = spyOn(fs, "openSync").mockImplementation(
			(path: fs.PathLike | number, _flags: fs.OpenMode): number => {
				openSyncCallCount += 1;
				openedPaths.push(String(path));
				return openSyncCallCount === 1 ? STDOUT_FD : STDERR_FD;
			},
		);
		spyOn(fs, "existsSync").mockReturnValue(true);
		spyOn(fs, "mkdirSync").mockReturnValue(undefined);

		// Stub child_process.spawn so no real process is created.
		const cp = await import("node:child_process");
		const fakeChild = makeFakeChild();
		const spawnSpy = spyOn(cp, "spawn").mockReturnValue(fakeChild);

		// Act
		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		await manager.ensureStarted();

		// Assert: spawn was invoked exactly once.
		expect(spawnSpy).toHaveBeenCalledTimes(1);

		const spawnOpts = spawnSpy.mock.calls[0][2] as { stdio: unknown[] };
		const stdioArg = spawnOpts.stdio;

		// stdin must be "ignore".
		expect(stdioArg[0]).toBe("ignore");

		// stdout and stderr must be plain integers (from openSync), NOT objects or WriteStreams.
		// This is the core assertion: if createWriteStream were still used, these would be
		// WriteStream instances whose underlying fd is undefined at spawn call time.
		expect(typeof stdioArg[1]).toBe("number");
		expect(typeof stdioArg[2]).toBe("number");

		// The exact fd values returned by openSync must be forwarded unchanged to spawn.
		expect(stdioArg[1]).toBe(STDOUT_FD);
		expect(stdioArg[2]).toBe(STDERR_FD);

		// openSync must have been used (proves the sync path, not the lazy createWriteStream path).
		expect(openSyncSpy).toHaveBeenCalledTimes(2);
		expect(openedPaths).toEqual([
			"/tmp/signet-workspace/.daemon/logs/daemon.out.log",
			"/tmp/signet-workspace/.daemon/logs/daemon.err.log",
		]);

		openSyncSpy.mockRestore();
	});

	// -----------------------------------------------------------------------
	// Regression 2 — attach-mode skips spawn (update-drift fix)
	// -----------------------------------------------------------------------
	test("ensureStarted attaches when daemon healthy at :3850 (regression for #606 update-drift loop)", async () => {
		// Arrange: daemon is already healthy — every fetch returns 200.
		globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
			healthyFetchResponse();

		const cp = await import("node:child_process");
		const spawnSpy = spyOn(cp, "spawn");

		// Act
		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		const status = await manager.ensureStarted();

		// Assert: spawn must NOT be called — we attached to the existing daemon.
		expect(spawnSpy).not.toHaveBeenCalled();

		// The manager must report attached mode, confirming the attach path was taken.
		expect(status.mode).toBe("attached");
		expect(manager.daemonMode).toBe("attached");
	});

	// -----------------------------------------------------------------------
	// Complementary: bundled spawn fires when probe fails
	// -----------------------------------------------------------------------
	test("ensureStarted spawns bundled when probe fails", async () => {
		// Arrange: initial probe fails; health-wait loop succeeds after spawn.
		let fetchCallCount = 0;
		globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			fetchCallCount += 1;
			if (fetchCallCount <= 1) throw new Error("ECONNREFUSED");
			return healthyFetchResponse();
		};

		const fs = await import("node:fs");
		spyOn(fs, "openSync").mockImplementation((_path: fs.PathLike | number, _flags: fs.OpenMode): number => 99);
		spyOn(fs, "existsSync").mockReturnValue(true);
		spyOn(fs, "mkdirSync").mockReturnValue(undefined);

		const cp = await import("node:child_process");
		const fakeChild = makeFakeChild();
		const spawnSpy = spyOn(cp, "spawn").mockReturnValue(fakeChild);

		// Act
		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		const status = await manager.ensureStarted();

		// Assert: spawn was called because the initial probe failed.
		expect(spawnSpy).toHaveBeenCalledTimes(1);

		// The manager must report bundled mode.
		expect(status.mode).toBe("bundled");
		expect(manager.daemonMode).toBe("bundled");
	});
});

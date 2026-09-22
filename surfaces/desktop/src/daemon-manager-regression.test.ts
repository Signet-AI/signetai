import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import EventEmitter from "node:events";
import { join, resolve } from "node:path";
mock.module("electron", () => ({
	default: {
		app: { getPath: (_name: string) => "/tmp/signet-test-userdata", isPackaged: false },
	},
	app: { getPath: (_name: string) => "/tmp/signet-test-userdata", isPackaged: false },
}));
mock.module("./paths.js", () => ({
	bunPath: () => "/usr/local/bin/bun",
	daemonEntry: () => "/tmp/signet-test-daemon/dist/daemon.js",
	daemonRoot: () => "/tmp/signet-test-daemon",
}));
const { DaemonManager } = await import("./daemon-manager.js");
function makeFakeChild(): ChildProcess {
	const emitter = new EventEmitter() as unknown as ChildProcess;
	(emitter as unknown as Record<string, unknown>).exitCode = null;
	(emitter as unknown as Record<string, unknown>).signalCode = null;
	(emitter as unknown as Record<string, unknown>).pid = 99999;
	(emitter as unknown as Record<string, unknown>).kill = (_signal?: string) => true;
	return emitter;
}
const HEALTHY_PAYLOAD = {
	version: "1.0.0-test",
	pid: 42,
	uptime: 100,
	runtime: "bun-js",
	agentsDir: "/tmp/signet-workspace",
};
function healthyFetchResponse(): Response {
	return {
		ok: true,
		json: () => Promise.resolve(HEALTHY_PAYLOAD),
	} as unknown as Response;
}

describe("DaemonManager dual-mode regressions (#606 / PR #615)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		mock.restore();
	});
	test("spawnBundled passes synchronous fd, not lazy WriteStream (regression for #606 fd race)", async () => {
		let fetchCallCount = 0;
		globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			fetchCallCount += 1;
			if (fetchCallCount <= 1) throw new Error("ECONNREFUSED");
			return healthyFetchResponse();
		};
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
		const cp = await import("node:child_process");
		const fakeChild = makeFakeChild();
		const spawnSpy = spyOn(cp, "spawn").mockReturnValue(fakeChild);
		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		await manager.ensureStarted();
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(spawnSpy.mock.calls[0][0]).toBe("/usr/local/bin/bun");

		const spawnOpts = spawnSpy.mock.calls[0][2] as { stdio: unknown[] };
		const stdioArg = spawnOpts.stdio;
		expect(stdioArg[0]).toBe("ignore");
		expect(typeof stdioArg[1]).toBe("number");
		expect(typeof stdioArg[2]).toBe("number");
		expect(stdioArg[1]).toBe(STDOUT_FD);
		expect(stdioArg[2]).toBe(STDERR_FD);
		expect(openSyncSpy).toHaveBeenCalledTimes(2);
		expect(openedPaths).toEqual([
			join(resolve("/tmp/signet-workspace"), ".daemon", "logs", "daemon.out.log"),
			join(resolve("/tmp/signet-workspace"), ".daemon", "logs", "daemon.err.log"),
		]);

		openSyncSpy.mockRestore();
	});
	test("ensureStarted attaches when daemon healthy at :3850 (regression for #606 update-drift loop)", async () => {
		globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
			healthyFetchResponse();

		const cp = await import("node:child_process");
		const spawnSpy = spyOn(cp, "spawn");
		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		const status = await manager.ensureStarted();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(status.mode).toBe("attached");
		expect(manager.daemonMode).toBe("attached");
		expect(status.runtime).toBe("bun-js");
	});
	test("ensureStarted spawns bundled when probe fails", async () => {
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
		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		const status = await manager.ensureStarted();
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(status.mode).toBe("bundled");
		expect(manager.daemonMode).toBe("bundled");
	});

	test("ENOENT from bundled runtime produces actionable startup state instead of an unhandled error", async () => {
		globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			throw new Error("ECONNREFUSED");
		};

		const fs = await import("node:fs");
		spyOn(fs, "openSync").mockImplementation((_path: fs.PathLike | number, _flags: fs.OpenMode): number => 99);
		spyOn(fs, "existsSync").mockReturnValue(true);
		spyOn(fs, "mkdirSync").mockReturnValue(undefined);

		const cp = await import("node:child_process");
		const fakeChild = makeFakeChild();
		const spawnSpy = spyOn(cp, "spawn").mockImplementation(() => {
			queueMicrotask(() => {
				const error = Object.assign(new Error("spawn /missing/bun ENOENT"), { code: "ENOENT" });
				fakeChild.emit("error", error);
			});
			return fakeChild;
		});

		const manager = new DaemonManager({ workspacePath: "/tmp/signet-workspace" });
		await expect(manager.ensureStarted()).rejects.toThrow("Reinstall the desktop app or install Bun");

		const status = await manager.status();
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(status.running).toBe(false);
		expect(status.mode).toBe("none");
		expect(status.startupErrorCode).toBe("bundled-runtime-enoent");
		expect(status.startupError).toContain("Reinstall the desktop app or install Bun");
	});
});

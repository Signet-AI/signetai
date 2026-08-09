import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPreviousDaemonExit, lifecyclePath, readDaemonLifecycle, writeDaemonLifecycle } from "./lifecycle";

// Regression tests for issue #1148: a daemon death must be distinguishable as
// clean, error, or unrecorded (killed/crashed) from the durable lifecycle
// record alone, because the process itself leaves no trace on SIGKILL.

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "signet-lifecycle-"));
}

describe("daemon lifecycle record (#1148)", () => {
	it("persists a clean shutdown record with the exit path and code", () => {
		const root = tempRoot();
		try {
			writeDaemonLifecycle(root, {
				state: "clean",
				pid: 4242,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
				reason: "signal:SIGTERM",
				exitCode: 0,
				exitedAt: "2026-08-07T01:00:00.000Z",
			});
			const record = readDaemonLifecycle(root);
			expect(record).not.toBeNull();
			expect(record?.state).toBe("clean");
			expect(record?.reason).toBe("signal:SIGTERM");
			expect(record?.exitCode).toBe(0);
			expect(record?.exitedAt).toBe("2026-08-07T01:00:00.000Z");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves the record at running when the process dies without an exit path, which is how SIGKILL/OOM deaths surface", () => {
		const root = tempRoot();
		try {
			// The daemon wrote "running" and then was killed: no terminal state
			// is ever recorded. A status probe must be able to read exactly this
			// and call it an unrecorded death, not a clean shutdown.
			writeDaemonLifecycle(root, {
				state: "running",
				pid: 7,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
			});
			const record = readDaemonLifecycle(root);
			expect(record?.state).toBe("running");
			expect(record?.exitedAt).toBeUndefined();
			expect(record?.reason).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records an internal-error exit with the error message", () => {
		const root = tempRoot();
		try {
			writeDaemonLifecycle(root, {
				state: "error",
				pid: 9,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
				reason: "error:uncaughtException",
				exitCode: 1,
				exitedAt: "2026-08-07T00:00:30.000Z",
				error: "Cannot read properties of undefined (reading 'x')",
			});
			expect(readDaemonLifecycle(root)?.error).toContain("Cannot read properties");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null for a missing record (pre-#1148 daemons) instead of throwing", () => {
		const root = tempRoot();
		try {
			expect(readDaemonLifecycle(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null for a corrupt record instead of throwing", () => {
		const root = tempRoot();
		try {
			mkdirSync(join(root, ".daemon"), { recursive: true });
			writeFileSync(join(root, ".daemon", "lifecycle.json"), "{not json");
			expect(readDaemonLifecycle(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("classifies a prior clean exit with bounded restart metadata (#1255)", () => {
		const result = classifyPreviousDaemonExit(
			{
				state: "clean",
				pid: 4242,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
				reason: "signal:SIGTERM",
				exitCode: 0,
				exitedAt: "2026-08-07T01:00:00.000Z",
			},
			"2026-08-07T01:05:00.000Z",
		);
		expect(result).toEqual({
			classification: "clean",
			previousVersion: "0.165.0",
			previousUptimeMs: 3_600_000,
			reasonCategory: "signal",
			exitCode: 0,
			restartDelayMs: 300_000,
		});
	});

	it("classifies a catchable error without exporting its raw reason or message (#1255)", () => {
		const result = classifyPreviousDaemonExit(
			{
				state: "error",
				pid: 9,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
				reason: "error:uncaughtException",
				exitCode: 1,
				exitedAt: "2026-08-07T00:00:30.000Z",
				error: "secret local error text",
			},
			"2026-08-07T00:02:00.000Z",
		);
		expect(result).toEqual({
			classification: "error",
			previousVersion: "0.165.0",
			previousUptimeMs: 30_000,
			reasonCategory: "uncaught_exception",
			exitCode: 1,
			restartDelayMs: 90_000,
		});
	});

	it("bounds previous-exit fields and drops arbitrary reasons (#1255)", () => {
		const result = classifyPreviousDaemonExit(
			{
				state: "error",
				pid: 7,
				version: "x".repeat(100),
				startedAt: "2020-01-01T00:00:00.000Z",
				reason: "error:secret local reason",
				exitCode: 9999,
				exitedAt: "2021-01-01T00:00:00.000Z",
			},
			"2022-01-01T00:00:00.000Z",
		);
		expect(result).toEqual({
			classification: "error",
			previousVersion: "x".repeat(64),
			previousUptimeMs: 365 * 24 * 60 * 60 * 1000,
			reasonCategory: "other",
			exitCode: 255,
			restartDelayMs: 365 * 24 * 60 * 60 * 1000,
		});
	});

	it("classifies starting and running records as unrecorded deaths (#1255)", () => {
		for (const state of ["starting", "running"] as const) {
			const result = classifyPreviousDaemonExit(
				{
					state,
					pid: 7,
					version: "0.165.0",
					startedAt: "2026-08-07T00:00:00.000Z",
				},
				"2026-08-07T01:00:00.000Z",
			);
			expect(result).toEqual({
				classification: "unrecorded",
				previousVersion: "0.165.0",
				previousUptimeMs: 3_600_000,
			});
		}
	});

	it("does not classify a first boot without a prior lifecycle record (#1255)", () => {
		expect(classifyPreviousDaemonExit(null, "2026-08-07T01:00:00.000Z")).toBeNull();
	});

	it("replaces the previous record in place without leaving a temp file", () => {
		const root = tempRoot();
		try {
			writeDaemonLifecycle(root, {
				state: "starting",
				pid: 1,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
			});
			writeDaemonLifecycle(root, {
				state: "running",
				pid: 1,
				version: "0.165.0",
				startedAt: "2026-08-07T00:00:00.000Z",
			});
			expect(readDaemonLifecycle(root)?.state).toBe("running");
			expect(lifecyclePath(root)).toContain(".daemon");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

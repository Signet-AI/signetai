import { afterEach, describe, expect, it } from "bun:test";
import {
	classifyMacOsProcPidInfoResult,
	getResourceSnapshot,
	logFdSnapshot,
	parseMacOsFdInfo,
	startEventLoopMonitor,
	startFdPollMonitor,
	stopResourceMonitors,
} from "./resource-monitor";
import type { ResourceSnapshot } from "./resource-monitor";

afterEach(() => {
	stopResourceMonitors();
});

describe("getResourceSnapshot", () => {
	it("reports accurate platform FD accounting or an explicit unsupported state", () => {
		const snap = getResourceSnapshot();
		if (process.platform === "linux") {
			expect(snap.total).toBeGreaterThan(0);
			return;
		}
		if (process.platform === "darwin" && snap.total !== null) {
			expect(snap.total).toBeGreaterThan(0);
			expect(snap.sockets).not.toBeNull();
			expect(snap.pipes).not.toBeNull();
			expect(snap.other).not.toBeNull();
			expect(snap.memoryMd).toBeNull();
			expect(snap.inotify).toBeNull();
			expect(snap.db).toBeNull();
			if (snap.sockets === null || snap.pipes === null || snap.other === null) {
				throw new Error("macOS FD accounting unexpectedly returned an unavailable category");
			}
			const sum = snap.sockets + snap.pipes + snap.other;
			expect(sum).toBe(snap.total);
			return;
		}
		expect(snap.total).toBeNull();
	});

	it("returns all required fields", () => {
		const snap = getResourceSnapshot();
		const keys: ReadonlyArray<keyof ResourceSnapshot> = [
			"total",
			"memoryMd",
			"sockets",
			"inotify",
			"pipes",
			"db",
			"other",
			"rss",
			"heapUsed",
			"cpuPercent",
		];
		for (const key of keys) {
			expect(snap[key] === null || typeof snap[key] === "number").toBe(true);
		}
		expect(snap.physicalFootprint === null || typeof snap.physicalFootprint === "number").toBe(true);
		expect(snap.peakPhysicalFootprint === null || typeof snap.peakPhysicalFootprint === "number").toBe(true);
	});

	it("reports rss and heapUsed in MB (positive integers)", () => {
		const snap = getResourceSnapshot();
		expect(snap.rss).toBeGreaterThan(0);
		expect(snap.heapUsed).toBeGreaterThan(0);
		expect(Number.isInteger(snap.rss)).toBe(true);
		expect(Number.isInteger(snap.heapUsed)).toBe(true);
	});

	it("reports physical footprint and lifetime peak in MB when available", () => {
		const snap = getResourceSnapshot(() => ({ current: 1536, peak: 2048 }));
		expect(snap.physicalFootprint).toBe(1536);
		expect(snap.peakPhysicalFootprint).toBe(2048);
	});

	it("uses null when physical footprint is unavailable", () => {
		const snap = getResourceSnapshot(() => null);
		expect(snap.physicalFootprint).toBeNull();
		expect(snap.peakPhysicalFootprint).toBeNull();
	});

	it("reads the current macOS process physical footprint", () => {
		if (process.platform !== "darwin") return;
		const snap = getResourceSnapshot();
		expect(snap.physicalFootprint).toBeGreaterThan(0);
		expect(snap.peakPhysicalFootprint).toBeGreaterThanOrEqual(snap.physicalFootprint ?? 0);
	});

	it("FD category counts sum to total on Linux", () => {
		if (process.platform !== "linux") return;
		const snap = getResourceSnapshot();
		if (
			snap.memoryMd === null ||
			snap.sockets === null ||
			snap.inotify === null ||
			snap.pipes === null ||
			snap.db === null ||
			snap.other === null ||
			snap.total === null
		) {
			throw new Error("Linux FD accounting unexpectedly returned an unavailable category");
		}
		const sum = snap.memoryMd + snap.sockets + snap.inotify + snap.pipes + snap.db + snap.other;
		expect(sum).toBe(snap.total);
	});

	it("parses macOS proc_pidinfo FD records without using Linux procfs", () => {
		const raw = new Uint8Array(24);
		const view = new DataView(raw.buffer);
		view.setUint32(4, 2, true); // socket
		view.setUint32(12, 6, true); // pipe
		view.setUint32(20, 1, true); // vnode, path categories are unavailable

		expect(parseMacOsFdInfo(raw)).toEqual({
			total: 3,
			memoryMd: null,
			sockets: 1,
			inotify: null,
			pipes: 1,
			db: null,
			other: 1,
		});
	});

	it("reports unavailable counts for a truncated macOS proc_fdinfo record", () => {
		expect(parseMacOsFdInfo(new Uint8Array(7))).toEqual({
			total: null,
			memoryMd: null,
			sockets: null,
			inotify: null,
			pipes: null,
			db: null,
			other: null,
		});
	});

	it("distinguishes documented proc_pidinfo failures from empty success", () => {
		expect(classifyMacOsProcPidInfoResult(0, 0)).toEqual({ kind: "success", bytes: 0 });
		expect(classifyMacOsProcPidInfoResult(0, null)).toEqual({ kind: "unavailable", reason: "unknown" });
		expect(classifyMacOsProcPidInfoResult(0, 3)).toEqual({ kind: "unavailable", reason: "process-gone" });
		expect(classifyMacOsProcPidInfoResult(0, 4)).toEqual({ kind: "retry" });
		expect(classifyMacOsProcPidInfoResult(0, 12)).toEqual({ kind: "grow" });
		expect(classifyMacOsProcPidInfoResult(0, 1)).toEqual({ kind: "unavailable", reason: "permission-denied" });
		expect(classifyMacOsProcPidInfoResult(0, 22)).toEqual({ kind: "unavailable", reason: "invalid-request" });
	});
});

describe("logFdSnapshot", () => {
	it("returns the same shape as getResourceSnapshot", () => {
		const snap = logFdSnapshot("test-stage");
		expect(snap.total === null || typeof snap.total === "number").toBe(true);
		expect(typeof snap.rss).toBe("number");
	});
});

describe("startEventLoopMonitor / stopResourceMonitors", () => {
	it("starts and stops without throwing", () => {
		expect(() => startEventLoopMonitor(500)).not.toThrow();
		expect(() => stopResourceMonitors()).not.toThrow();
	});

	it("calling start twice replaces the previous timer", () => {
		startEventLoopMonitor(500);
		expect(() => startEventLoopMonitor(500)).not.toThrow();
		stopResourceMonitors();
	});
});

describe("startFdPollMonitor / stopResourceMonitors", () => {
	it("starts and stops without throwing", () => {
		expect(() => startFdPollMonitor(500)).not.toThrow();
		expect(() => stopResourceMonitors()).not.toThrow();
	});

	it("calling start twice replaces the previous timer", () => {
		startFdPollMonitor(500);
		expect(() => startFdPollMonitor(500)).not.toThrow();
		stopResourceMonitors();
	});
});

describe("stopResourceMonitors", () => {
	it("is idempotent when no monitors are running", () => {
		expect(() => stopResourceMonitors()).not.toThrow();
		expect(() => stopResourceMonitors()).not.toThrow();
	});
});

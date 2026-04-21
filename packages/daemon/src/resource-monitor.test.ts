import { afterEach, describe, expect, it } from "bun:test";
import {
	getResourceSnapshot,
	logFdSnapshot,
	startEventLoopMonitor,
	startFdPollMonitor,
	stopResourceMonitors,
} from "./resource-monitor";
import type { ResourceSnapshot } from "./resource-monitor";

afterEach(() => {
	stopResourceMonitors();
});

describe("getResourceSnapshot", () => {
	it("returns a snapshot with non-negative total on Linux", () => {
		const snap = getResourceSnapshot();
		// On Linux /proc/self/fd is readable; on other platforms total = -1
		if (process.platform === "linux") {
			expect(snap.total).toBeGreaterThan(0);
		} else {
			expect(snap.total).toBe(-1);
		}
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
		];
		for (const key of keys) {
			expect(typeof snap[key]).toBe("number");
		}
	});

	it("reports rss and heapUsed in MB (positive integers)", () => {
		const snap = getResourceSnapshot();
		expect(snap.rss).toBeGreaterThan(0);
		expect(snap.heapUsed).toBeGreaterThan(0);
		expect(Number.isInteger(snap.rss)).toBe(true);
		expect(Number.isInteger(snap.heapUsed)).toBe(true);
	});

	it("FD category counts sum to total on Linux", () => {
		if (process.platform !== "linux") return;
		const snap = getResourceSnapshot();
		const sum = snap.memoryMd + snap.sockets + snap.inotify + snap.pipes + snap.db + snap.other;
		expect(sum).toBe(snap.total);
	});
});

describe("logFdSnapshot", () => {
	it("returns the same shape as getResourceSnapshot", () => {
		const snap = logFdSnapshot("test-stage");
		expect(typeof snap.total).toBe("number");
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

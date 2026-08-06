import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { TELEMETRY_EVENTS, createTelemetryCollector, defaultTelemetryLogPath } from "./telemetry";

let dir = "";
let logPath = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-telemetry-"));
	logPath = defaultTelemetryLogPath(dir);
	initDbAccessor(join(dir, "memory", "telemetry-test.db"));
});

afterEach(() => {
	closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

describe("telemetry lifecycle events (issue #1026 Phase 2)", () => {
	it("declares the Phase-2 lifecycle event types", () => {
		for (const event of ["daemon.started", "command.invoked", "error.occurred", "version.upgraded"]) {
			expect(TELEMETRY_EVENTS).toContain(event);
		}
	});

	it("mirrors recorded events to the open JSONL log", () => {
		const collector = createTelemetryCollector(
			{
				withWriteTx: (fn) => fn({ prepare: () => ({ run: () => {} }) }),
				withReadDb: (fn) => fn({ prepare: () => ({ all: () => [] }) }),
			} as never,
			{
				posthogHost: "",
				posthogApiKey: "",
				flushIntervalMs: 60000,
				flushBatchSize: 50,
				retentionDays: 90,
				memorySearchQaEnabled: false,
			},
			"0.163.15",
			{ telemetryLogPath: logPath },
		);

		collector.record("daemon.started", { version: "0.163.15", platform: process.platform, uptimeMs: 0 });
		collector.record("command.invoked", { command: "status" });

		expect(existsSync(logPath)).toBe(true);
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]) as { event: string; properties: { version: string } };
		expect(first.event).toBe("daemon.started");
		expect(first.properties.version).toBe("0.163.15");
		const second = JSON.parse(lines[1]) as { event: string; properties: { command: string } };
		expect(second.event).toBe("command.invoked");
		expect(second.properties.command).toBe("status");
	});

	it("does not write a log when telemetryLogPath is omitted", () => {
		const collector = createTelemetryCollector(
			{
				withWriteTx: (fn) => fn({ prepare: () => ({ run: () => {} }) }),
				withReadDb: (fn) => fn({ prepare: () => ({ all: () => [] }) }),
			} as never,
			{
				posthogHost: "",
				posthogApiKey: "",
				flushIntervalMs: 60000,
				flushBatchSize: 50,
				retentionDays: 90,
				memorySearchQaEnabled: false,
			},
			"0.163.15",
		);
		collector.record("daemon.started", { version: "0.163.15" });
		expect(existsSync(logPath)).toBe(false);
	});

	it("tolerates an unwritable log path without throwing", () => {
		const collector = createTelemetryCollector(
			{
				withWriteTx: (fn) => fn({ prepare: () => ({ run: () => {} }) }),
				withReadDb: (fn) => fn({ prepare: () => ({ all: () => [] }) }),
			} as never,
			{
				posthogHost: "",
				posthogApiKey: "",
				flushIntervalMs: 60000,
				flushBatchSize: 50,
				retentionDays: 90,
				memorySearchQaEnabled: false,
			},
			"0.163.15",
			{ telemetryLogPath: "/dev/null/nonexistent/events.jsonl" },
		);
		expect(() => collector.record("daemon.started", { version: "0.163.15" })).not.toThrow();
	});
});

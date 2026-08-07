/**
 * Regression tests for the anonymous PostHog telemetry collector.
 *
 * Names the bug they guard: the constant "signet-anonymous" distinct_id
 * collapsed every install into one PostHog user, making install and usage
 * analytics impossible. The remaining tests pin the send lifecycle
 * (batch shape, mark-sent, no-resend, backoff, retention pruning) and the
 * open JSONL telemetry log (lifecycle events, issue #1026 Phase 2) so a
 * future change can't silently stop events from reaching PostHog or the
 * audit log.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type DbAccessor, closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	TELEMETRY_EVENTS,
	type TelemetryCollector,
	createTelemetryCollector,
	defaultTelemetryLogPath,
	nextFlushIntervalMs,
} from "./telemetry";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

const TELEMETRY_CONFIG = {
	posthogHost: "http://posthog.test",
	posthogApiKey: "phc_test_key",
	flushIntervalMs: 60000,
	flushBatchSize: 50,
	retentionDays: 90,
	memorySearchQaEnabled: false,
} as const;

interface CapturedBody {
	readonly api_key: string;
	readonly batch: ReadonlyArray<{
		readonly event: string;
		readonly distinct_id: string;
		readonly properties: Record<string, unknown>;
	}>;
}

let dir = "";
let logPath = "";
let captured: Array<{ readonly url: string; readonly body: CapturedBody }> = [];
const originalFetch = globalThis.fetch;

function installFetchMock(): void {
	captured = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		captured.push({
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as CapturedBody,
		});
		return new Response("1", { status: 200 });
	}) as typeof fetch;
}

function resetWorkspace(): void {
	closeDbAccessor();
	rmSync(join(dir, "memory"), { recursive: true, force: true });
	rmSync(join(dir, ".daemon"), { recursive: true, force: true });
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
}

function makeCollector(): TelemetryCollector {
	return createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.0.0-test");
}

/**
 * Minimal DbAccessor for JSONL-log tests: the collector only touches
 * withWriteTx/withReadDb there, and posthogHost is "" so nothing sends.
 */
function fakeDbAccessor(): DbAccessor {
	const stmt = { run: () => ({}), get: () => undefined, all: () => [] };
	return {
		withWriteTx: (fn: (db: { prepare(sql: string): typeof stmt }) => unknown) => fn({ prepare: () => stmt }),
		withReadDb: (fn: (db: { prepare(sql: string): typeof stmt }) => unknown) => fn({ prepare: () => stmt }),
	} as unknown as DbAccessor;
}

function lastBatchDistinctId(): string {
	const last = captured.at(-1);
	if (!last) throw new Error("no PostHog request captured");
	const first = last.body.batch[0];
	if (!first) throw new Error("captured batch was empty");
	return first.distinct_id;
}

function unsentCount(): number {
	return getDbAccessor().withReadDb((db) => {
		const row = db.prepare("SELECT COUNT(*) AS count FROM telemetry_events WHERE sent_to_posthog = 0").get() as {
			readonly count: number;
		};
		return row.count;
	});
}

function installRowCount(): number {
	return getDbAccessor().withReadDb((db) => {
		const row = db.prepare("SELECT COUNT(*) AS count FROM telemetry_install").get() as { readonly count: number };
		return row.count;
	});
}

// Shared harness for both suites below: fresh workspace per test, including
// a clean .daemon dir so the JSONL log cannot leak between tests.
beforeAll(() => {
	dir = createTestTempDir("signet-telemetry-");
	installFetchMock();
	resetWorkspace();
});

beforeEach(() => {
	captured = [];
	logPath = defaultTelemetryLogPath(dir);
	resetWorkspace();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	closeDbAccessor();
	cleanupTestTempDir(dir);
});

describe("telemetry collector", () => {
	it("uses a different anonymous id for different workspaces", async () => {
		const collectorA = makeCollector();
		collectorA.record("daemon.heartbeat", { uptimeMs: 1 });
		await collectorA.flush();
		const idA = lastBatchDistinctId();
		expect(idA).not.toBe("signet-anonymous");

		const dirB = createTestTempDir("signet-telemetry-b-");
		try {
			closeDbAccessor();
			initDbAccessor(join(dirB, "memory", "memories.db"));
			const collectorB = makeCollector();
			collectorB.record("daemon.heartbeat", { uptimeMs: 1 });
			await collectorB.flush();
			expect(lastBatchDistinctId()).not.toBe(idA);
		} finally {
			closeDbAccessor();
			cleanupTestTempDir(dirB);
			resetWorkspace();
		}
	});

	it("keeps one stable anonymous id across collector restarts", async () => {
		const first = makeCollector();
		first.record("daemon.heartbeat", { uptimeMs: 1 });
		await first.flush();
		const idA = lastBatchDistinctId();

		// Second collector over the same database, like a daemon restart.
		const second = makeCollector();
		second.record("daemon.heartbeat", { uptimeMs: 2 });
		await second.flush();
		expect(lastBatchDistinctId()).toBe(idA);
		expect(installRowCount()).toBe(1);
	});

	it("posts batches with the install id and marks events sent", async () => {
		const collector = makeCollector();
		collector.record("session.start", { harness: "hermes-agent" });
		collector.record("llm.generate", { provider: "test", latencyMs: 42, success: true });
		await collector.flush();

		expect(captured).toHaveLength(1);
		const body = captured[0]?.body;
		expect(body?.api_key).toBe("phc_test_key");
		expect(body?.batch).toHaveLength(2);
		expect(body?.batch[0]?.distinct_id).toBe(lastBatchDistinctId());
		expect(body?.batch[1]?.properties.$lib).toBe("signet-daemon");
		expect(unsentCount()).toBe(0);
	});

	it("does not resend events already marked sent", async () => {
		const collector = makeCollector();
		collector.record("daemon.heartbeat", { uptimeMs: 1 });
		await collector.flush();
		await collector.flush();
		expect(captured).toHaveLength(1);
	});

	it("backs off after three consecutive PostHog failures", () => {
		expect(nextFlushIntervalMs(60000, 0)).toBe(60000);
		expect(nextFlushIntervalMs(60000, 2)).toBe(60000);
		expect(nextFlushIntervalMs(60000, 3)).toBe(300000);
		expect(nextFlushIntervalMs(60000, 9)).toBe(300000);
	});

	it("prunes events older than the retention window", async () => {
		const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
		getDbAccessor().withWriteTx((w) => {
			w.prepare(
				"INSERT INTO telemetry_events (id, event, timestamp, properties, sent_to_posthog, created_at) VALUES (?, ?, ?, ?, 0, ?)",
			).run("old-1", "daemon.heartbeat", old, "{}", old);
		});

		const collector = makeCollector();
		collector.record("daemon.heartbeat", { uptimeMs: 1 });
		// Pruning runs on every 10th flush.
		for (let i = 0; i < 10; i++) {
			await collector.flush();
		}

		const rows = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT id FROM telemetry_events").all() as Array<{ readonly id: string }>,
		);
		expect(rows.map((r) => r.id)).not.toContain("old-1");
		expect(rows.length).toBe(1);
	});
});

describe("telemetry lifecycle events (issue #1026 Phase 2)", () => {
	it("declares the Phase-2 lifecycle event types", () => {
		for (const event of ["daemon.started", "command.invoked", "error.occurred", "version.upgraded"]) {
			expect(TELEMETRY_EVENTS).toContain(event);
		}
	});

	it("mirrors recorded events to the open JSONL log", () => {
		const collector = createTelemetryCollector(
			fakeDbAccessor(),
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
			fakeDbAccessor(),
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
			fakeDbAccessor(),
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

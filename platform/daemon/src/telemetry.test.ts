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
	type TelemetryConfigSnapshot,
	createTelemetryCollector,
	defaultTelemetryLogPath,
	nextFlushIntervalMs,
	sanitizeCrashError,
	telemetryDeployment,
	telemetryDisabledByEnv,
	telemetryReportedVersion,
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

function makeCollector(configSnapshot?: TelemetryConfigSnapshot): TelemetryCollector {
	return createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.0.0-test", { configSnapshot });
}

/**
 * Minimal DbAccessor for JSONL-log tests: the collector only touches
 * withWriteTx/withReadDb there, and posthogHost is "" so nothing sends.
 */
function fakeDbAccessor(): DbAccessor {
	const stmt = { run: () => ({ changes: 1 }), get: () => undefined, all: () => [] };
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
		// install.activated fires first on a fresh install, then the two
		// recorded events.
		expect(body?.batch).toHaveLength(3);
		expect(body?.batch[0]?.event).toBe("install.activated");
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

	it("does not claim CLI-owned command events", async () => {
		const collector = makeCollector();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO telemetry_events
				 (id, event, timestamp, properties, sent_to_posthog, created_at, source)
				 VALUES (?, ?, ?, ?, 0, ?, 'cli')`,
			).run(
				"cli-event",
				"command.invoked",
				new Date().toISOString(),
				JSON.stringify({ command: "status" }),
				new Date().toISOString(),
			);
		});

		await collector.flush();

		const events = captured.flatMap((request) => request.body.batch.map((event) => event.event));
		expect(events).not.toContain("command.invoked");
		expect(
			getDbAccessor().withReadDb((db) => {
				const row = db.prepare("SELECT sent_to_posthog FROM telemetry_events WHERE id = ?").get("cli-event") as {
					readonly sent_to_posthog: number;
				};
				return row.sent_to_posthog;
			}),
		).toBe(0);
	});

	it("emits install.activated exactly once per install", async () => {
		// Regression: the npm postinstall ping never fires for bun global or
		// desktop installs, so the install counter missed them. The daemon
		// emits install.activated on first run (new persisted install id).
		const first = makeCollector();
		first.record("daemon.heartbeat", { uptimeMs: 1 });
		await first.flush();
		expect(captured[0]?.body.batch[0]?.event).toBe("install.activated");
		expect(captured[0]?.body.batch[0]?.properties.version).toBe("0.0.0-test");

		// Restart over the same database: no second activation.
		const second = makeCollector();
		second.record("daemon.heartbeat", { uptimeMs: 2 });
		await second.flush();
		const lastBatch = captured.at(-1)?.body.batch ?? [];
		expect(lastBatch.map((e) => e.event)).not.toContain("install.activated");
	});

	it("anonymizeAgentId: stable per install, differs across installs, never raw", async () => {
		const { cleanupTestTempDir, createTestTempDir } = await import("./test-temp-dir");
		const dir = createTestTempDir("signet-anon-");
		try {
			closeDbAccessor();
			initDbAccessor(join(dir, "memory", "memories.db"));
			const collector = createTelemetryCollector(
				getDbAccessor(),
				{
					posthogHost: "",
					posthogApiKey: "",
					flushIntervalMs: 60000,
					flushBatchSize: 50,
					retentionDays: 90,
					memorySearchQaEnabled: false,
				},
				"0.0.0-test",
			);
			const a = collector.anonymizeAgentId("hermes-agent");
			const b = collector.anonymizeAgentId("hermes-agent");
			expect(a).toBe(b); // stable within an install
			expect(a).not.toContain("hermes-agent");
			expect(a).toMatch(/^[0-9a-f]{16}$/);
			expect(collector.anonymizeAgentId("agent-a")).not.toBe(collector.anonymizeAgentId("agent-b"));
		} finally {
			closeDbAccessor();
			cleanupTestTempDir(dir);
		}
	});

	it("anonymizeAgentId differs across installs for the same agent id", async () => {
		const { cleanupTestTempDir, createTestTempDir } = await import("./test-temp-dir");
		const dirA = createTestTempDir("signet-anon-a-");
		const dirB = createTestTempDir("signet-anon-b-");
		try {
			closeDbAccessor();
			initDbAccessor(join(dirA, "memory", "memories.db"));
			const ca = createTelemetryCollector(
				getDbAccessor(),
				{
					posthogHost: "",
					posthogApiKey: "",
					flushIntervalMs: 60000,
					flushBatchSize: 50,
					retentionDays: 90,
					memorySearchQaEnabled: false,
				},
				"0.0.0-test",
			);
			const ha = ca.anonymizeAgentId("default");
			closeDbAccessor();
			initDbAccessor(join(dirB, "memory", "memories.db"));
			const cb = createTelemetryCollector(
				getDbAccessor(),
				{
					posthogHost: "",
					posthogApiKey: "",
					flushIntervalMs: 60000,
					flushBatchSize: 50,
					retentionDays: 90,
					memorySearchQaEnabled: false,
				},
				"0.0.0-test",
			);
			const hb = cb.anonymizeAgentId("default");
			expect(ha).not.toBe(hb); // same agent id hashes differently per install
		} finally {
			closeDbAccessor();
			cleanupTestTempDir(dirA);
			cleanupTestTempDir(dirB);
		}
	});

	it("emits first.remember and first.recall exactly once per install", async () => {
		// Regression (issue #1202): the activation funnel needs one-shot
		// first-use milestones guarded by the persisted install id, or
		// repeated remembers/recalls inflate the funnel and daemon restarts
		// double-count an install that already used the product.
		const first = makeCollector();
		first.recordFirstUse("remember");
		first.recordFirstUse("remember");
		first.recordFirstUse("recall");
		await first.flush();

		const rememberEvent = captured.flatMap((c) => c.body.batch).find((e) => e.event === "first.remember");
		const recallEvent = captured.flatMap((c) => c.body.batch).find((e) => e.event === "first.recall");
		expect(rememberEvent).toBeDefined();
		expect(recallEvent).toBeDefined();
		// No content: the event carries only the fact of first use.
		expect(rememberEvent?.properties).toMatchObject({ version: "0.0.0-test", platform: process.platform });
		expect(Object.keys(rememberEvent?.properties ?? {})).toEqual(["version", "platform", "$lib", "$lib_version"]);
		const firstBatch = captured.flatMap((c) => c.body.batch.map((e) => e.event));
		expect(firstBatch.filter((e) => e === "first.remember")).toHaveLength(1);
		expect(firstBatch.filter((e) => e === "first.recall")).toHaveLength(1);

		// Restart over the same database: no second first-use, even though
		// the new collector claims again.
		const second = makeCollector();
		second.recordFirstUse("remember");
		second.recordFirstUse("recall");
		second.record("daemon.heartbeat", { uptimeMs: 2 });
		await second.flush();
		const lastBatch = captured.at(-1)?.body.batch ?? [];
		expect(lastBatch.map((e) => e.event)).toEqual(["daemon.heartbeat"]);
	});

	it("recovers first-use events after termination before the normal flush", async () => {
		// Regression (issue #1275): claiming first use in one transaction and
		// buffering its event for a later transaction let a crash permanently
		// consume the milestone. The event must already be in the durable queue
		// before the process can terminate.
		const first = makeCollector();
		first.recordFirstUse("remember");
		first.recordFirstUse("remember");
		first.recordFirstUse("recall");
		first.recordFirstUse("recall");

		const beforeRestart = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT first_remember_at, first_recall_at FROM telemetry_install").get() as {
					first_remember_at: string | null;
					first_recall_at: string | null;
				},
		);
		const pendingEvents = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT event, sent_to_posthog FROM telemetry_events WHERE event IN ('first.remember', 'first.recall') ORDER BY event",
					)
					.all() as Array<{ readonly event: string; readonly sent_to_posthog: number }>,
		);
		expect(beforeRestart.first_remember_at).not.toBeNull();
		expect(beforeRestart.first_recall_at).not.toBeNull();
		expect(pendingEvents).toEqual([
			{ event: "first.recall", sent_to_posthog: 0 },
			{ event: "first.remember", sent_to_posthog: 0 },
		]);

		// Simulate a process crash: the in-memory buffer (including the
		// activation event) disappears, but the atomically persisted
		// first-use rows survive and are recoverable by the next daemon.
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
		const restarted = makeCollector();
		restarted.recordFirstUse("remember");
		restarted.recordFirstUse("recall");
		await restarted.flush();
		await restarted.flush();

		const delivered = captured.flatMap((request) => request.body.batch.map((event) => event.event));
		expect(delivered).toEqual(["first.remember", "first.recall"]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT event FROM telemetry_events WHERE event IN ('first.remember', 'first.recall') AND sent_to_posthog = 0",
					)
					.all(),
			),
		).toEqual([]);
	});

	it("emits one config snapshot alongside install activation", async () => {
		const snapshot: TelemetryConfigSnapshot = {
			graphEnabled: true,
			rerankerEnabled: false,
			autonomousEnabled: true,
			semanticContradictionEnabled: true,
			embeddingProvider: "native",
			embeddingModel: "nomic-embed-text-v1.5",
			inferenceMode: "local",
			harnesses: "codex,hermes-agent",
		};
		const first = makeCollector(snapshot);
		first.record("daemon.heartbeat", { uptimeMs: 1 });
		await first.flush();

		const firstBatch = captured[0]?.body.batch ?? [];
		expect(firstBatch.map((event) => event.event)).toEqual([
			"install.activated",
			"config.snapshot",
			"daemon.heartbeat",
		]);
		expect(firstBatch[1]?.properties).toMatchObject({
			graphEnabled: true,
			rerankerEnabled: false,
			embeddingProvider: "native",
			embeddingModel: "nomic-embed-text-v1.5",
			inferenceMode: "local",
			harnesses: "codex,hermes-agent",
		});

		const second = makeCollector(snapshot);
		second.record("daemon.heartbeat", { uptimeMs: 2 });
		await second.flush();
		expect(captured[1]?.body.batch.map((event) => event.event)).toEqual(["daemon.heartbeat"]);
	});

	it("sanitizes crash reports: truncation, home-path stripping, frame cap", () => {
		const longMessage =
			'SQLiteError: database is locked near "a very long embedded fragment that goes on and on" at /home/alice/.agents/memory/memories.db'.repeat(
				10,
			);
		const err = new Error(longMessage);
		err.stack = [
			"Error: database is locked",
			"    at run (/home/alice/.agents/platform/daemon/src/db-accessor.ts:1045:12)",
			"    at withWriteTx (/home/alice/.agents/platform/daemon/src/db-accessor.ts:1060:14)",
			"    at main (/home/alice/.agents/platform/daemon/src/daemon.ts:2001:9)",
			"    at Module._compile (node:internal/modules/cjs/loader:1234:17)",
			"    at Module._extensions..js (node:internal/modules/cjs/loader:987:10)",
			"    at Module.load (node:internal/modules/cjs/loader:812:32)",
			"    at Module._load (node:internal/modules/cjs/loader:685:12)",
			"    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main_module:99:12)",
			"    at node:internal/main/run_main_module:18:47",
		].join("\n");

		const props = sanitizeCrashError(err, 123456);
		expect(props.type).toBe("Error");
		expect(props.message.length).toBeLessThanOrEqual(400);
		expect(props.message).not.toContain("/home/alice");
		expect(props.message).toContain("~");
		expect(props.uptimeMs).toBe(123456);
		const frames = (props.stack as string).split("\n");
		expect(frames.length).toBeLessThanOrEqual(8);
		expect(frames[0]).toBe("Error: database is locked");
		expect(frames[1]).not.toContain("/home/alice");
		expect(frames[1]).toContain("~");
	});

	it("degrades non-Error rejections to a truncated string", () => {
		const props = sanitizeCrashError(`oops: ${"x".repeat(500)}`, 42);
		expect(props.type).toBe("UnhandledRejection");
		expect(props.message.length).toBeLessThanOrEqual(400);
		expect(props.uptimeMs).toBe(42);
	});

	it("honors SIGNET_TELEMETRY_OPTOUT as a runtime opt-out", () => {
		// Regression: CI and test daemons boot with default config and the
		// shipped key, so every smoke run became a fake PostHog install.
		expect(telemetryDisabledByEnv({})).toBe(false);
		expect(telemetryDisabledByEnv({ SIGNET_TELEMETRY_OPTOUT: "1" })).toBe(true);
		expect(telemetryDisabledByEnv({ SIGNET_TELEMETRY_OPTOUT: "true" })).toBe(true);
		expect(telemetryDisabledByEnv({ SIGNET_TELEMETRY_OPTOUT: "0" })).toBe(false);
	});

	it("tags development telemetry and marks its reported version", async () => {
		expect(telemetryDeployment({})).toBeUndefined();
		expect(telemetryDeployment({ SIGNET_TELEMETRY_ENV: "DEV" })).toBe("dev");
		expect(telemetryDeployment({ SIGNET_TELEMETRY_ENV: "production" })).toBeUndefined();
		expect(telemetryReportedVersion("0.176.8", "dev")).toBe("0.176.8-dev");
		expect(telemetryReportedVersion("0.176.8-dev", "dev")).toBe("0.176.8-dev");

		const collector = createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.176.8", {
			env: { SIGNET_TELEMETRY_ENV: "dev" },
			telemetryLogPath: logPath,
		});
		collector.record("daemon.started", { version: "0.176.8", platform: process.platform });
		await collector.flush();

		const batch = captured[0]?.body.batch ?? [];
		expect(batch).toHaveLength(2);
		for (const event of batch) {
			expect(event.properties.deployment).toBe("dev");
			expect(event.properties.$lib_version).toBe("0.176.8-dev");
		}
		expect(batch[0]?.properties.version).toBe("0.176.8-dev");
		expect(batch[1]?.properties.version).toBe("0.176.8-dev");

		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		for (const line of lines) {
			expect((JSON.parse(line) as { properties: { deployment: string } }).properties.deployment).toBe("dev");
		}
	});

	it("marks both sides of development upgrade events", async () => {
		const collector = createTelemetryCollector(getDbAccessor(), TELEMETRY_CONFIG, "0.176.8", {
			env: { SIGNET_TELEMETRY_ENV: "dev" },
		});
		collector.record("version.upgraded", { from: "0.176.6", to: "0.176.8" });
		await collector.flush();
		const [event] = collector.query({ event: "version.upgraded" });
		expect(event?.properties.from).toBe("0.176.6-dev");
		expect(event?.properties.to).toBe("0.176.8-dev");
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
		// install.activated (first run) + the freshly recorded heartbeat.
		expect(rows.length).toBe(2);
	});
});

describe("telemetry lifecycle events (issue #1026 Phase 2)", () => {
	it("declares the Phase-2 lifecycle event types", () => {
		for (const event of [
			"daemon.started",
			"daemon.previous_exit",
			"command.invoked",
			"error.occurred",
			"version.upgraded",
		]) {
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
		expect(lines).toHaveLength(3);
		const first = JSON.parse(lines[0]) as { event: string; properties: { version: string } };
		expect(first.event).toBe("install.activated");
		expect(first.properties.version).toBe("0.163.15");
		const second = JSON.parse(lines[1]) as { event: string; properties: { version: string } };
		expect(second.event).toBe("daemon.started");
		expect(second.properties.version).toBe("0.163.15");
		const third = JSON.parse(lines[2]) as { event: string; properties: { command: string } };
		expect(third.event).toBe("command.invoked");
		expect(third.properties.command).toBe("status");
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

describe("session economics (issue #1201)", () => {
	it("aggregates embedding and LLM spend into the matching session end", async () => {
		const collector = makeCollector();
		collector.record("session.start", { sessionHash: "session-1" });
		collector.record("llm.generate", {
			sessionHash: "session-1",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 10,
			cacheCreationTokens: 5,
			totalCost: 0.5,
		});
		collector.record("pipeline.embedding", {
			sessionHash: "session-1",
			tokens: 2_000_000,
			cost: 0.04,
		});
		collector.record("session.end", { sessionHash: "session-1" });
		await collector.flush();

		const end = collector.query({ event: "session.end" })[0];
		expect(end?.properties.tokensInput).toBe(2_000_100);
		expect(end?.properties.tokensOutput).toBe(20);
		expect(end?.properties.tokensCacheRead).toBe(10);
		expect(end?.properties.tokensCacheWrite).toBe(5);
		expect(end?.properties.cost).toBe(0.54);
	});

	it("recovers from a missing session-end key without poisoning later sessions", async () => {
		const collector = makeCollector();
		collector.record("session.start", { sessionHash: "session-a" });
		collector.record("llm.generate", { inputTokens: 100, totalCost: 0.5 });
		collector.record("session.end", {});
		collector.record("session.start", { sessionHash: "session-c" });
		collector.record("llm.generate", { inputTokens: 200, totalCost: 1 });
		collector.record("session.end", { sessionHash: "session-c" });
		await collector.flush();

		const ends = collector.query({ event: "session.end" });
		expect(ends[0]?.properties.tokensInput).toBe(100);
		expect(ends[0]?.properties.cost).toBe(0.5);
		expect(ends[1]?.properties.tokensInput).toBe(200);
		expect(ends[1]?.properties.cost).toBe(1);
	});

	it("reopens the accumulator for a resumed session", async () => {
		const collector = makeCollector();
		collector.record("session.start", { sessionHash: "session-1" });
		collector.record("llm.generate", { inputTokens: 100, totalCost: 0.5 });
		collector.record("session.end", { sessionHash: "session-1" });
		collector.reopenSession("session-1");
		collector.record("llm.generate", { inputTokens: 300, totalCost: 1.5 });
		collector.record("session.end", { sessionHash: "session-1" });
		await collector.flush();

		const ends = collector.query({ event: "session.end" });
		expect(ends[0]?.properties.tokensInput).toBe(100);
		expect(ends[1]?.properties.tokensInput).toBe(300);
		expect(ends[1]?.properties.cost).toBe(1.5);
	});
});

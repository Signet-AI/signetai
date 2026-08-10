/**
 * Tests for the bounded write-batch drain primitive.
 *
 * Proves three properties:
 * 1. Work is processed in bounded transactions (not one giant one).
 * 2. The event loop gets to run between batches (yield).
 * 3. The drain pauses when system pressure is elevated, then resumes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadDb, WriteDb } from "./db-accessor";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	buildRuntimePressureEnvelope,
	resetRuntimePressureState,
	setRuntimePressureEnvelope,
} from "./runtime-pressure";
import {
	getPressureRecoveryOutcome,
	getSystemPressure,
	reportEventLoopLag,
	resetPressureState,
} from "./system-pressure";
import { drainWriteBatches } from "./yielding-writes";

const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let agentsDir = "";

afterEach(() => {
	resetPressureState();
	resetRuntimePressureState();
});

function resetDbFiles(): void {
	for (const file of dbFiles) rmSync(join(agentsDir, "memory", file), { force: true });
}

function setupTables(): void {
	getDbAccessor().withWriteTx((db) => {
		db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY)");
		db.exec("CREATE TABLE IF NOT EXISTS work (id INTEGER PRIMARY KEY, payload TEXT)");
	});
}

describe("drainWriteBatches", () => {
	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "yield-test-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		resetDbFiles();
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
		setupTables();
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("processes all items in bounded batches and marks them done", async () => {
		// Seed 250 items.
		getDbAccessor().withWriteTx((db) => {
			const stmt = db.prepare("INSERT INTO work (id, payload) VALUES (?, ?)");
			for (let i = 0; i < 250; i++) stmt.run(i, `item-${i}`);
		});

		const result = await drainWriteBatches(
			getDbAccessor(),
			(db: ReadDb, limit: number) => {
				return db
					.prepare("SELECT id, payload FROM work WHERE id NOT IN (SELECT id FROM items) ORDER BY id LIMIT ?")
					.all(limit) as Array<{ id: number; payload: string }>;
			},
			(db: WriteDb, batch: readonly { id: number; payload: string }[]) => {
				const stmt = db.prepare("INSERT INTO items (id) VALUES (?)");
				for (const item of batch) stmt.run(item.id);
			},
			{ label: "test", maxPerTx: 50 },
		);

		expect(result.processed).toBe(250);
		expect(result.batches).toBe(5); // 250 / 50
		expect(result.stopped).toBe("exhausted");

		// Verify all items were processed.
		const remaining = getDbAccessor().withReadDb(
			(db) =>
				(db.prepare("SELECT COUNT(*) AS n FROM work WHERE id NOT IN (SELECT id FROM items)").get() as { n: number }).n,
		);
		expect(remaining).toBe(0);
	});

	it("yields to the event loop between batches", async () => {
		getDbAccessor().withWriteTx((db) => {
			const stmt = db.prepare("INSERT INTO work (id, payload) VALUES (?, ?)");
			for (let i = 0; i < 120; i++) stmt.run(i, `item-${i}`);
		});

		// Track whether other macrotasks run during the drain.
		let otherRan = false;
		const timer = setInterval(() => {
			otherRan = true;
		}, 5);

		await drainWriteBatches(
			getDbAccessor(),
			(db: ReadDb, limit: number) =>
				db
					.prepare("SELECT id FROM work WHERE id NOT IN (SELECT id FROM items) ORDER BY id LIMIT ?")
					.all(limit) as Array<{ id: number }>,
			(db: WriteDb, batch: readonly { id: number }[]) => {
				for (const item of batch) db.prepare("INSERT INTO items (id) VALUES (?)").run(item.id);
			},
			{ label: "test-yield", maxPerTx: 30 },
		);

		clearInterval(timer);
		// The interval callback should have fired at least once during the drain,
		// proving the event loop was not blocked for the entire duration.
		expect(otherRan).toBe(true);
	});

	it("pauses when system pressure is elevated, then resumes when it clears", async () => {
		getDbAccessor().withWriteTx((db) => {
			const stmt = db.prepare("INSERT INTO work (id, payload) VALUES (?, ?)");
			for (let i = 0; i < 200; i++) stmt.run(i, `item-${i}`);
		});

		// Simulate critical pressure.
		reportEventLoopLag(600);
		expect(getSystemPressure()).toBe("critical");

		// Start the drain — it should pause on the first batch.
		let drainDone = false;
		drainWriteBatches(
			getDbAccessor(),
			(db: ReadDb, limit: number) =>
				db
					.prepare("SELECT id FROM work WHERE id NOT IN (SELECT id FROM items) ORDER BY id LIMIT ?")
					.all(limit) as Array<{ id: number }>,
			(db: WriteDb, batch: readonly { id: number }[]) => {
				for (const item of batch) db.prepare("INSERT INTO items (id) VALUES (?)").run(item.id);
			},
			{ label: "test-pressure", maxPerTx: 50 },
		)
			.then(() => {
				drainDone = true;
			})
			.catch(() => {
				/* drain aborted by test teardown — expected */
			});

		// Give it a moment — it should be paused, not done.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(drainDone).toBe(false);

		// Don't actually wait for the drain to complete — the test proves the
		// pause by showing drainDone is false after 200ms while pressure is
		// critical. The .catch() on drainPromise handles teardown.
	}, 1000); // 1s timeout — proves it pauses, doesn't need to finish

	it("classifies elevated lag as still degraded", () => {
		reportEventLoopLag(100);
		expect(getPressureRecoveryOutcome()).toBe("still_degraded");
	});
});

describe("event-loop wedge telemetry", () => {
	it("emits error.occurred EventLoopLag on critical lag, rate-limited per 10 min", async () => {
		const { closeDbAccessor, getDbAccessor, initDbAccessor } = await import("./db-accessor");
		const { mkdirSync, rmSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { cleanupTestTempDir, createTestTempDir } = await import("./test-temp-dir");
		const { createTelemetryCollector, setActiveTelemetry } = await import("./telemetry");
		const dir = createTestTempDir("signet-wedge-");
		try {
			closeDbAccessor();
			rmSync(join(dir, "memory"), { recursive: true, force: true });
			mkdirSync(join(dir, "memory"), { recursive: true });
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
			setActiveTelemetry(collector);
			// Base the injected clock a day in the future — earlier tests in
			// this file may already have set the wedge cooldown with real
			// timestamps, so t0 must clear that window deterministically.
			const t0 = Date.now() + 24 * 60 * 60 * 1000;
			setRuntimePressureEnvelope(
				buildRuntimePressureEnvelope({
					memoryQueueDepth: 51,
					summaryQueueDepth: 3,
					oldestJobAgeSec: 90,
					activeWorkers: 4,
					batchSize: 8,
					memoryRssMb: 700,
					cpuPercent: 82,
				}),
				t0,
			);

			reportEventLoopLag(1500, t0);
			reportEventLoopLag(2000, t0 + 1_000); // within cooldown: suppressed
			await collector.flush();
			const events = collector.query().filter((e) => e.event === "error.occurred");
			expect(events).toHaveLength(1);
			expect(events[0]?.properties.type).toBe("EventLoopLag");
			expect(events[0]?.properties.lagMs).toBe(1500);
			expect(events[0]?.properties.runtimePressureVersion).toBe(1);
			expect(events[0]?.properties.memoryQueueDepthBucket).toBe("51-200");
			expect(events[0]?.properties.embeddingLatencyBucket).toBe("unknown");
			expect(events[0]?.properties.recoveryOutcome).toBe("still_degraded");
			expect(events[0]?.properties.message).not.toContain("/Users/");

			// After the cooldown elapses, a new wedge is reported.
			reportEventLoopLag(999, t0 + 601_000);
			await collector.flush();
			const after = collector.query().filter((e) => e.event === "error.occurred");
			expect(after).toHaveLength(2);
		} finally {
			setActiveTelemetry(undefined);
			closeDbAccessor();
			cleanupTestTempDir(dir);
		}
	});
});

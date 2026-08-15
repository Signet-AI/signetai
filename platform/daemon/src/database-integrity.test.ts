import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairTelemetryIndexes, runDeferredIntegrityCheck } from "./database-integrity";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";

function fakeAccessor(options: { readonly quickMessage?: string; readonly telemetryMessage?: string }): {
	readonly accessor: DbAccessor;
	readonly reindexed: string[];
} {
	let repaired = false;
	const reindexed: string[] = [];
	const readDb: ReadDb = {
		prepare(sql: string) {
			return {
				run(): { readonly changes: number } {
					return { changes: 0 };
				},
				get(): undefined {
					return undefined;
				},
				all<Row = unknown>(): Row[] {
					if (sql === "PRAGMA quick_check") return [{ quick_check: options.quickMessage ?? "ok" }] as Row[];
					if (sql === "PRAGMA integrity_check(telemetry_events)") {
						return [{ integrity_check: repaired ? "ok" : (options.telemetryMessage ?? "ok") }] as Row[];
					}
					if (
						sql ===
						"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'telemetry_events' AND sql IS NOT NULL ORDER BY name"
					) {
						return [
							{ name: "idx_telemetry_events_event" },
							{ name: "idx_telemetry_events_queue" },
							{ name: "idx_telemetry_events_timestamp" },
							{ name: "idx_telemetry_events_unsent" },
						] as Row[];
					}
					throw new Error(`unexpected query: ${sql}`);
				},
			};
		},
	};
	const writeDb: WriteDb = {
		exec(sql: string): void {
			repaired = true;
			reindexed.push(sql);
		},
		prepare(_sql: string) {
			return {
				run(): { readonly changes: number } {
					return { changes: 0 };
				},
				get(): undefined {
					return undefined;
				},
				all<Row = unknown>(): Row[] {
					return [] as Row[];
				},
			};
		},
	};
	const accessor: DbAccessor = {
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(readDb);
		},
		withReadDbAsync<T>(fn: (db: ReadDb) => Promise<T>): Promise<T> {
			return fn(readDb);
		},
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			return fn(writeDb);
		},
		withWriteTxAsync<T>(fn: (db: WriteDb) => T): Promise<T> {
			return Promise.resolve(fn(writeDb));
		},
		checkpointWal(): void {},
		incrementalVacuum(): number {
			return 0;
		},
		close(): void {},
	};
	return { accessor, reindexed };
}

afterEach(async () => {
	await repairTelemetryIndexes(fakeAccessor({}).accessor);
});

describe("telemetry database integrity recovery (#1360)", () => {
	it("rebuilds disposable telemetry indexes after quick_check misses the mismatch", async () => {
		const { accessor, reindexed } = fakeAccessor({
			telemetryMessage: "row 111120 missing from index idx_telemetry_events_event",
		});

		const result = await repairTelemetryIndexes(accessor);

		expect(result.state).toBe("repaired");
		expect(result.quickCheck.ok).toBe(true);
		expect(result.telemetryCheck.ok).toBe(true);
		expect(reindexed).toEqual([
			'REINDEX "idx_telemetry_events_event"',
			'REINDEX "idx_telemetry_events_queue"',
			'REINDEX "idx_telemetry_events_timestamp"',
			'REINDEX "idx_telemetry_events_unsent"',
		]);
	});

	it("runs a Node ESM repair child and verifies its committed indexes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-repair-success-"));
		const dbPath = join(dir, "memory.db");
		const database = new Database(dbPath);
		database.exec(
			"CREATE TABLE telemetry_events (event TEXT, queue TEXT, timestamp TEXT, unsent INTEGER); CREATE INDEX idx_telemetry_events_event ON telemetry_events(event); CREATE INDEX idx_telemetry_events_queue ON telemetry_events(queue); CREATE INDEX idx_telemetry_events_timestamp ON telemetry_events(timestamp); CREATE INDEX idx_telemetry_events_unsent ON telemetry_events(unsent)",
		);
		database.close();
		const { accessor } = fakeAccessor({ telemetryMessage: "index mismatch" });

		const result = await repairTelemetryIndexes(
			accessor,
			(db) => {
				db.exec("INSERT INTO repair_audit VALUES (1)");
			},
			{
				dbPath,
				repairTimeoutMs: 5_000,
				repairRuntimePath: "node",
			},
		);

		expect(result.state).toBe("repaired");
		expect(result.rebuiltIndexes).toHaveLength(4);
		const verification = new Database(dbPath);
		expect(verification.prepare("PRAGMA integrity_check(telemetry_events)").all()).toEqual([{ integrity_check: "ok" }]);
		verification.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("audits the repair inside the write transaction", async () => {
		const { accessor } = fakeAccessor({ telemetryMessage: "index mismatch" });
		let auditedIndexes: readonly string[] = [];
		let detectionMessages: readonly string[] = [];

		const result = await repairTelemetryIndexes(accessor, (_db, indexes, messages) => {
			auditedIndexes = indexes;
			detectionMessages = messages;
		});

		expect(result.state).toBe("repaired");
		expect(auditedIndexes).toEqual([
			"idx_telemetry_events_event",
			"idx_telemetry_events_queue",
			"idx_telemetry_events_timestamp",
			"idx_telemetry_events_unsent",
		]);
		expect(detectionMessages).toEqual(["index mismatch"]);
	});

	it("fails closed when the repair audit cannot be written", async () => {
		const { accessor } = fakeAccessor({ telemetryMessage: "index mismatch" });

		const result = await repairTelemetryIndexes(accessor, () => {
			throw new Error("memory_history unavailable");
		});

		expect(result.state).toBe("corrupt");
		expect(result.rebuiltIndexes).toEqual([]);
		expect(result.telemetryCheck.messages).toContain("memory_history unavailable");
	});

	it("does not start a production repair child when the audit fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-repair-audit-failure-"));
		const dbPath = join(dir, "memory.db");
		const markerPath = join(dir, "child-started");
		const workerPath = join(dir, "marker-worker.mjs");
		const database = new Database(dbPath);
		database.exec(
			"CREATE TABLE telemetry_events (event TEXT); CREATE INDEX idx_telemetry_events_event ON telemetry_events(event)",
		);
		database.close();
		writeFileSync(
			workerPath,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "started");\n`,
		);

		const result = await repairTelemetryIndexes(
			fakeAccessor({ telemetryMessage: "index mismatch" }).accessor,
			() => {
				throw new Error("audit unavailable");
			},
			{ dbPath, repairWorkerPath: workerPath, repairRuntimePath: "node", repairTimeoutMs: 5_000 },
		);

		expect(result.state).toBe("corrupt");
		expect(result.telemetryCheck.messages).toContain("audit unavailable");
		expect(existsSync(markerPath)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("does not rewrite an unrelated database when quick_check fails", async () => {
		const { accessor, reindexed } = fakeAccessor({
			quickMessage: "database disk image is malformed",
			telemetryMessage: "row 111120 missing from index idx_telemetry_events_event",
		});

		const result = await repairTelemetryIndexes(accessor);

		expect(result.state).toBe("corrupt");
		expect(result.quickCheck.ok).toBe(false);
		expect(reindexed).toEqual([]);
	});
});

describe("deferred database integrity recovery (#1513)", () => {
	it("keeps confirmed corruption fail-closed after the worker reports it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-corrupt-"));
		const workerPath = join(dir, "corrupt-worker.mjs");
		writeFileSync(
			workerPath,
			'process.stdout.write(JSON.stringify({ type: "result", result: { quickCheck: { ok: false, messages: ["database disk image is malformed"] } } }) + "\\n");\n',
		);

		const result = await runDeferredIntegrityCheck(fakeAccessor({}).accessor, "/tmp/not-used.db", {
			workerPath,
			timeoutMs: 1000,
		});

		expect(result.state).toBe("corrupt");
		expect(result.phase).toBe("complete");
		expect(result.quickCheck.messages).toEqual(["database disk image is malformed"]);
		expect(result.repairGuidance).toContain("back up the database");
	});

	it("uses the bounded worker for a healthy SQLite database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-healthy-"));
		const dbPath = join(dir, "memory.db");
		const database = new Database(dbPath);
		database.exec("CREATE TABLE check_me (value TEXT)");
		database.close();

		const result = await runDeferredIntegrityCheck(fakeAccessor({}).accessor, dbPath, { timeoutMs: 5000 });

		expect(result.state).toBe("healthy");
		expect(result.phase).toBe("complete");
		expect(result.quickCheck.ok).toBe(true);
	});

	it("handles worker construction failures as unavailable", async () => {
		const result = await runDeferredIntegrityCheck(fakeAccessor({}).accessor, "/tmp/not-used.db", {
			workerPath: "/tmp/missing-database-integrity-worker.mjs",
			timeoutMs: 1000,
		});

		expect(result.state).toBe("unavailable");
		expect(result.phase).toBe("complete");
		expect(result.repairGuidance).toContain("back up the database");
	});

	it("kills a synchronous scan at the deadline on a large fixture", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-large-"));
		const dbPath = join(dir, "memory.db");
		const workerPath = join(dir, "blocking-worker.mjs");
		const database = new Database(dbPath);
		database.exec("CREATE TABLE large_fixture (value TEXT)");
		database.exec(
			"WITH RECURSIVE numbers(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 250000) INSERT INTO large_fixture SELECT printf('fixture-%06d', value) FROM numbers",
		);
		database.close();
		writeFileSync(
			workerPath,
			[
				'import { Database } from "bun:sqlite";',
				"const dbPath = process.env.SIGNET_DATABASE_INTEGRITY_DB_PATH;",
				'if (dbPath === undefined) throw new Error("missing database path");',
				'process.stdout.write("started\\n");',
				"const database = new Database(dbPath, { readonly: true });",
				'while (true) database.prepare("PRAGMA quick_check").all();',
			].join("\n"),
		);

		const startedAt = Date.now();
		let scanStarted = false;
		const result = await runDeferredIntegrityCheck(fakeAccessor({}).accessor, dbPath, {
			workerPath,
			timeoutMs: 25,
			onWorkerStarted: () => {
				scanStarted = true;
			},
		});

		expect(scanStarted).toBe(true);
		expect(result.phase).toBe("timed_out");
		expect(Date.now() - startedAt).toBeLessThan(500);
		rmSync(dir, { recursive: true, force: true });
	});

	it("bounds a worker that does not complete and returns actionable guidance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-timeout-"));
		const workerPath = join(dir, "slow-worker.mjs");
		writeFileSync(workerPath, "setTimeout(() => {}, 1000);\n");
		const result = await runDeferredIntegrityCheck(fakeAccessor({}).accessor, "/tmp/not-used.db", {
			workerPath,
			timeoutMs: 10,
		});

		expect(result.state).toBe("unavailable");
		expect(result.phase).toBe("timed_out");
		expect(result.repairGuidance).toContain("back up the database");
	});

	it("kills a telemetry repair child at its deadline without corrupting the database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "integrity-repair-timeout-"));
		const dbPath = join(dir, "memory.db");
		const workerPath = join(dir, "blocking-repair-worker.mjs");
		const database = new Database(dbPath);
		database.exec("CREATE TABLE repair_fixture (value TEXT)");
		database.close();
		writeFileSync(workerPath, 'process.stdout.write("started\\n"); setTimeout(() => {}, 1000);\n');

		const result = await repairTelemetryIndexes(
			fakeAccessor({ telemetryMessage: "index mismatch" }).accessor,
			undefined,
			{
				dbPath,
				repairWorkerPath: workerPath,
				repairTimeoutMs: 25,
			},
		);

		expect(result.state).toBe("unavailable");
		expect(result.phase).toBe("timed_out");
		const verified = new Database(dbPath, { readonly: true });
		expect(verified.prepare("SELECT COUNT(*) AS n FROM repair_fixture").get()).toEqual({ n: 0 });
		verified.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

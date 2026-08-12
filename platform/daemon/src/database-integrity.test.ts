import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
	const accessor: DbAccessor = {
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn({
				prepare(sql: string) {
					return {
						run(): { readonly changes: number } {
							return { changes: 0 };
						},
						get(): undefined {
							return undefined;
						},
						all(): unknown[] {
							if (sql === "PRAGMA quick_check") {
								return [{ quick_check: options.quickMessage ?? "ok" }];
							}
							if (sql === "PRAGMA integrity_check(telemetry_events)") {
								return [{ integrity_check: repaired ? "ok" : (options.telemetryMessage ?? "ok") }];
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
								];
							}
							throw new Error(`unexpected query: ${sql}`);
						},
					};
				},
			} as ReadDb);
		},
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			return fn({
				exec(sql: string): void {
					repaired = true;
					reindexed.push(sql);
				},
				prepare() {
					return {
						run(): { readonly changes: number } {
							return { changes: 0 };
						},
						get(): undefined {
							return undefined;
						},
						all(): unknown[] {
							return [];
						},
					};
				},
			} as WriteDb);
		},
		close(): void {},
	};
	return { accessor, reindexed };
}

afterEach(() => {
	repairTelemetryIndexes(fakeAccessor({}).accessor);
});

describe("telemetry database integrity recovery (#1360)", () => {
	it("rebuilds disposable telemetry indexes after quick_check misses the mismatch", () => {
		const { accessor, reindexed } = fakeAccessor({
			telemetryMessage: "row 111120 missing from index idx_telemetry_events_event",
		});

		const result = repairTelemetryIndexes(accessor);

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

	it("audits the repair inside the write transaction", () => {
		const { accessor } = fakeAccessor({ telemetryMessage: "index mismatch" });
		let auditedIndexes: readonly string[] = [];
		let detectionMessages: readonly string[] = [];

		const result = repairTelemetryIndexes(accessor, (_db, indexes, messages) => {
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

	it("fails closed when the repair audit cannot be written", () => {
		const { accessor } = fakeAccessor({ telemetryMessage: "index mismatch" });

		const result = repairTelemetryIndexes(accessor, () => {
			throw new Error("memory_history unavailable");
		});

		expect(result.state).toBe("corrupt");
		expect(result.rebuiltIndexes).toEqual([]);
		expect(result.telemetryCheck.messages).toContain("memory_history unavailable");
	});

	it("does not rewrite an unrelated database when quick_check fails", () => {
		const { accessor, reindexed } = fakeAccessor({
			quickMessage: "database disk image is malformed",
			telemetryMessage: "row 111120 missing from index idx_telemetry_events_event",
		});

		const result = repairTelemetryIndexes(accessor);

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
			'import { parentPort } from "node:worker_threads"; parentPort.postMessage({ type: "result", result: { quickCheck: { ok: false, messages: ["database disk image is malformed"] } } });\n',
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
});

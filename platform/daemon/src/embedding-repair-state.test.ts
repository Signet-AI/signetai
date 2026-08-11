import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { listStaleEmbeddingRows } from "./embedding-coverage";
import {
	acquireEmbeddingRepairLease,
	finishEmbeddingRepairLease,
	loadEmbeddingRepairFailures,
	readEmbeddingRepairState,
} from "./embedding-repair-state";

function asAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		withReadDb<T>(fn: (rdb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close(): void {
			db.close();
		},
	};
}

describe("embedding repair state", () => {
	it("consumes a durable budget slot before work so restart recovery cannot replay unlimited batches", () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");

		const first = acquireEmbeddingRepairLease(accessor, 60_000, 2, now);
		expect(first.allowed).toBe(true);
		// A second worker cannot claim the active batch.
		expect(acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 1_000)).toMatchObject({
			allowed: false,
			reason: "embedding repair already in progress",
		});

		// A restart remains blocked for the full hourly accounting window. Once
		// it expires, a fresh process can begin the next hourly window.
		expect(acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 30 * 60_000)).toMatchObject({
			allowed: false,
			reason: "embedding repair already in progress",
		});
		const resumed = acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 60 * 60_000 + 1);
		expect(resumed.allowed).toBe(true);
		expect(acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 60 * 60_000 + 2)).toMatchObject({
			allowed: false,
			reason: "embedding repair already in progress",
		});
		expect(readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 1 });
		db.close();
	});

	it("resets a corrupted future budget window instead of extending its quota", () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const initialLease = acquireEmbeddingRepairLease(accessor, 0, 5, now).lease;
		if (initialLease === undefined) throw new Error("expected initial lease");
		finishEmbeddingRepairLease(
			accessor,
			initialLease,
			{ successful: [], failed: [], model: "test-model", pollMs: 1_000 },
			now,
		);
		db.prepare("UPDATE embedding_repair_budget SET window_started_at = ?, batches_started = 5 WHERE id = 1").run(
			new Date(now + 30 * 60_000).toISOString(),
		);

		const admission = acquireEmbeddingRepairLease(accessor, 0, 5, now + 1);
		expect(admission.allowed).toBe(true);
		expect(readEmbeddingRepairState(accessor)).toMatchObject({
			windowStartedAt: new Date(now + 1).toISOString(),
			batchesStarted: 1,
		});
		db.close();
	});

	it("persists provider failure backoff across a restart and clears it only after a committed success", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const key = { id: "memory-1", contentHash: "hash-1" };
		const lease = acquireEmbeddingRepairLease(accessor, 60_000, 5, now).lease;
		expect(lease).toBeDefined();
		if (lease === undefined) throw new Error("expected repair lease");

		finishEmbeddingRepairLease(
			accessor,
			lease,
			{ successful: [], failed: [key], model: "test-model", pollMs: 1_000 },
			now + 1,
		);
		const persisted = loadEmbeddingRepairFailures(accessor, [key], "test-model");
		expect(persisted.get("memory-1:hash-1:test-model")).toMatchObject({ attempts: 1, retryAt: now + 60_001 });

		const resumedLease = acquireEmbeddingRepairLease(accessor, 60_000, 5, now + 60_001).lease;
		expect(resumedLease).toBeDefined();
		if (resumedLease === undefined) throw new Error("expected resumed lease");
		finishEmbeddingRepairLease(
			accessor,
			resumedLease,
			{ successful: [key], failed: [], model: "test-model", pollMs: 1_000 },
			now + 60_002,
		);
		const remaining = loadEmbeddingRepairFailures(accessor, [key], "test-model");
		expect(remaining).toEqual(new Map());
		db.close();
	});

	it("skips a persisted-backoff row so it cannot starve newer eligible repair work", () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const older = new Date(now - 1_000).toISOString();
		const newer = new Date(now).toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("eligible", "eligible", "hash-eligible", older, older);
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run("deferred", "deferred", "hash-deferred", newer, newer);

		const lease = acquireEmbeddingRepairLease(accessor, 60_000, 5, now).lease;
		if (lease === undefined) throw new Error("expected repair lease");
		finishEmbeddingRepairLease(
			accessor,
			lease,
			{
				successful: [],
				failed: [{ id: "deferred", contentHash: "hash-deferred" }],
				model: "test-model",
				pollMs: 1_000,
			},
			now + 1,
		);

		const selected = accessor.withReadDb((db) =>
			listStaleEmbeddingRows(db, "test-model", 1, new Date(now + 2).toISOString()),
		);
		expect(selected.map((row) => row.id)).toEqual(["eligible"]);
		db.close();
	});
});

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { listStaleEmbeddingRows } from "./embedding-coverage";
import {
	beginEmbeddingIndexBuild,
	ensureEmbeddingIndexState,
	isActiveEmbeddingConfig,
	resolveActiveEmbeddingConfig,
} from "./embedding-index-state";
import {
	acquireEmbeddingRepairLease,
	finishEmbeddingRepairLease,
	loadEmbeddingRepairFailures,
	readEmbeddingRepairState,
} from "./embedding-repair-state";
import type { EmbeddingConfig } from "./memory-config";

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
	it("holds a durable lease before work and charges its slot only after an eligible completion", () => {
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
		// it expires, a fresh process can begin the next hourly window without
		// charging the crashed work as a completed repair.
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
		expect(readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 0 });
		if (resumed.lease === undefined) throw new Error("expected resumed lease");
		expect(
			finishEmbeddingRepairLease(
				accessor,
				resumed.lease,
				{
					successful: [{ id: "memory-1", contentHash: "hash-1" }],
					failed: [],
					model: "test-model",
					pollMs: 1_000,
					eligibility: true,
				},
				now + 60 * 60_000 + 2,
			),
		).toBe(true);
		expect(readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 1, lastAffected: 1 });
		db.close();
	});

	it("does not charge durable budget when pressure aborts a batch before any embedding persists", () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const failedKey = { id: "memory-1", contentHash: "hash-1" };
		const lease = acquireEmbeddingRepairLease(accessor, 0, 1, now).lease;
		if (lease === undefined) throw new Error("expected repair lease");

		expect(
			finishEmbeddingRepairLease(
				accessor,
				lease,
				{
					successful: [],
					failed: [failedKey],
					model: "test-model",
					pollMs: 1_000,
					eligibility: true,
					error: "system pressure became high before embedding persistence",
				},
				now + 1,
			),
		).toBe(true);
		expect(readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 0, lastAffected: 0 });
		expect(loadEmbeddingRepairFailures(accessor, [failedKey], "test-model")).toHaveLength(1);
		expect(acquireEmbeddingRepairLease(accessor, 0, 1, now + 2).allowed).toBe(true);
		db.close();
	});

	it("removes backoff rows after a memory is deleted or receives a new content hash", () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const original = { id: "memory-1", contentHash: "hash-1" };
		const replacement = { id: "memory-1", contentHash: "hash-2" };
		db.prepare(
			`INSERT INTO memories (id, content, content_hash, type, created_at, updated_at, updated_by)
			 VALUES (?, ?, ?, 'fact', ?, ?, 'test')`,
		).run(original.id, "original", original.contentHash, new Date(now).toISOString(), new Date(now).toISOString());

		const firstLease = acquireEmbeddingRepairLease(accessor, 0, 5, now).lease;
		if (firstLease === undefined) throw new Error("expected first repair lease");
		finishEmbeddingRepairLease(
			accessor,
			firstLease,
			{ successful: [], failed: [original], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 1,
		);
		expect(loadEmbeddingRepairFailures(accessor, [original], "test-model")).toHaveLength(1);

		db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?").run(replacement.contentHash, replacement.id);
		expect(loadEmbeddingRepairFailures(accessor, [original], "test-model")).toHaveLength(0);

		const secondLease = acquireEmbeddingRepairLease(accessor, 0, 5, now + 2).lease;
		if (secondLease === undefined) throw new Error("expected second repair lease");
		finishEmbeddingRepairLease(
			accessor,
			secondLease,
			{ successful: [], failed: [replacement], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 3,
		);
		expect(loadEmbeddingRepairFailures(accessor, [replacement], "test-model")).toHaveLength(1);

		db.prepare("DELETE FROM memories WHERE id = ?").run(replacement.id);
		expect(loadEmbeddingRepairFailures(accessor, [replacement], "test-model")).toHaveLength(0);
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
			{
				successful: [{ id: "memory-1", contentHash: "hash-1" }],
				failed: [],
				model: "test-model",
				pollMs: 1_000,
				eligibility: true,
			},
			now,
		);
		db.prepare("UPDATE embedding_repair_budget SET window_started_at = ?, batches_started = 5 WHERE id = 1").run(
			new Date(now + 30 * 60_000).toISOString(),
		);

		const admission = acquireEmbeddingRepairLease(accessor, 0, 5, now + 1);
		expect(admission.allowed).toBe(true);
		if (admission.lease === undefined) throw new Error("expected repaired-window lease");
		finishEmbeddingRepairLease(
			accessor,
			admission.lease,
			{
				successful: [{ id: "memory-1", contentHash: "hash-1" }],
				failed: [],
				model: "test-model",
				pollMs: 1_000,
				eligibility: true,
			},
			now + 1,
		);
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
			{ successful: [], failed: [key], model: "test-model", pollMs: 1_000, eligibility: true },
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
			{ successful: [key], failed: [], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 60_002,
		);
		const remaining = loadEmbeddingRepairFailures(accessor, [key], "test-model");
		expect(remaining).toEqual(new Map());
		db.close();
	});

	it("does not let ten superseded-profile batches consume the promoted profile's ten-slot budget", () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const oldConfig: EmbeddingConfig = {
			provider: "ollama",
			model: "custom-old",
			dimensions: 3,
			base_url: "http://127.0.0.1:11434",
		};
		const promotedConfig: EmbeddingConfig = { ...oldConfig, model: "custom-new" };
		accessor.withWriteTx((db) => {
			ensureEmbeddingIndexState(db, oldConfig);
			beginEmbeddingIndexBuild(db, promotedConfig);
			db.prepare(
				"UPDATE embedding_index_state SET active_profile_json = staging_profile_json, staging_profile_json = NULL, state = 'ready' WHERE id = 1",
			).run();
		});
		const activeConfig = accessor.withReadDb((db) => resolveActiveEmbeddingConfig(db, promotedConfig));
		const key = { id: "old-memory", contentHash: "old-hash" };

		for (let index = 0; index < 10; index++) {
			const at = now + index;
			const lease = acquireEmbeddingRepairLease(accessor, 0, 10, at).lease;
			if (lease === undefined) throw new Error("expected superseded-profile lease");
			expect(
				finishEmbeddingRepairLease(
					accessor,
					lease,
					{
						successful: [],
						failed: [key],
						model: oldConfig.model,
						pollMs: 1_000,
						eligibility: (db) => isActiveEmbeddingConfig(db, oldConfig),
					},
					at,
				),
			).toBe(false);
		}
		expect(readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 0 });
		expect(db.prepare("SELECT COUNT(*) AS n FROM embedding_repair_backoff").get() as { n: number }).toEqual({ n: 0 });

		for (let index = 0; index < 10; index++) {
			const at = now + 100 + index;
			const lease = acquireEmbeddingRepairLease(accessor, 0, 10, at).lease;
			if (lease === undefined) throw new Error("expected promoted-profile lease");
			expect(
				finishEmbeddingRepairLease(
					accessor,
					lease,
					{
						successful: [key],
						failed: [],
						model: activeConfig.model,
						pollMs: 1_000,
						eligibility: (db) => isActiveEmbeddingConfig(db, activeConfig),
					},
					at,
				),
			).toBe(true);
		}
		expect(readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 10 });
		expect(acquireEmbeddingRepairLease(accessor, 0, 10, now + 200)).toMatchObject({
			allowed: false,
			reason: "embedding repair hourly budget exhausted (10 batches/hr)",
		});
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
				eligibility: true,
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

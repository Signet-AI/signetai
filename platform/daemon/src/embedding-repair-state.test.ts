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
		async withWriteTxAsync<T>(fn: (wdb: WriteDb) => T): Promise<T> {
			return this.withWriteTx(fn);
		},
		async withReadDbAsync<T>(fn: (rdb: ReadDb) => T | Promise<T>): Promise<T> {
			return await fn(db as unknown as ReadDb);
		},
		close(): void {
			db.close();
		},
	};
}

describe("embedding repair state", () => {
	it("holds a durable lease before work and charges its slot only after an eligible completion", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");

		const first = await acquireEmbeddingRepairLease(accessor, 60_000, 2, now);
		expect(first.allowed).toBe(true);
		// A second worker cannot claim the active batch.
		expect(await acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 1_000)).toMatchObject({
			allowed: false,
			reason: "embedding repair already in progress",
		});

		// A restart remains blocked for the full hourly accounting window. Once
		// it expires, a fresh process can begin the next hourly window without
		// charging the crashed work as a completed repair.
		expect(await acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 30 * 60_000)).toMatchObject({
			allowed: false,
			reason: "embedding repair already in progress",
		});
		const resumed = await acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 60 * 60_000 + 1);
		expect(resumed.allowed).toBe(true);
		expect(await acquireEmbeddingRepairLease(accessor, 60_000, 2, now + 60 * 60_000 + 2)).toMatchObject({
			allowed: false,
			reason: "embedding repair already in progress",
		});
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 0 });
		if (resumed.lease === undefined) throw new Error("expected resumed lease");
		await expect(
			await finishEmbeddingRepairLease(
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
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 1, lastAffected: 1 });
		db.close();
	});

	it("does not charge durable budget when pressure aborts a batch before any embedding persists", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const failedKey = { id: "memory-1", contentHash: "hash-1" };
		const lease = (await acquireEmbeddingRepairLease(accessor, 0, 1, now)).lease;
		if (lease === undefined) throw new Error("expected repair lease");

		expect(
			await finishEmbeddingRepairLease(
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
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 0, lastAffected: 0 });
		expect(await loadEmbeddingRepairFailures(accessor, [failedKey], "test-model")).toHaveLength(1);
		expect((await acquireEmbeddingRepairLease(accessor, 0, 1, now + 2)).allowed).toBe(true);
		db.close();
	});

	it("releases its lease when finish accounting fails", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const lease = (await acquireEmbeddingRepairLease(accessor, 0, 5, now)).lease;
		if (lease === undefined) throw new Error("expected repair lease");
		let failOnce = true;
		const flakyAccessor: DbAccessor = {
			...accessor,
			withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
				if (failOnce) {
					failOnce = false;
					throw new Error("simulated finish failure");
				}
				return accessor.withWriteTx(fn);
			},
			async withWriteTxAsync<T>(fn: (wdb: WriteDb) => T): Promise<T> {
				if (failOnce) {
					failOnce = false;
					throw new Error("simulated finish failure");
				}
				return await accessor.withWriteTxAsync(fn);
			},
		};

		expect(
			finishEmbeddingRepairLease(
				flakyAccessor,
				lease,
				{ successful: [], failed: [], model: "test-model", pollMs: 1_000, eligibility: true },
				now + 1,
			),
		).rejects.toThrow("simulated finish failure");
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({
			leaseExpiresAt: null,
			lastError: "simulated finish failure",
		});
		expect((await acquireEmbeddingRepairLease(accessor, 0, 5, now + 2)).allowed).toBe(true);
		db.close();
	});

	it("removes backoff rows after a memory is deleted or receives a new content hash", async () => {
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

		const firstLease = (await acquireEmbeddingRepairLease(accessor, 0, 5, now)).lease;
		if (firstLease === undefined) throw new Error("expected first repair lease");
		await finishEmbeddingRepairLease(
			accessor,
			firstLease,
			{ successful: [], failed: [original], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 1,
		);
		expect(await loadEmbeddingRepairFailures(accessor, [original], "test-model")).toHaveLength(1);

		db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?").run(replacement.contentHash, replacement.id);
		expect(await loadEmbeddingRepairFailures(accessor, [original], "test-model")).toHaveLength(0);

		const secondLease = (await acquireEmbeddingRepairLease(accessor, 0, 5, now + 2)).lease;
		if (secondLease === undefined) throw new Error("expected second repair lease");
		await finishEmbeddingRepairLease(
			accessor,
			secondLease,
			{ successful: [], failed: [replacement], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 3,
		);
		expect(await loadEmbeddingRepairFailures(accessor, [replacement], "test-model")).toHaveLength(1);

		db.prepare("DELETE FROM memories WHERE id = ?").run(replacement.id);
		expect(await loadEmbeddingRepairFailures(accessor, [replacement], "test-model")).toHaveLength(0);
		db.close();
	});

	it("resets a corrupted future budget window instead of extending its quota", async () => {
		const db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		const accessor = asAccessor(db);
		const now = Date.parse("2026-08-11T12:00:00.000Z");
		const initialLease = (await acquireEmbeddingRepairLease(accessor, 0, 5, now)).lease;
		if (initialLease === undefined) throw new Error("expected initial lease");
		await finishEmbeddingRepairLease(
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

		const admission = await acquireEmbeddingRepairLease(accessor, 0, 5, now + 1);
		expect(admission.allowed).toBe(true);
		if (admission.lease === undefined) throw new Error("expected repaired-window lease");
		await finishEmbeddingRepairLease(
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
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({
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
		const lease = (await acquireEmbeddingRepairLease(accessor, 60_000, 5, now)).lease;
		expect(lease).toBeDefined();
		if (lease === undefined) throw new Error("expected repair lease");

		await finishEmbeddingRepairLease(
			accessor,
			lease,
			{ successful: [], failed: [key], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 1,
		);
		const persisted = await loadEmbeddingRepairFailures(accessor, [key], "test-model");
		expect(persisted.get("memory-1:hash-1:test-model")).toMatchObject({ attempts: 1, retryAt: now + 60_001 });

		const resumedLease = (await acquireEmbeddingRepairLease(accessor, 60_000, 5, now + 60_001)).lease;
		expect(resumedLease).toBeDefined();
		if (resumedLease === undefined) throw new Error("expected resumed lease");
		await finishEmbeddingRepairLease(
			accessor,
			resumedLease,
			{ successful: [key], failed: [], model: "test-model", pollMs: 1_000, eligibility: true },
			now + 60_002,
		);
		const remaining = await loadEmbeddingRepairFailures(accessor, [key], "test-model");
		expect(remaining).toEqual(new Map());
		db.close();
	});

	it("does not let ten superseded-profile batches consume the promoted profile's ten-slot budget", async () => {
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
			const lease = (await acquireEmbeddingRepairLease(accessor, 0, 10, at)).lease;
			if (lease === undefined) throw new Error("expected superseded-profile lease");
			expect(
				await finishEmbeddingRepairLease(
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
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 0 });
		expect(db.prepare("SELECT COUNT(*) AS n FROM embedding_repair_backoff").get() as { n: number }).toEqual({ n: 0 });

		for (let index = 0; index < 10; index++) {
			const at = now + 100 + index;
			const lease = (await acquireEmbeddingRepairLease(accessor, 0, 10, at)).lease;
			if (lease === undefined) throw new Error("expected promoted-profile lease");
			expect(
				await finishEmbeddingRepairLease(
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
		expect(await readEmbeddingRepairState(accessor)).toMatchObject({ batchesStarted: 10 });
		expect(await acquireEmbeddingRepairLease(accessor, 0, 10, now + 200)).toMatchObject({
			allowed: false,
			reason: "embedding repair hourly budget exhausted (10 batches/hr)",
		});
		db.close();
	});

	it("skips a persisted-backoff row so it cannot starve newer eligible repair work", async () => {
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

		const lease = (await acquireEmbeddingRepairLease(accessor, 60_000, 5, now)).lease;
		if (lease === undefined) throw new Error("expected repair lease");
		await finishEmbeddingRepairLease(
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

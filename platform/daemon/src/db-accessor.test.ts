/**
 * Tests for the DB accessor (singleton read/write transaction wrapper).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFtsIndexIncomplete } from "./fts-index-state";
import {
	getEventLoopLiveness,
	recordEventLoopHeartbeat,
	establishEventLoopHeartbeatBaseline,
	resetDbObservability,
} from "./db-observability";
import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import {
	DbSpacePreflightError,
	DbReadAdmissionCancelledError,
	DbReadAdmissionRejectedError,
	DbWriteQueueFullError,
	MAX_READ_CONNECTIONS,
	MAX_WRITE_QUEUE,
	backupBeforeMigration,
	closeDbAccessor,
	getDbAccessor,
	initDbAccessor,
	readVecEmbeddingDimensions,
	resolveCustomSqlitePath,
	resolveSqliteAgentsDir,
	resolveSqliteRuntimeConfig,
	vecEmbeddingsSchemaNeedsRepair,
} from "./db-accessor";

function tmpDbPath(): string {
	const dir = join(tmpdir(), `signet-accessor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "test.db");
}

describe("DbAccessor", () => {
	const cleanupDirs: string[] = [];

	afterEach(() => {
		closeDbAccessor();
		for (const dir of cleanupDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		cleanupDirs.length = 0;
	});

	test("initializes without error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));

		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		expect(acc).toBeTruthy();
		expect(readdirSync(join(dbPath, "..")).filter((name) => name.includes(".bak-v"))).toEqual([]);
	});

	test("keeps large deferred FTS backfills off the initialization path", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		closeDbAccessor();

		const db = new Database(dbPath);
		const insert = db.prepare(
			`INSERT INTO memories (
				id, content, type, agent_id, visibility, created_at, updated_at, updated_by
			) VALUES (?, ?, 'fact', 'default', 'global', datetime('now'), datetime('now'), 'test')`,
		);
		for (let index = 0; index < 10_000; index += 1) {
			insert.run(`large-fts-memory-${index}`, `large deferred FTS corpus memory ${index}`);
		}
		db.exec("DROP TRIGGER memories_ai");
		db.exec("DROP TRIGGER memories_ad");
		db.exec("DROP TRIGGER memories_au");
		db.exec("DROP TABLE memories_fts");
		db.close();

		const started = performance.now();
		initDbAccessor(dbPath);
		const elapsedMs = performance.now() - started;
		const indexed = getDbAccessor().withReadDb(
			(readDb) =>
				(readDb.prepare("SELECT COUNT(*) AS count FROM memories_fts_docsize").get() as { count: number }).count,
		);

		expect(indexed).toBe(0);
		expect(elapsedMs).toBeLessThan(2_000);
	});

	test("does not cache FTS completeness when a previously complete index is emptied", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, agent_id, visibility, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', 'default', 'global', datetime('now'), datetime('now'), 'test')`,
			).run("empty-index-memory", "memory for the empty-index restart regression");
			db.exec(
				"UPDATE memories_fts_state SET memory_count = (SELECT COUNT(*) FROM memories), indexed_count = (SELECT COUNT(*) FROM memories_fts_docsize)",
			);
		});
		closeDbAccessor();

		const db = new Database(dbPath);
		db.exec("DELETE FROM memories_fts");
		db.close();

		initDbAccessor(dbPath);
		expect(isFtsIndexIncomplete()).toBe(true);
	});
	test("retains the pre-migration backup when migration fails", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));

		initDbAccessor(dbPath);
		closeDbAccessor();

		const db = new Database(dbPath);
		try {
			db.exec("DELETE FROM schema_migrations WHERE version = 128");
			db.exec("DROP INDEX IF EXISTS idx_memory_jobs_diagnostics_status_created_at");
			db.exec("DROP INDEX IF EXISTS idx_memory_jobs_diagnostics_error_updated_at");
			db.exec("ALTER TABLE memory_jobs RENAME TO memory_jobs_original");
			db.exec("CREATE TABLE memory_jobs (id TEXT PRIMARY KEY)");
			db.exec("DROP TABLE memory_jobs_original");
		} finally {
			db.close();
		}

		expect(() => initDbAccessor(dbPath)).toThrow();

		const backupNames = readdirSync(join(dbPath, "..")).filter((name) => name.includes(".bak-v"));
		expect(backupNames).toHaveLength(1);
		expect(statSync(join(dbPath, "..", backupNames[0])).size).toBe(statSync(dbPath).size);
	});

	test("withWriteTx provides working write access", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY, val TEXT)");
			db.prepare("INSERT INTO test_table (id, val) VALUES (?, ?)").run(1, "hello");
		});

		const result = acc.withReadDb((db) => {
			return db.prepare("SELECT val FROM test_table WHERE id = ?").get(1) as Record<string, unknown> | undefined;
		});
		expect(result).toBeTruthy();
		expect(result?.val).toBe("hello");
	});

	test("attributes a wedged parent sync call with its file and line", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		const realNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		try {
			resetDbObservability();
			establishEventLoopHeartbeatBaseline(1_000, 2_000);
			getDbAccessor().withWriteTx((db) => {
				// Keep this synchronous on purpose: this is the parent-isolate wedge seam.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				now = 5_000;
				db.prepare("SELECT 1").get();
			});

			recordEventLoopHeartbeat(5_000, 2_000);
			const liveness = getEventLoopLiveness(5_000);
			expect(liveness.status).toBe("wedged");
			expect(liveness.syncDbCallSites.some((site) => site.includes("db-accessor.test.ts:"))).toBe(true);
		} finally {
			Date.now = realNow;
		}
	});

	test("attributes an in-flight async-named read callback at latch time", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		const realNow = Date.now;
		let now = 1_000;
		const state: { latched: ReturnType<typeof getEventLoopLiveness> | null } = { latched: null };
		Date.now = () => now;
		try {
			resetDbObservability();
			establishEventLoopHeartbeatBaseline(1_000, 2_000);
			await getDbAccessor().withReadDbAsync(
				(db) => {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
					now = 5_000;
					recordEventLoopHeartbeat(5_000, 2_000);
					state.latched = getEventLoopLiveness(5_000);
					db.prepare("SELECT 1").get();
				},
				{ siteToken: "db-accessor.test.ts:190" },
			);
		} finally {
			Date.now = realNow;
		}

		if (state.latched === null) throw new Error("in-flight latch did not produce liveness data");
		expect(state.latched.status).toBe("wedged");
		expect(state.latched.syncDbCallSites).toContain("withReadDbAsync@platform/daemon/src/db-accessor.test.ts:190");
	});

	test("attributes an in-flight parent sync call at latch time", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		const realNow = Date.now;
		let now = 1_000;
		const state: { latched: ReturnType<typeof getEventLoopLiveness> | null } = { latched: null };
		Date.now = () => now;
		try {
			resetDbObservability();
			establishEventLoopHeartbeatBaseline(1_000, 2_000);
			getSyncDbAccessor().withWriteTx((db) => {
				// Hold the real accessor call in flight while the latch inspects it.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				now = 5_000;
				recordEventLoopHeartbeat(5_000, 2_000);
				state.latched = getEventLoopLiveness(5_000);
				db.prepare("SELECT 1").get();
			}, "db-accessor.test.ts:201");
		} finally {
			Date.now = realNow;
		}

		if (state.latched === null) throw new Error("in-flight latch did not produce liveness data");
		expect(state.latched.status).toBe("wedged");
		expect(state.latched.syncDbCallSites).toContain("withWriteTx@platform/daemon/src/db-accessor.test.ts:201");
	});

	test("attributes an in-flight queued async write callback at latch time", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		const realNow = Date.now;
		let now = 1_000;
		const state: { latched: ReturnType<typeof getEventLoopLiveness> | null } = { latched: null };
		Date.now = () => now;
		try {
			resetDbObservability();
			establishEventLoopHeartbeatBaseline(1_000, 2_000);
			await getDbAccessor().withWriteTxAsync(
				(db) => {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
					now = 5_000;
					recordEventLoopHeartbeat(5_000, 2_000);
					state.latched = getEventLoopLiveness(5_000);
					db.prepare("SELECT 1").get();
				},
				{ siteToken: "db-accessor.test.ts:222" },
			);
		} finally {
			Date.now = realNow;
		}

		if (state.latched === null) throw new Error("in-flight latch did not produce liveness data");
		expect(state.latched.status).toBe("wedged");
		expect(state.latched.syncDbCallSites).toContain("withWriteTxAsync@platform/daemon/src/db-accessor.test.ts:222");
	});

	test("write statements expose the number of affected rows", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		const changes = getDbAccessor().withWriteTx((db) => {
			db.exec("CREATE TABLE write_result_test (id INTEGER PRIMARY KEY, val TEXT)");
			return db.prepare("INSERT INTO write_result_test (id, val) VALUES (?, ?)").run(1, "written").changes;
		});

		expect(changes).toBe(1);
	});

	test("withReadDb provides working read access", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE read_test (id INTEGER PRIMARY KEY, name TEXT)");
			db.prepare("INSERT INTO read_test (id, name) VALUES (?, ?)").run(1, "alice");
			db.prepare("INSERT INTO read_test (id, name) VALUES (?, ?)").run(2, "bob");
		});

		const rows = acc.withReadDb((db) => {
			return db.prepare("SELECT name FROM read_test ORDER BY id").all() as Array<Record<string, unknown>>;
		});
		expect(rows).toHaveLength(2);
		expect(rows[0].name).toBe("alice");
		expect(rows[1].name).toBe("bob");
	});

	test("write transaction rolls back on error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE rollback_test (id INTEGER PRIMARY KEY, val TEXT)");
			db.prepare("INSERT INTO rollback_test (id, val) VALUES (?, ?)").run(1, "original");
		});

		try {
			acc.withWriteTx((db) => {
				db.prepare("INSERT INTO rollback_test (id, val) VALUES (?, ?)").run(2, "should-rollback");
				throw new Error("intentional failure");
			});
		} catch {
			// expected
		}

		const rows = acc.withReadDb((db) => {
			return db.prepare("SELECT id FROM rollback_test ORDER BY id").all() as Array<Record<string, unknown>>;
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(1);
	});

	test("async writes are admitted in order and yield between transactions", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		const enqueue = acc.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE async_write_test (id INTEGER PRIMARY KEY)");
		});

		const writes = Array.from({ length: 4 }, (_, id) =>
			enqueue((db) => {
				db.prepare("INSERT INTO async_write_test (id) VALUES (?)").run(id);
				return id;
			}),
		);
		expect(acc.getWritePressure?.().queued).toBe(4);
		expect(await Promise.all(writes)).toEqual([0, 1, 2, 3]);
		expect(acc.getWritePressure?.().queued).toBe(0);
		expect(acc.getWritePressure?.().lastDurationMs).toBeNumber();

		const count = acc.withReadDb(
			(db) => (db.prepare("SELECT COUNT(*) AS n FROM async_write_test").get() as { n: number }).n,
		);
		expect(count).toBe(4);
	});

	test("async maintenance writes use the bounded writer queue", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		const checkpoint = acc.checkpointWalAsync;
		const vacuum = acc.incrementalVacuumAsync;
		if (!checkpoint || !vacuum) throw new Error("async maintenance API is unavailable");

		await checkpoint();
		expect(await vacuum()).toBeNumber();
		expect(acc.getWritePressure?.().lastDurationMs).toBeNumber();
	});

	test("async write admission rejects work beyond the bounded queue", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		const enqueue = acc.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");

		const pending = Array.from({ length: MAX_WRITE_QUEUE }, () => enqueue(() => undefined));
		const rejected = enqueue(() => undefined);
		await expect(rejected).rejects.toBeInstanceOf(DbWriteQueueFullError);
		await Promise.all(pending);
	});

	test("releases the read lease before an async callback continuation", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		let callbackStarted = () => undefined;
		const started = new Promise<void>((resolve) => {
			callbackStarted = resolve;
		});
		let continueCallback = () => undefined;
		const continuation = new Promise<void>((resolve) => {
			continueCallback = resolve;
		});

		const pending = acc.withReadDbAsync(
			async (db) => {
				db.prepare("SELECT 1").get();
				callbackStarted();
				await continuation;
				return true;
			},
			{ operation: "test.async-release" },
		);

		await started;
		expect(acc.getReadPressure?.().activeLeases).toBe(0);
		continueCallback();
		await expect(pending).resolves.toBe(true);
	});

	test("read admission rejects pre-cancelled requests without acquiring a lease", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		const controller = new AbortController();
		controller.abort();

		await expect(
			acc.withReadDbAsync(() => undefined, {
				signal: controller.signal,
				operation: "test.cancel",
			}),
		).rejects.toBeInstanceOf(DbReadAdmissionCancelledError);
		expect(acc.getReadPressure?.().cancelled).toBe(1);
	});

	test("synchronous legacy reads expose structured admission rejection at the cap", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		const sync = acc as unknown as {
			withReadDb<T>(fn: (db: import("./db-accessor").ReadDb) => T): T;
		};
		const acquireNestedReads = (remaining: number): void => {
			if (remaining === 0) return;
			sync.withReadDb(() => acquireNestedReads(remaining - 1));
		};

		expect(() => sync.withReadDb(() => acquireNestedReads(MAX_READ_CONNECTIONS))).toThrow(DbReadAdmissionRejectedError);
		expect(acc.getReadPressure?.()).toMatchObject({ rejected: 1, syncRejected: 1, activeLeases: 0 });
	});

	test("close rejects queued async writes", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();
		const enqueue = acc.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");

		const pending = enqueue(() => undefined);
		closeDbAccessor();
		await expect(pending).rejects.toThrow("DbAccessor is closed");
	});

	test("close works without error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		// Should not throw
		closeDbAccessor();
	});

	test("prunes old migration backups before copying a new one", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");

		const files = new Map<string, number>([
			["test.db.bak-v58-1000", 1000],
			["test.db.bak-v59-2000", 2000],
			["test.db.bak-v60-3000", 3000],
			["test.db.bak-v61-4000", 4000],
			["test.db.bak-v62-5000", 5000],
		]);
		const operations: string[] = [];

		backupBeforeMigration({ exec: () => {} }, dbPath, 62, {
			copyFileSync: (source, dest) => {
				operations.push(`copy:${source}->${dest}`);
				expect(operations).toContain("unlink:test.db.bak-v58-1000");
				files.set(String(dest).slice(dbDir.length + 1), 6000);
			},
			readdirSync: () => Array.from(files.keys()),
			statSync: (path) => ({ mtimeMs: files.get(String(path).slice(dbDir.length + 1)) ?? 0 }),
			unlinkSync: (path) => {
				const name = String(path).slice(dbDir.length + 1);
				operations.push(`unlink:${name}`);
				files.delete(name);
			},
			now: () => 6000,
			log: () => {},
		});

		expect(operations[0]).toBe("unlink:test.db.bak-v61-4000");
		expect(Array.from(files.keys()).sort()).toEqual(["test.db.bak-v62-6000"]);
		expect(files.size).toBe(1);
	});

	test("blocks a migration backup before deleting retained backups when headroom is insufficient", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");

		const files = new Map<string, { readonly mtimeMs: number; readonly size: number }>([
			["test.db.bak-v62-5000", { mtimeMs: 5000, size: 8 }],
		]);
		const operations: string[] = [];

		expect(() =>
			backupBeforeMigration({ exec: () => {} }, dbPath, 63, {
				copyFileSync: () => {
					operations.push("copy");
				},
				readdirSync: () => Array.from(files.keys()),
				statSync: (path) => {
					const name = String(path).slice(dbDir.length + 1);
					return files.get(name) ?? { mtimeMs: 0, size: 8 };
				},
				statfsSync: () => ({ bavail: 4, bsize: 1 }),
				unlinkSync: (path) => {
					operations.push(`unlink:${String(path).slice(dbDir.length + 1)}`);
				},
				now: () => 6000,
				log: () => {},
			}),
		).toThrow(DbSpacePreflightError);
		expect(operations).toEqual([]);
		expect(Array.from(files.keys())).toEqual(["test.db.bak-v62-5000"]);
	});

	test("allows a small writable migration backup when statfs reports zero free bytes", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");

		const files = new Map<string, number>();
		const operations: string[] = [];

		backupBeforeMigration({ exec: () => {} }, dbPath, 64, {
			copyFileSync: (source, destination) => {
				const name = String(destination).slice(dbDir.length + 1);
				operations.push(`copy:${String(source).slice(dbDir.length + 1)}->${name}`);
				files.set(name, 1);
			},
			readdirSync: () => Array.from(files.keys()),
			statSync: (path) => ({ mtimeMs: files.get(String(path).slice(dbDir.length + 1)) ?? 0, size: 8 }),
			statfsSync: () => ({ bavail: 0, bsize: 0 }),
			unlinkSync: (path) => {
				const name = String(path).slice(dbDir.length + 1);
				operations.push(`unlink:${name}`);
				files.delete(name);
			},
			now: () => 6000,
			log: () => {},
		});

		expect(operations).toEqual([
			"copy:test.db->test.db.space-probe-6000",
			"unlink:test.db.space-probe-6000",
			"copy:test.db->test.db.bak-v64-6000",
		]);
		expect(files.has("test.db.bak-v64-6000")).toBe(true);
	});

	test("uses the write probe when statfs returns a degenerate block size", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");
		const operations: string[] = [];

		backupBeforeMigration({ exec: () => {} }, dbPath, 65, {
			copyFileSync: (_source, destination) => {
				operations.push(String(destination).includes("space-probe") ? "probe" : "backup");
			},
			readdirSync: () => [],
			statSync: () => ({ mtimeMs: 0, size: 1024 * 1024 + 1 }),
			statfsSync: () => ({ bavail: 244199454, bsize: 0 }),
			unlinkSync: () => {
				operations.push("unlink");
			},
			now: () => 7000,
			log: () => {},
		});
		expect(operations).toEqual(["probe", "unlink", "backup"]);
	});

	test("does not fabricate free space when the degenerate write probe fails", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");

		let error: DbSpacePreflightError | undefined;
		try {
			backupBeforeMigration({ exec: () => {} }, dbPath, 65, {
				copyFileSync: () => {
					throw new Error("probe failed");
				},
				readdirSync: () => [],
				statSync: () => ({ mtimeMs: 0, size: 1024 }),
				statfsSync: () => ({ bavail: 1, bsize: 0 }),
				unlinkSync: () => {},
				now: () => 7000,
				log: () => {},
			});
		} catch (err) {
			error = err as DbSpacePreflightError;
		}
		expect(error).toBeInstanceOf(DbSpacePreflightError);
		if (!error) throw new Error("expected DbSpacePreflightError");
		expect((error.metrics as unknown as { freeBytes: number | null }).freeBytes).toBeNull();
	});

	test("still blocks a genuinely verified-full migration backup", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");
		const operations: string[] = [];

		expect(() =>
			backupBeforeMigration({ exec: () => {} }, dbPath, 66, {
				copyFileSync: () => operations.push("copy"),
				readdirSync: () => [],
				statSync: () => ({ mtimeMs: 0, size: 1024 * 1024 + 1 }),
				statfsSync: () => ({ bavail: 0, bsize: 4096 }),
				unlinkSync: () => operations.push("unlink"),
				now: () => 7000,
				log: () => {},
			}),
		).toThrow(DbSpacePreflightError);
		expect(operations).toEqual([]);
	});

	test("ignores migration backups removed during metadata collection", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");

		const files = new Map<string, number>([
			["test.db.bak-v60-3000", 3000],
			["test.db.bak-v61-4000", 4000],
			["test.db.bak-v62-5000", 5000],
		]);
		const missing = Object.assign(new Error("ENOENT: no such file or directory, stat"), { code: "ENOENT" });

		backupBeforeMigration({ exec: () => {} }, dbPath, 63, {
			copyFileSync: (_source, dest) => {
				files.set(String(dest).slice(dbDir.length + 1), 6000);
			},
			readdirSync: () => ["test.db.bak-v59-2000", ...Array.from(files.keys())],
			statSync: (path) => {
				const name = String(path).slice(dbDir.length + 1);
				const mtime = files.get(name);
				if (mtime === undefined) throw missing;
				return { mtimeMs: mtime };
			},
			unlinkSync: (path) => {
				files.delete(String(path).slice(dbDir.length + 1));
			},
			now: () => 6000,
			log: () => {},
		});

		expect(files.has("test.db.bak-v63-6000")).toBe(true);
	});

	test("cleans partial migration backup when copy fails", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		const files = new Map<string, number>();
		const operations: string[] = [];

		expect(() =>
			backupBeforeMigration({ exec: () => {} }, dbPath, 65, {
				copyFileSync: (_source, dest) => {
					const name = String(dest).slice(dbDir.length + 1);
					files.set(name, 1);
					throw new Error("ENOSPC: no space left on device, copyfile");
				},
				readdirSync: () => Array.from(files.keys()),
				statSync: (path) => ({ mtimeMs: files.get(String(path).slice(dbDir.length + 1)) ?? 0 }),
				unlinkSync: (path) => {
					const name = String(path).slice(dbDir.length + 1);
					operations.push(`unlink:${name}`);
					files.delete(name);
				},
				now: () => 7000,
				log: () => {},
			}),
		).toThrow(/Free disk space and retry/);

		expect(operations).toContain("unlink:test.db.bak-v65-7000");
		expect(files.has("test.db.bak-v65-7000")).toBe(false);
	});
});

describe("resolveCustomSqlitePath", () => {
	test("defaults workspace discovery to the home-scoped agents dir when SIGNET_PATH is unset", () => {
		const dir = resolveSqliteAgentsDir({
			env: {},
			home: () => "/tmp/home",
		});

		expect(dir).toBe("/tmp/home/.agents");
	});

	test("uses persisted workspace config when SIGNET_PATH is unset", () => {
		const root = join(tmpdir(), `signet-workspace-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cfgDir = join(root, "xdg", "signet");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(
			join(cfgDir, "workspace.json"),
			JSON.stringify({
				version: 1,
				workspace: "/tmp/custom-workspace",
				updatedAt: new Date().toISOString(),
			}),
		);

		try {
			const dir = resolveSqliteAgentsDir({
				env: { XDG_CONFIG_HOME: join(root, "xdg") },
				home: () => "/tmp/home",
			});

			expect(dir).toBe("/tmp/custom-workspace");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("prefers explicit SIGNET_SQLITE_PATH on macOS", () => {
		const found = new Set([
			"/tmp/custom/libsqlite3.dylib",
			"/tmp/agents/libsqlite3.dylib",
			"/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
		]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: { SIGNET_SQLITE_PATH: "/tmp/custom/libsqlite3.dylib" },
			exists: (path) => found.has(path),
		});

		expect(result).toEqual({
			path: "/tmp/custom/libsqlite3.dylib",
			source: "env",
		});
	});

	test("does not fall back when explicit SIGNET_SQLITE_PATH is missing", () => {
		const found = new Set(["/tmp/agents/libsqlite3.dylib", "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: { SIGNET_SQLITE_PATH: "/tmp/missing/libsqlite3.dylib" },
			exists: (path) => found.has(path),
		});

		expect(result).toBeNull();
	});

	test("falls back to workspace sqlite dylib before Homebrew", () => {
		const found = new Set(["/tmp/agents/libsqlite3.dylib", "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: {},
			exists: (path) => found.has(path),
		});

		expect(result).toEqual({
			path: "/tmp/agents/libsqlite3.dylib",
			source: "workspace",
		});
	});

	test("falls back to Homebrew sqlite on macOS", () => {
		const found = new Set(["/usr/local/opt/sqlite/lib/libsqlite3.dylib"]);
		const result = resolveCustomSqlitePath({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: {},
			exists: (path) => found.has(path),
		});

		expect(result).toEqual({
			path: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
			source: "homebrew",
		});
	});

	test("returns null outside macOS", () => {
		const result = resolveCustomSqlitePath({
			platform: "linux",
			agentsDir: "/tmp/agents",
			env: { SIGNET_SQLITE_PATH: "/tmp/custom/libsqlite3.dylib" },
			exists: () => true,
		});

		expect(result).toBeNull();
	});

	test("falls back to Homebrew when workspace sqlite exists but fails activation", () => {
		const found = new Set(["/tmp/agents/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"]);
		const calls: string[] = [];
		const cfg = resolveSqliteRuntimeConfig({
			platform: "darwin",
			agentsDir: "/tmp/agents",
			env: {},
			exists: (path) => found.has(path),
			set: (path) => {
				calls.push(path);
				if (path === "/tmp/agents/libsqlite3.dylib") {
					throw new Error("wrong architecture");
				}
			},
		});

		expect(calls).toEqual(["/tmp/agents/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"]);
		expect(cfg).toEqual({
			choice: {
				path: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
				source: "homebrew",
			},
			attempt: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
			warning: null,
		});
	});

	test("uses the explicit agentsDir passed to init-time sqlite resolution", () => {
		const found = new Set(["/tmp/explicit/libsqlite3.dylib"]);
		const cfg = resolveSqliteRuntimeConfig({
			platform: "darwin",
			agentsDir: "/tmp/explicit",
			env: { SIGNET_PATH: "/tmp/env-workspace" },
			exists: (path) => found.has(path),
			set: () => {},
		});

		expect(cfg).toEqual({
			choice: {
				path: "/tmp/explicit/libsqlite3.dylib",
				source: "workspace",
			},
			attempt: "/tmp/explicit/libsqlite3.dylib",
			warning: null,
		});
	});
});

describe("sqlite runtime ordering", () => {
	test("keeps bun sqlite construction centralized in db-accessor", async () => {
		const hits: string[] = [];

		for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: import.meta.dir })) {
			if (file.endsWith(".test.ts") || file.endsWith(".bench.ts")) continue;
			if (file.startsWith("__tests__/")) continue;

			const text = readFileSync(join(import.meta.dir, file), "utf8");
			if (text.includes("new Database(")) {
				hits.push(file);
			}
		}

		expect(hits).toEqual([
			"db-owner-worker.ts",
			"database-integrity-worker.ts",
			"db-accessor.ts",
			"database-integrity.ts",
		]);
	});
});

describe("vec_embeddings schema repair", () => {
	const currentSql = `CREATE VIRTUAL TABLE vec_embeddings USING vec0(
		id TEXT PRIMARY KEY,
		embedding FLOAT[1536] distance_metric=cosine
	)`;

	test("reads vec0 embedding dimensions from the virtual table SQL", () => {
		expect(readVecEmbeddingDimensions(currentSql)).toBe(1536);
		expect(
			readVecEmbeddingDimensions("CREATE VIRTUAL TABLE vec_embeddings USING vec0(id TEXT PRIMARY KEY)"),
		).toBeNull();
	});

	test("repairs stale vector dimensions instead of keeping a wrong FLOAT size", () => {
		expect(vecEmbeddingsSchemaNeedsRepair(currentSql, 1536)).toBe(false);
		expect(vecEmbeddingsSchemaNeedsRepair(currentSql.replace("FLOAT[1536]", "FLOAT[768]"), 1536)).toBe(true);
		expect(vecEmbeddingsSchemaNeedsRepair(currentSql.replace("id TEXT PRIMARY KEY,", ""), 1536)).toBe(true);
	});
});

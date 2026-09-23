/**
 * Tests for the DB accessor (singleton read/write transaction wrapper).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
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
	MigrationBackupAdmissionError,
	DbReadAdmissionCancelledError,
	DbReadAdmissionRejectedError,
	DbWriteQueueFullError,
	MAX_READ_CONNECTIONS,
	MAX_WRITE_QUEUE,
	MIGRATION_BACKUP_CHUNK_BYTES,
	backupBeforeMigration,
	backupBeforeMigrationAsync,
	copyMigrationBackupChunks,
	closeDbAccessor,
	getDbAccessor,
	hasPendingMigrationBackup,
	initDbAccessor,
	initDbAccessorAsync,
	pruneMigrationBackupsAfterIntegrity,
	readVecEmbeddingDimensions,
	resolveCustomSqlitePath,
	resolveSqliteAgentsDir,
	resolveSqliteRuntimeConfig,
	runWriteTxAsync,
	vecEmbeddingsSchemaNeedsRepair,
	isGeneratedMigrationBackupName,
	backfillVecEmbeddings,
	VEC_EMBEDDING_POST_READY_BUDGET_MS,
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
		expect(
			readdirSync(join(dbPath, "..")).filter((name) => name.includes(".bak-v") && !name.endsWith(".cursor.json")),
		).toHaveLength(1);
	});

	test("initializes a multi-chunk pending-migration database without inline global verification", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));

		initDbAccessor(dbPath);
		closeDbAccessor();
		for (const name of readdirSync(join(dbPath, ".."))) {
			if (name.startsWith("test.db.bak-v") && !name.endsWith(".cursor.json")) rmSync(join(dbPath, "..", name));
		}
		const fixture = new Database(dbPath);
		fixture.exec("CREATE TABLE migration_large_fixture (payload BLOB NOT NULL)");
		fixture
			.prepare("INSERT INTO migration_large_fixture (payload) VALUES (zeroblob(?))")
			.run(3 * MIGRATION_BACKUP_CHUNK_BYTES + 1);
		fixture.exec("DELETE FROM schema_migrations WHERE version = 128");
		fixture.close();
		const sourceSizeBeforeInit = statSync(dbPath).size;

		const owner = createDbOwnerClient({ dbPath });
		const started = performance.now();
		try {
			await owner.start();
			await owner.initialize(join(dbPath, ".."));
		} finally {
			await owner.close();
		}
		expect(performance.now() - started).toBeLessThan(45_000);

		const backupsAfterInit = readdirSync(join(dbPath, ".."))
			.filter((name) => name.startsWith("test.db.bak-v") && !name.endsWith(".cursor.json"))
			.sort();
		expect(backupsAfterInit).toHaveLength(1);
		const backupPath = join(dbPath, "..", backupsAfterInit[0]);
		const backupStat = statSync(backupPath);
		expect(backupStat.size).toBe(sourceSizeBeforeInit);
		const cursor = JSON.parse(readFileSync(`${backupPath}.cursor.json`, "utf8")) as { offset: number };
		expect(cursor.offset).toBe(sourceSizeBeforeInit);

		closeDbAccessor();
		const backupBeforeRestart = statSync(backupPath);
		await initDbAccessorAsync(dbPath, { deadlineAt: Date.now() + 60_000 });
		expect(statSync(backupPath)).toMatchObject({
			size: backupBeforeRestart.size,
			mtimeMs: backupBeforeRestart.mtimeMs,
		});
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
	test("defers migration when a retained rollback backup is unverified", () => {
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

		expect(() => initDbAccessor(dbPath)).not.toThrow();

		const backupNames = readdirSync(join(dbPath, "..")).filter(
			(name) => name.includes(".bak-v") && !name.endsWith(".cursor.json"),
		);
		expect(backupNames).toHaveLength(1);
		expect(existsSync(join(dbPath, "..", backupNames[0]))).toBe(true);
	});

	test("defers migration when a matching rollback cursor is still at byte zero", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));

		initDbAccessor(dbPath);
		closeDbAccessor();
		const initialBackup = readdirSync(join(dbPath, "..")).find(
			(name) => name.includes(".bak-v") && !name.endsWith(".cursor.json"),
		);
		if (!initialBackup) throw new Error("initial migration backup was not created");

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

		const backupPath = join(dbPath, "..", initialBackup);
		const source = statSync(dbPath);
		writeFileSync(backupPath, Buffer.alloc(0));
		writeFileSync(
			`${backupPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.size,
				sourceMtimeMs: source.mtimeMs,
				destination: backupPath,
				offset: 0,
			}),
		);

		const result = await initDbAccessorAsync(dbPath);
		expect(result.deferredMigrationVerification).toBe(true);
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

	test("withWriteDbAsync admits autocommit writes without a nested transaction", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		await acc.withWriteTxAsync((db) => {
			db.exec("CREATE TABLE autocommit_test (id TEXT PRIMARY KEY)");
		});

		await acc.withWriteDbAsync(
			(db) => {
				db.exec("BEGIN");
				db.prepare("INSERT INTO autocommit_test (id) VALUES (?)").run("autocommit");
				db.exec("COMMIT");
			},
			{ operation: "test.vec-backfill-autocommit" },
		);

		const result = await acc.withReadDbAsync(
			(db) =>
				db.prepare("SELECT COUNT(*) AS count FROM autocommit_test WHERE id = ?").get("autocommit") as { count: number },
		);
		expect(result.count).toBe(1);
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

	test("attributes the actual caller through runWriteTxAsync", async () => {
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
			await runWriteTxAsync(getDbAccessor(), (db) => {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				now = 5_000;
				recordEventLoopHeartbeat(5_000, 2_000);
				state.latched = getEventLoopLiveness(5_000);
				db.prepare("SELECT 1").get();
			});
		} finally {
			Date.now = realNow;
		}

		if (state.latched === null) throw new Error("in-flight latch did not produce liveness data");
		expect(state.latched.status).toBe("wedged");
		expect(state.latched.syncDbCallSites).toContain("withWriteTxAsync@platform/daemon/src/db-accessor.test.ts:432");
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

	test("preserves cursorless legacy migration backups during pruning", () => {
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

		// Cursorless generated-name backups are legacy rollback points and remain
		// protected until their own verification pass classifies them.
		expect(operations).toEqual([operations[0]]);
		expect(Array.from(files.keys()).sort()).toEqual([
			"test.db.bak-v58-1000",
			"test.db.bak-v59-2000",
			"test.db.bak-v60-3000",
			"test.db.bak-v61-4000",
			"test.db.bak-v62-5000",
			"test.db.bak-v62-6000",
		]);
		expect(files.size).toBe(6);
	});

	test("excludes non-regular migration backups from integrity pruning", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");
		const regularBackupPath = `${dbPath}.bak-v90-1000`;
		const directoryBackupPath = `${dbPath}.bak-v91-2000`;
		const operatorBackupPath = `${dbPath}.bak-vmanual`;
		writeFileSync(regularBackupPath, "backup");
		mkdirSync(directoryBackupPath);
		writeFileSync(operatorBackupPath, "operator backup");

		pruneMigrationBackupsAfterIntegrity(dbPath);

		expect(existsSync(regularBackupPath)).toBe(true);
		expect(existsSync(directoryBackupPath)).toBe(true);
		expect(existsSync(operatorBackupPath)).toBe(true);
	});

	test("protects a cursorless legacy backup until its verification pass", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");
		const legacyBackupPath = `${dbPath}.bak-v89-1000`;
		writeFileSync(legacyBackupPath, "legacy rollback");

		pruneMigrationBackupsAfterIntegrity(dbPath);
		expect(existsSync(legacyBackupPath)).toBe(true);

		pruneMigrationBackupsAfterIntegrity(dbPath, undefined, legacyBackupPath);
		expect(existsSync(legacyBackupPath)).toBe(false);
	});

	test("shares the exact generated backup-name predicate", () => {
		expect(isGeneratedMigrationBackupName("memories.db", "memories.db.bak-v151-1234")).toBe(true);
		expect(isGeneratedMigrationBackupName("memories.db", "memories.db.bak-vmanual")).toBe(false);
		expect(isGeneratedMigrationBackupName("memories.db", "memories.db.bak-v151-1234.cursor.json")).toBe(false);
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
					const name = String(path).slice(dbDir.length + 1);
					files.delete(name);
				},
				now: () => 6000,
				log: () => {},
				readVerificationCheckpoint: () => "complete",
			}),
		).toThrow(DbSpacePreflightError);
		// Admission refusal must preserve the only completed-unverified rollback
		// point; freeing it before a replacement exists would destroy recovery.
		expect(operations).toEqual([]);
		expect(Array.from(files.keys())).toEqual(["test.db.bak-v62-5000"]);
	});

	test("reclaims stale-generation backups before admission", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");

		const staleName = "test.db.bak-v61-4000";
		const stalePath = join(dbDir, staleName);
		writeFileSync(
			`${stalePath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: 7,
				sourceMtimeMs: 100,
				destination: stalePath,
				offset: 7,
			}),
		);
		const files = new Map<string, { readonly mtimeMs: number; readonly size: number }>([
			[staleName, { mtimeMs: 4000, size: 8 }],
		]);
		const operations: string[] = [];
		const requiredBytes = 8 + MIGRATION_BACKUP_CHUNK_BYTES * 2;

		backupBeforeMigration({ exec: () => {} }, dbPath, 62, {
			copyFileSync: (_source, destination) => {
				const name = String(destination).slice(dbDir.length + 1);
				operations.push(`copy:${name}`);
				files.set(name, { mtimeMs: 6000, size: 8 });
			},
			readdirSync: () => Array.from(files.keys()),
			statSync: (path) => {
				const name = String(path).slice(dbDir.length + 1);
				return name === "test.db" ? { mtimeMs: 200, size: 8 } : (files.get(name) ?? { mtimeMs: 0, size: 8 });
			},
			statfsSync: () => ({ bavail: files.has(staleName) ? requiredBytes - 1 : requiredBytes, bsize: 1 }),
			unlinkSync: (path) => {
				const name = String(path).slice(dbDir.length + 1);
				operations.push(`unlink:${name}`);
				files.delete(name);
			},
			now: () => 6000,
			log: () => {},
			readVerificationCheckpoint: () => "complete",
		});

		expect(operations.slice(0, 3)).toEqual([
			`unlink:${staleName}`,
			`unlink:${staleName}.verdict.json`,
			`unlink:${staleName}.cursor.json`,
		]);
		expect(operations[3]).toContain("copy:test.db.bak-v62-6000");
	});

	test("preserves and refuses a stale rollback point with a failed checkpoint", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");
		const staleName = "test.db.bak-v61-4000";
		const stalePath = join(dbDir, staleName);
		writeFileSync(stalePath, "rollback");
		writeFileSync(
			`${stalePath}.cursor.json`,
			JSON.stringify({ sourcePath: dbPath, sourceSize: 7, sourceMtimeMs: 100, destination: stalePath, offset: 7 }),
		);
		const operations: string[] = [];

		expect(() =>
			backupBeforeMigration({ exec: () => {} }, dbPath, 62, {
				copyFileSync: () => operations.push("copy"),
				readdirSync: () => [staleName],
				statSync: (path) => (String(path).endsWith("test.db") ? { mtimeMs: 200, size: 8 } : { mtimeMs: 4000, size: 8 }),
				statfsSync: () => ({ bavail: MIGRATION_BACKUP_CHUNK_BYTES * 4, bsize: 1 }),
				unlinkSync: (path) => operations.push(`unlink:${path}`),
				now: () => 6000,
				log: () => {},
				readVerificationCheckpoint: () => "failed:integrity-unverified",
			}),
		).toThrow(MigrationBackupAdmissionError);
		expect(operations).toEqual([]);
		expect(existsSync(stalePath)).toBe(true);
		expect(existsSync(`${stalePath}.cursor.json`)).toBe(true);
	});

	test("reclaims stale migration probes before the free-space admission check", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");
		const staleName = "test.db.bak-v62-5000.probe-1";
		const currentName = `test.db.bak-v62-5000.probe-${process.pid}`;
		const files = new Set([staleName, currentName]);
		const operations: string[] = [];

		backupBeforeMigration({ exec: () => {} }, dbPath, 63, {
			copyFileSync: (_source, destination) => {
				operations.push(`copy:${String(destination).slice(dbDir.length + 1)}`);
			},
			readdirSync: () => [...files],
			statSync: (path) => ({
				mtimeMs: 1,
				size: String(path).endsWith("test.db") ? 8 : 0,
			}),
			statfsSync: () => ({ bavail: 200_000_000, bsize: 1 }),
			unlinkSync: (path) => {
				const name = String(path).slice(dbDir.length + 1);
				operations.push(`unlink:${name}`);
				files.delete(name);
			},
			now: () => 6000,
			log: () => {},
		});

		expect(operations).toContain(`unlink:${staleName}`);
		expect(operations).not.toContain(`unlink:${currentName}`);
	});
	test("proceeds when statfs reports zero-sized blocks", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");

		const files = new Map<string, number>();
		const operations: string[] = [];

		const backupPath = backupBeforeMigration({ exec: () => {} }, dbPath, 64, {
			copyFileSync: (_source, destination) => {
				operations.push("copy");
				files.set(String(destination).slice(dbDir.length + 1), 1);
			},
			readdirSync: () => Array.from(files.keys()),
			statSync: (path) => ({ mtimeMs: files.get(String(path).slice(dbDir.length + 1)) ?? 0, size: 8 }),
			statfsSync: () => ({ bavail: 0, bsize: 0 }),
			unlinkSync: (path) => {
				operations.push("unlink");
				files.delete(String(path).slice(dbDir.length + 1));
			},
			now: () => 6000,
			log: () => {},
		});
		expect(backupPath).toBe(`${dbPath}.bak-v64-6000`);
		expect(operations).toEqual(["copy"]);
		expect(files.has("test.db.bak-v64-6000")).toBe(true);
	});

	test("proceeds when statfs returns a degenerate block size", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");
		const operations: string[] = [];

		const backupPath = backupBeforeMigration({ exec: () => {} }, dbPath, 65, {
			copyFileSync: () => {
				operations.push("copy");
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
		expect(backupPath).toBe(`${dbPath}.bak-v65-7000`);
		expect(operations).toEqual(["copy"]);
	});

	test("proceeds with a warning when statfs free space is unknown", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const dbDir = join(dbPath, "..");
		writeFileSync(dbPath, "database");
		const files = new Map<string, number>();
		const warnings: string[] = [];

		const backupPath = backupBeforeMigration({ exec: () => {} }, dbPath, 65, {
			copyFileSync: (_source, destination) => {
				files.set(String(destination).slice(dbDir.length + 1), 1);
			},
			readdirSync: () => Array.from(files.keys()),
			statSync: (path) => ({ mtimeMs: 0, size: files.get(String(path).slice(dbDir.length + 1)) ?? 8 }),
			statfsSync: () => ({ bavail: 0, bsize: 0 }),
			unlinkSync: (path) => {
				files.delete(String(path).slice(dbDir.length + 1));
			},
			now: () => 7000,
			log: (message) => warnings.push(message),
		});

		expect(backupPath).toBe(`${dbPath}.bak-v65-7000`);
		expect(files.has("test.db.bak-v65-7000")).toBe(true);
		expect(warnings.some((message) => message.includes("free space is unknown"))).toBe(true);
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
	test("creates streamed migration backups with the source file mode", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "secured database contents");
		chmodSync(dbPath, 0o600);

		const backupPath = await backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 72);

		expect(statSync(backupPath).mode & 0o7777).toBe(0o600);
	});
	test("uses the absolute admission window when copy outlasts the remaining budget", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, Buffer.alloc(MIGRATION_BACKUP_CHUNK_BYTES + 1));
		const realNow = Date.now;
		const baseNow = realNow();
		let fakeNow = baseNow;
		let nowCalls = 0;
		Date.now = () => {
			nowCalls += 1;
			return nowCalls >= 4 ? baseNow + 60_000 : fakeNow;
		};
		try {
			await expect(
				backupBeforeMigrationAsync(
					{
						exec: () => {
							fakeNow = baseNow + 54_000;
						},
					},
					dbPath,
					73,
					undefined,
					baseNow + 60_000,
				),
			).rejects.toMatchObject({
				name: "MigrationBackupAdmissionError",
				reason: "throughput",
			});
		} finally {
			Date.now = realNow;
		}
	});
	test("retains the cursor when the final chunk crosses the absolute deadline", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("slow final chunk fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const backupPath = `${dbPath}.bak-v74-9000`;
		const realNow = Date.now;
		const baseNow = realNow();
		let fakeNow = baseNow;
		Date.now = () => fakeNow;
		try {
			await expect(
				copyMigrationBackupChunks(
					dbPath,
					backupPath,
					source.length,
					sourceStat.mtimeMs,
					sourceStat.mode & 0o7777,
					0,
					baseNow + 6_000,
					async (buffer, length) => {
						buffer.fill(1, 0, length);
						fakeNow = baseNow + 6_001;
						return { bytesRead: length };
					},
				),
			).rejects.toMatchObject({
				name: "MigrationBackupAdmissionError",
				reason: "throughput",
			});
			const cursor = JSON.parse(readFileSync(`${backupPath}.cursor.json`, "utf8")) as { offset: number };
			expect(cursor.offset).toBe(source.length);
			expect(existsSync(`${backupPath}.cursor.json`)).toBe(true);
		} finally {
			Date.now = realNow;
		}
	});
	test("rejects a final chunk that consumes the migration startup reserve", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("final chunk reserve fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const backupPath = `${dbPath}.bak-v75-9000`;
		const realNow = Date.now;
		const baseNow = realNow();
		let fakeNow = baseNow;
		Date.now = () => fakeNow;
		try {
			await expect(
				copyMigrationBackupChunks(
					dbPath,
					backupPath,
					source.length,
					sourceStat.mtimeMs,
					sourceStat.mode & 0o7777,
					0,
					baseNow + 60_000,
					async (buffer, length) => {
						buffer.fill(2, 0, length);
						fakeNow = baseNow + 57_000;
						return { bytesRead: length };
					},
				),
			).rejects.toMatchObject({
				name: "MigrationBackupAdmissionError",
				reason: "throughput",
			});
			const cursor = JSON.parse(readFileSync(`${backupPath}.cursor.json`, "utf8")) as { offset: number };
			expect(cursor.offset).toBe(source.length);
			expect(statSync(backupPath).size).toBe(source.length);
		} finally {
			Date.now = realNow;
		}
	});

	test("persists a zero-offset cursor before the first migration backup chunk", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "first chunk fixture");
		const sourceStat = statSync(dbPath);
		const backupPath = `${dbPath}.bak-v73-9000`;

		await expect(
			copyMigrationBackupChunks(
				dbPath,
				backupPath,
				sourceStat.size,
				sourceStat.mtimeMs,
				sourceStat.mode & 0o7777,
				0,
				Date.now() + 60_000,
				async () => {
					throw new Error("simulated first-chunk interruption");
				},
			),
		).rejects.toThrow("simulated first-chunk interruption");

		const cursor = JSON.parse(readFileSync(`${backupPath}.cursor.json`, "utf8")) as {
			destination: string;
			offset: number;
		};
		expect(cursor.offset).toBe(0);
		expect(statSync(cursor.destination).size).toBe(0);
	});

	test("rejects a cursor whose destination is shorter than its claimed offset", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("truncated migration backup resume fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const staleBackupPath = `${dbPath}.bak-v75-9000`;
		const offset = 20;
		writeFileSync(staleBackupPath, source.subarray(0, offset - 3));
		writeFileSync(
			`${staleBackupPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: staleBackupPath,
				offset,
			}),
		);

		const backupPath = await backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 76);

		expect(backupPath).not.toBe(staleBackupPath);
		expect(readFileSync(backupPath)).toEqual(source);
		expect(existsSync(staleBackupPath)).toBe(false);
		expect(existsSync(`${staleBackupPath}.cursor.json`)).toBe(false);
	});

	test("rejects a cursor whose offset exceeds the source size", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("migration backup cursor bounds fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const staleBackupPath = `${dbPath}.bak-v74-9000`;
		writeFileSync(staleBackupPath, source);
		writeFileSync(
			`${staleBackupPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: staleBackupPath,
				offset: source.length + 1,
			}),
		);

		const backupPath = await backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 75);

		expect(backupPath).not.toBe(staleBackupPath);
		expect(readFileSync(backupPath)).toEqual(source);
		expect(existsSync(staleBackupPath)).toBe(false);
		expect(existsSync(`${staleBackupPath}.cursor.json`)).toBe(false);
	});

	test("rejects a cursor whose destination is a symlink without truncating its target", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("symlink migration backup resume fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const targetPath = `${dbPath}.target`;
		const symlinkPath = `${dbPath}.bak-v76-9000`;
		writeFileSync(targetPath, Buffer.from("target must remain intact"));
		symlinkSync(targetPath, symlinkPath);
		writeFileSync(
			`${symlinkPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: symlinkPath,
				offset: 8,
			}),
		);

		const backupPath = await backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 77);

		expect(backupPath).not.toBe(symlinkPath);
		expect(readFileSync(backupPath)).toEqual(source);
		expect(readFileSync(targetPath)).toEqual(Buffer.from("target must remain intact"));
		expect(existsSync(symlinkPath)).toBe(false);
	});

	test("rejects a cursor whose destination is a directory without deleting it", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("directory migration backup resume fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const directoryPath = `${dbPath}.bak-v78-9000`;
		mkdirSync(directoryPath);
		writeFileSync(
			`${directoryPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: directoryPath,
				offset: 8,
			}),
		);

		const backupPath = await backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 79);

		expect(backupPath).not.toBe(directoryPath);
		expect(readFileSync(backupPath)).toEqual(source);
		expect(statSync(directoryPath).isDirectory()).toBe(true);
	});

	test("truncates an oversized destination to the durable cursor before resuming", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("oversized migration backup resume fixture with a valid prefix");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const backupPath = `${dbPath}.bak-v77-9000`;
		const offset = 20;
		writeFileSync(backupPath, Buffer.concat([source.subarray(0, offset), Buffer.from("torn suffix")]));
		writeFileSync(
			`${backupPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: backupPath,
				offset,
			}),
		);

		await expect(backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 77)).resolves.toBe(backupPath);
		expect(readFileSync(backupPath)).toEqual(source);
	});

	test("resumes a chunked migration backup from its durable cursor", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("chunked migration backup resume fixture");
		writeFileSync(dbPath, source);
		const sourceStat = statSync(dbPath);
		const backupPath = `${dbPath}.bak-v71-8000`;
		const offset = 12;
		writeFileSync(backupPath, source.subarray(0, offset));
		writeFileSync(
			`${backupPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: backupPath,
				offset,
			}),
		);

		await expect(backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 71)).resolves.toBe(backupPath);
		expect(readFileSync(backupPath)).toEqual(source);
		expect(existsSync(`${backupPath}.cursor.json`)).toBe(true);
	});
	test("resume admission does not prune the only completed-unverified backup", async () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		const source = Buffer.from("resume admission fixture");
		writeFileSync(dbPath, source);
		const oldBackupPath = `${dbPath}.bak-v70-7000`;
		writeFileSync(oldBackupPath, source);
		const sourceStat = statSync(dbPath);
		writeFileSync(
			`${oldBackupPath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length - 1,
				sourceMtimeMs: sourceStat.mtimeMs - 1,
				destination: oldBackupPath,
				offset: source.length,
			}),
		);
		writeFileSync(`${oldBackupPath}.verdict.json`, JSON.stringify({ status: "complete" }));
		const resumablePath = `${dbPath}.bak-v71-8000`;
		mkdirSync(resumablePath);
		const offset = 4;
		writeFileSync(
			`${resumablePath}.cursor.json`,
			JSON.stringify({
				sourcePath: dbPath,
				sourceSize: source.length,
				sourceMtimeMs: sourceStat.mtimeMs,
				destination: resumablePath,
				offset,
			}),
		);

		const backupPath = await backupBeforeMigrationAsync({ exec: () => {} }, dbPath, 71);
		expect(backupPath).not.toBe(resumablePath);
		expect(readFileSync(backupPath)).toEqual(source);
		expect(existsSync(oldBackupPath)).toBe(false);
	});
	test("prunes the retained migration backup only after integrity passes", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		writeFileSync(dbPath, "database");
		const backupPath = `${dbPath}.bak-v72-9000`;
		writeFileSync(backupPath, "database");
		writeFileSync(`${backupPath}.cursor.json`, "stale cursor");

		expect(hasPendingMigrationBackup(dbPath)).toBe(true);
		pruneMigrationBackupsAfterIntegrity(dbPath);
		expect(hasPendingMigrationBackup(dbPath)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(`${backupPath}.cursor.json`)).toBe(false);
	});

	test("propagates a failed rollback backup deletion after integrity passes", () => {
		const dbPath = "/tmp/migration-prune-failure/test.db";
		const deps = {
			copyFileSync: () => {},
			readdirSync: () => ["test.db.bak-v72-9000"],
			statSync: () => ({ mtimeMs: 1, size: 10 }),
			statfsSync: () => ({ bavail: 1, bsize: 1 }),
			unlinkSync: () => {
				throw new Error("unlink denied");
			},
			now: () => 0,
			log: () => {},
			readVerificationCheckpoint: () => "complete",
		};

		expect(() => pruneMigrationBackupsAfterIntegrity(dbPath, deps)).toThrow("unlink denied");
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
		const accessorSource = readFileSync(join(import.meta.dir, "db-accessor.ts"), "utf8");
		const accessorConstructors = accessorSource.match(/new \(getDatabaseConstructor\(\)\)\(/g) ?? [];
		expect(accessorConstructors).toHaveLength(4);
		expect(accessorSource).not.toContain("new Database(");

		const hits: string[] = [];

		for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: import.meta.dir })) {
			if (file.endsWith(".test.ts") || file.endsWith(".bench.ts")) continue;
			if (file.startsWith("__tests__/")) continue;

			const text = readFileSync(join(import.meta.dir, file), "utf8");
			if (text.includes("new Database(")) {
				hits.push(file);
			}
		}

		expect([...new Set(hits)].sort()).toEqual([
			"database-integrity-worker.ts",
			"database-integrity.ts",
			"db-owner-worker.ts",
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

	test("does not run vector backfill during accessor initialization", () => {
		const source = readFileSync(join(import.meta.dir, "db-accessor.ts"), "utf8");
		const initStart = source.indexOf("function finishDbAccessorInit(");
		const initEnd = source.indexOf("export function initDbAccessorLite", initStart);
		const initSource = source.slice(initStart, initEnd);

		expect(initSource).not.toContain("backfillVecEmbeddings(");
		expect(initSource).toContain("pendingVecBackfill");
		expect(initSource).toContain("hasMissingVecEmbeddings");
	});

	test("post-ready backfill budget leaves room for a real batch", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE embeddings (id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB NOT NULL); CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE TABLE vec_embeddings_rowids (id TEXT PRIMARY KEY);",
		);
		const vector = Buffer.from(new Float32Array([1, 2]).buffer);
		db.prepare("INSERT INTO embeddings (id, dimensions, vector) VALUES (?, ?, ?)").run("post-ready", 2, vector);

		backfillVecEmbeddings(
			{
				exec: (sql: string) => db.exec(sql),
				prepare: (sql: string) => db.prepare(sql),
			} as never,
			2,
			Date.now() + VEC_EMBEDDING_POST_READY_BUDGET_MS,
			{ maxBatches: 1 },
		);

		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get() as { n: number }).n).toBe(1);
		db.close();
	});

	test("backfills missing embeddings in bounded keyset batches", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE embeddings (id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB NOT NULL); CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE TABLE vec_embeddings_rowids (id TEXT PRIMARY KEY);",
		);
		const vector = Buffer.from(new Float32Array([1, 2]).buffer);
		const insert = db.prepare("INSERT INTO embeddings (id, dimensions, vector) VALUES (?, ?, ?)");
		db.exec("BEGIN");
		for (let index = 0; index < 10_001; index++) {
			insert.run(`embedding-${String(index).padStart(5, "0")}`, 2, vector);
		}
		db.exec("COMMIT");
		let batchQueries = 0;
		const trackedDb = {
			exec: (sql: string) => db.exec(sql),
			prepare: (sql: string) => {
				if (sql.includes("ORDER BY e.id LIMIT")) batchQueries++;
				return db.prepare(sql);
			},
		};

		backfillVecEmbeddings(trackedDb as never, 2);

		expect(batchQueries).toBeGreaterThan(1);
		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get() as { n: number }).n).toBe(10_001);
		db.close();
	});

	test("quarantines malformed rows and continues backfill around them", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE embeddings (id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB NOT NULL); CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE TABLE vec_embeddings_rowids (id TEXT PRIMARY KEY);",
		);
		const vector = Buffer.from(new Float32Array([1, 2]).buffer);
		const insert = db.prepare("INSERT INTO embeddings (id, dimensions, vector) VALUES (?, ?, ?)");
		insert.run("good-1", 2, vector);
		insert.run("bad-row", 2, Buffer.from([1, 2, 3]));
		insert.run("good-2", 2, vector);

		backfillVecEmbeddings(
			{
				exec: (sql: string) => db.exec(sql),
				prepare: (sql: string) => db.prepare(sql),
			} as never,
			2,
		);

		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get() as { n: number }).n).toBe(2);
		expect(
			db.prepare("SELECT rowid, dimensions, reason, quarantinedAt FROM vec_embeddings_quarantine").all(),
		).toMatchObject([
			{
				rowid: "bad-row",
				dimensions: 2,
				reason: "embedding blob has 3 bytes; expected 8 for 2 dimensions",
			},
		]);
		// A follow-up probe sees no eligible pending row for the quarantined ID.
		backfillVecEmbeddings(
			{
				exec: (sql: string) => db.exec(sql),
				prepare: (sql: string) => db.prepare(sql),
			} as never,
			2,
		);
		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get() as { n: number }).n).toBe(2);
		db.close();
	});

	test("quarantines NULL and non-blob legacy vectors and continues backfill", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE embeddings (id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB); CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE TABLE vec_embeddings_rowids (id TEXT PRIMARY KEY);",
		);
		const vector = Buffer.from(new Float32Array([1, 2]).buffer);
		const insert = db.prepare("INSERT INTO embeddings (id, dimensions, vector) VALUES (?, ?, ?)");
		insert.run("good-row", 2, vector);
		insert.run("null-row", 2, null);
		insert.run("text-row", 2, "not-a-vector");

		backfillVecEmbeddings(
			{
				exec: (sql: string) => db.exec(sql),
				prepare: (sql: string) => db.prepare(sql),
			} as never,
			2,
		);

		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get() as { n: number }).n).toBe(1);
		expect(db.prepare("SELECT rowid, dimensions, reason FROM vec_embeddings_quarantine ORDER BY rowid").all()).toEqual([
			{ rowid: "null-row", dimensions: 2, reason: "embedding blob is NULL" },
			{ rowid: "text-row", dimensions: 2, reason: "embedding blob is not a binary buffer" },
		]);
		db.close();
	});

	test("rethrows operational vector insert failures instead of quarantining rows", () => {
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE embeddings (id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL, vector BLOB NOT NULL); CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL); CREATE TABLE vec_embeddings_rowids (id TEXT PRIMARY KEY);",
		);
		db.exec(
			"CREATE TRIGGER reject_locked_vec BEFORE INSERT ON vec_embeddings WHEN NEW.id = 'locked-row' BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
		);
		const vector = Buffer.from(new Float32Array([1, 2]).buffer);
		const insert = db.prepare("INSERT INTO embeddings (id, dimensions, vector) VALUES (?, ?, ?)");
		insert.run("good-row", 2, vector);
		insert.run("locked-row", 2, vector);

		expect(() =>
			backfillVecEmbeddings(
				{
					exec: (sql: string) => db.exec(sql),
					prepare: (sql: string) => db.prepare(sql),
				} as never,
				2,
			),
		).toThrow("database is locked");

		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get() as { n: number }).n).toBe(0);
		expect((db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings_quarantine").get() as { n: number }).n).toBe(0);
		db.close();
	});
});

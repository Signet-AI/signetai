/**
 * Regression test for #1139: SQLite database bloat from no VACUUM/auto_vacuum.
 *
 * Verifies that:
 * 1. New databases get auto_vacuum = INCREMENTAL
 * 2. convertToIncrementalVacuum converts legacy databases (auto_vacuum = 0)
 * 3. convertToIncrementalVacuum is idempotent (marker table prevents re-run)
 * 4. incremental_vacuum reclaims pages after DROP operations
 * 5. getFreePageRatio reports free-page fraction
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import {
	convertToIncrementalVacuum,
	DbSpacePreflightError,
	getFreePageRatio,
	getVacuumConversionStatus,
	reclaimIncrementalVacuum,
	startVacuumConversionWorker,
} from "./db-vacuum";

// The functions accept a narrower interface; bun:sqlite.Database satisfies it.
type PragmaDb = Parameters<typeof convertToIncrementalVacuum>[0];

function toPragmaDb(db: Database): PragmaDb {
	return db as unknown as PragmaDb;
}

describe("db-vacuum (#1139)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("reports zero free-page ratio on a fresh empty database", () => {
		const ratio = getFreePageRatio(toPragmaDb(db));
		expect(ratio).toBe(0);
	});

	it("reports nonzero free-page ratio after dropping a table", () => {
		// Create and populate a table, then drop it to generate free pages.
		db.exec("CREATE TABLE large (data BLOB)");
		const insert = db.prepare("INSERT INTO large (data) VALUES (?)");
		// Insert enough rows to span multiple pages.
		const chunk = Buffer.alloc(4096, 0x42);
		for (let i = 0; i < 50; i++) {
			insert.run(chunk);
		}
		db.exec("DROP TABLE large");

		const ratio = getFreePageRatio(toPragmaDb(db));
		expect(ratio).toBeGreaterThan(0);
	});

	it("sets auto_vacuum = INCREMENTAL on fresh databases via PRAGMA", () => {
		// Simulate what configurePragmas does for new databases.
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		// auto_vacuum must be set before any tables are created to take effect.
		// On an in-memory DB the pragma sticks because no tables exist yet.
		const mode = (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number }).auto_vacuum;
		expect(mode).toBe(2);
	});

	it("convertToIncrementalVacuum reclaims free pages from a bloated database", () => {
		// Simulate a legacy database: auto_vacuum = 0 (the default for existing DBs).
		// On in-memory databases auto_vacuum = 0 is the default, so we don't set it.
		// Create bloat by creating and dropping tables.
		db.exec("CREATE TABLE junk (data BLOB)");
		const insert = db.prepare("INSERT INTO junk (data) VALUES (?)");
		const chunk = Buffer.alloc(4096, 0x42);
		for (let i = 0; i < 100; i++) {
			insert.run(chunk);
		}

		const pagesBefore = (db.prepare("PRAGMA page_count").get() as { page_count?: number }).page_count;
		const freeBefore = (db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number }).freelist_count;

		// Drop the table to free pages.
		db.exec("DROP TABLE junk");

		const freeAfterDrop = (db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number }).freelist_count;
		expect(freeAfterDrop as number).toBeGreaterThan(0);

		// Run the conversion. VACUUM rebuilds and sets auto_vacuum = INCREMENTAL.
		const result = convertToIncrementalVacuum(toPragmaDb(db));
		expect(result).toBe(true);

		// After VACUUM, free pages should be minimal.
		const freeAfter = (db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number }).freelist_count;
		expect(freeAfter as number).toBeLessThanOrEqual(1);

		// auto_vacuum should now be INCREMENTAL (2).
		const mode = (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number }).auto_vacuum;
		expect(mode).toBe(2);

		// Marker table should exist.
		const marker = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_signet_vacuum_converted'")
			.get();
		expect(marker).toBeDefined();

		// Total pages should be much smaller after VACUUM.
		const pagesAfter = (db.prepare("PRAGMA page_count").get() as { page_count?: number }).page_count;
		expect(pagesAfter as number).toBeLessThan(pagesBefore as number);

		// Silence unused warnings.
		expect(freeBefore).toBeDefined();
	});

	it("does not run VACUUM when two database copies do not fit", () => {
		const operations: string[] = [];
		const pragmaDb = {
			exec(sql: string): void {
				operations.push(sql);
			},
			prepare(sql: string) {
				return {
					get: () => (sql === "PRAGMA auto_vacuum" ? { auto_vacuum: 0 } : { freelist_count: 0 }),
					all: () => [],
					run: () => undefined,
				};
			},
		};
		expect(() =>
			convertToIncrementalVacuum(pragmaDb, {
				dbPath: "/tmp/test.db",
				deps: {
					statSync: () => ({ size: 8 }),
					statfsSync: () => ({ bavail: 8, bsize: 1 }),
				},
			}),
		).toThrow(DbSpacePreflightError);
		expect(operations).toEqual([]);
	});

	it("normalizes SQLite FULL errors from VACUUM", () => {
		const operations: string[] = [];
		const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
		const pragmaDb = {
			exec(sql: string): void {
				operations.push(sql);
				if (sql === "VACUUM") throw error;
			},
			prepare(sql: string) {
				return {
					get: () => (sql === "PRAGMA auto_vacuum" ? { auto_vacuum: 0 } : { freelist_count: 0 }),
					all: () => [],
					run: () => undefined,
				};
			},
		};

		let thrown: unknown;
		try {
			convertToIncrementalVacuum(pragmaDb, {
				dbPath: "/tmp/test.db",
				deps: {
					statSync: () => ({ size: 8 }),
					statfsSync: () => ({ bavail: 16, bsize: 1 }),
				},
			});
		} catch (caught) {
			thrown = caught;
		}
		expect(thrown).toBeInstanceOf(DbSpacePreflightError);
		expect((thrown as DbSpacePreflightError).operation).toBe("vacuum");
		expect((thrown as DbSpacePreflightError).metrics.requiredBytes).toBe(16);
		expect((thrown as DbSpacePreflightError).message).toContain("Cause: database or disk is full");
		expect(operations).toContain("VACUUM");
	});

	it("normalizes SQLite FULL errors when the post-failure space probe fails", () => {
		let statfsCalls = 0;
		const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
		const pragmaDb = {
			exec(sql: string): void {
				if (sql === "VACUUM") throw error;
			},
			prepare(sql: string) {
				return {
					get: () => (sql === "PRAGMA auto_vacuum" ? { auto_vacuum: 0 } : { freelist_count: 0 }),
					all: () => [],
					run: () => undefined,
				};
			},
		};

		let thrown: unknown;
		try {
			convertToIncrementalVacuum(pragmaDb, {
				dbPath: "/tmp/test.db",
				deps: {
					statSync: () => ({ size: 8 }),
					statfsSync: () => {
						statfsCalls += 1;
						if (statfsCalls === 2) throw new Error("statfs unavailable");
						return { bavail: 16, bsize: 1 };
					},
				},
			});
		} catch (caught) {
			thrown = caught;
		}

		expect(thrown).toBeInstanceOf(DbSpacePreflightError);
		expect((thrown as DbSpacePreflightError).cause).toBe(error);
		expect((thrown as DbSpacePreflightError).metrics.requiredBytes).toBe(16);
		expect(statfsCalls).toBe(2);
	});

	it("convertToIncrementalVacuum is idempotent (does not re-run VACUUM)", () => {
		// First conversion.
		expect(convertToIncrementalVacuum(toPragmaDb(db))).toBe(true);

		// Second call should detect auto_vacuum = 2 and return false immediately.
		expect(convertToIncrementalVacuum(toPragmaDb(db))).toBe(false);
	});

	it("convertToIncrementalVacuum is a no-op when auto_vacuum is already INCREMENTAL", () => {
		// Simulate a fresh database created after the fix.
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		expect(convertToIncrementalVacuum(toPragmaDb(db))).toBe(false);

		// No marker table should be written because VACUUM never ran.
		const marker = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_signet_vacuum_converted'")
			.get();
		expect(marker).toBeNull();
	});
});

function legacyDbPath(): { readonly dir: string; readonly path: string } {
	const dir = mkdtempSync(join(tmpdir(), "signet-vacuum-test-"));
	const path = join(dir, "memories.db");
	const db = new Database(path);
	db.exec("PRAGMA auto_vacuum = NONE; CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES ('keep');");
	db.close();
	return { dir, path };
}

describe("deferred vacuum conversion (#1493)", () => {
	let dir = "";

	afterEach(() => {
		closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("normal initialization records pending work without running VACUUM", () => {
		const db = legacyDbPath();
		dir = db.dir;
		initDbAccessor(db.path);

		expect(getVacuumConversionStatus(getDbAccessor())).toMatchObject({
			state: "pending",
			attempts: 0,
		});
		const mode = getSyncDbAccessor().withReadDb((readDb) => {
			return (readDb.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum;
		});
		expect(mode).toBe(0);
	});

	it("conversion completes exactly once through the post-ready worker", async () => {
		const db = legacyDbPath();
		dir = db.dir;
		initDbAccessor(db.path);
		const worker = startVacuumConversionWorker(getDbAccessor(), { startImmediately: false });

		const completed = await worker.run();
		expect(completed.state).toBe("completed");
		expect(completed.attempts).toBe(1);
		expect(await worker.run()).toMatchObject({ state: "completed", attempts: 1 });

		const markerCount = getSyncDbAccessor().withReadDb(
			(readDb) =>
				(readDb.prepare("SELECT COUNT(*) AS count FROM _signet_vacuum_converted").get() as { count: number }).count,
		);
		expect(markerCount).toBe(1);
	});

	it("runs production conversion through the DB owner child", async () => {
		const db = legacyDbPath();
		dir = db.dir;
		initDbAccessor(db.path);
		const owner = createDbOwnerClient({ dbPath: db.path });
		await owner.start();
		try {
			const worker = startVacuumConversionWorker(getDbAccessor(), { owner, startImmediately: false });
			await expect(worker.run()).resolves.toMatchObject({ state: "completed", attempts: 1 });
			expect(owner.health().state).toBe("ready");
		} finally {
			await owner.close();
		}
	});

	it("recovers safely when the real VACUUM owner is SIGKILLed", async () => {
		const db = legacyDbPath();
		dir = db.dir;
		initDbAccessor(db.path);
		const owner = createDbOwnerClient({ dbPath: db.path });
		const previousPause = process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS;
		const previousActiveFile = process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE;
		const activeFile = join(db.dir, "vacuum-active");
		process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS = "5000";
		process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE = activeFile;
		await owner.start();
		try {
			const worker = startVacuumConversionWorker(getDbAccessor(), { owner, startImmediately: false });
			const running = worker.run();
			const deadline = Date.now() + 2000;
			while (!existsSync(activeFile) && Date.now() < deadline) await Bun.sleep(5);
			const pid = owner.health().pid;
			expect(existsSync(activeFile)).toBe(true);
			expect(pid).not.toBeNull();
			process.kill(pid as number, "SIGKILL");
			await Promise.race([running.catch(() => undefined), Bun.sleep(100)]);
		} finally {
			if (previousPause === undefined) Reflect.deleteProperty(process.env, "SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS");
			else process.env.SIGNET_TEST_DB_OWNER_VACUUM_PAUSE_MS = previousPause;
			if (previousActiveFile === undefined)
				Reflect.deleteProperty(process.env, "SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE");
			else process.env.SIGNET_TEST_DB_OWNER_VACUUM_ACTIVE_FILE = previousActiveFile;
			await Promise.race([owner.close().catch(() => undefined), Bun.sleep(250)]);
		}

		const integrity = new Database(db.path, { readonly: true });
		expect((integrity.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe(
			"ok",
		);
		integrity.close();
		closeDbAccessor();
		initDbAccessor(db.path);
		expect(getVacuumConversionStatus(getDbAccessor()).state).toBe("pending");
		const nextOwner = createDbOwnerClient({ dbPath: db.path });
		await nextOwner.start();
		try {
			const resumed = startVacuumConversionWorker(getDbAccessor(), { owner: nextOwner, startImmediately: false });
			expect(await resumed.run()).toMatchObject({ state: "completed", attempts: 2 });
		} finally {
			await nextOwner.close();
		}
	});

	it("a killed or failed conversion remains retryable without blocking initialization", async () => {
		const db = legacyDbPath();
		dir = db.dir;
		initDbAccessor(db.path);
		getSyncDbAccessor().withWriteTx((writeDb) => {
			writeDb
				.prepare(
					"UPDATE _signet_vacuum_conversion SET state = 'running', attempts = 1, started_at = ?, updated_at = ? WHERE id = 1",
				)
				.run(new Date().toISOString(), new Date().toISOString());
		});
		closeDbAccessor();
		initDbAccessor(db.path);
		expect(getVacuumConversionStatus(getDbAccessor())).toMatchObject({ state: "pending", attempts: 1 });

		const accessor = getDbAccessor();
		const originalConversion = accessor.vacuumConversionAsync;
		accessor.vacuumConversionAsync = async () => {
			throw new Error("simulated conversion failure");
		};
		const worker = startVacuumConversionWorker(accessor, { startImmediately: false });
		const failed = await worker.run();
		accessor.vacuumConversionAsync = originalConversion;
		expect(failed).toMatchObject({ state: "failed", attempts: 2, lastError: "simulated conversion failure" });

		closeDbAccessor();
		initDbAccessor(db.path);
		expect(getVacuumConversionStatus(getDbAccessor())).toMatchObject({ state: "pending", attempts: 2 });

		getSyncDbAccessor().withWriteTx((writeDb) => {
			writeDb.prepare("UPDATE _signet_vacuum_conversion SET state = 'running', attempts = 3 WHERE id = 1").run();
		});
		closeDbAccessor();
		initDbAccessor(db.path);
		expect(getVacuumConversionStatus(getDbAccessor())).toMatchObject({ state: "failed", attempts: 3 });
	});
});

describe("integrated incremental reclaim resume (#1667)", () => {
	it("observes owner batches and resumes from the durable checkpoint after SIGKILL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-vacuum-reclaim-test-"));
		const dbPath = join(directory, "memories.db");
		const seed = new Database(dbPath);
		seed.exec("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE reclaim_bloat (data BLOB)");
		const insert = seed.prepare("INSERT INTO reclaim_bloat (data) VALUES (?)");
		for (let index = 0; index < 100; index++) insert.run(Buffer.alloc(4096, 0x42));
		seed.exec("DROP TABLE reclaim_bloat");
		const freeBefore = (seed.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
		seed.close();
		expect(freeBefore).toBeGreaterThan(2);

		const owner = createDbOwnerClient({ dbPath });
		const accessor = {} as Parameters<typeof reclaimIncrementalVacuum>[0];
		const checkpoints: Array<{ reclaimed: number; remaining: number }> = [];
		let killed = false;
		try {
			await owner.start();
			await reclaimIncrementalVacuum(accessor, {
				owner,
				batchPages: 1,
				checkpointKey: "test.integrated-reclaim",
				maxBatches: 1,
				onCheckpoint: (reclaimed, remaining) => {
					checkpoints.push({ reclaimed, remaining });
					if (!killed && checkpoints.length === 1 && remaining > 0) {
						killed = true;
						const pid = owner.health().pid;
						if (pid === null) throw new Error("owner did not publish a pid");
						process.kill(pid, "SIGKILL");
					}
				},
			});
			expect(killed).toBe(true);
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0].remaining).toBeGreaterThan(0);
		} finally {
			await owner.close().catch(() => undefined);
		}

		const integrityAfterKill = new Database(dbPath, { readonly: true });
		expect(
			(integrityAfterKill.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
		).toBe("ok");
		integrityAfterKill.close();

		const resumedOwner = createDbOwnerClient({ dbPath });
		try {
			await resumedOwner.start();
			const resumed = await reclaimIncrementalVacuum(accessor, {
				owner: resumedOwner,
				batchPages: 1,
				checkpointKey: "test.integrated-reclaim",
				maxBatches: 200,
				onCheckpoint: (reclaimed, remaining) => checkpoints.push({ reclaimed, remaining }),
			});
			expect(resumed.remaining).toBe(0);
			expect(checkpoints.length).toBeGreaterThan(1);
			expect(checkpoints.at(-1)).toEqual(expect.objectContaining({ remaining: 0 }));
		} finally {
			await resumedOwner.close();
		}

		const finalDb = new Database(dbPath, { readonly: true });
		expect((finalDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
		finalDb.close();
		rmSync(directory, { recursive: true, force: true });
	});
});

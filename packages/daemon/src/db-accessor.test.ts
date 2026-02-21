/**
 * Tests for the DB accessor (singleton read/write transaction wrapper).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDbAccessor, getDbAccessor, closeDbAccessor } from "./db-accessor";

function tmpDbPath(): string {
	const dir = join(
		tmpdir(),
		`signet-accessor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
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
	});

	test("withWriteTx provides working write access", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY, val TEXT)");
			db.prepare("INSERT INTO test_table (id, val) VALUES (?, ?)").run(
				1,
				"hello",
			);
		});

		const result = acc.withReadDb((db) => {
			return db.prepare("SELECT val FROM test_table WHERE id = ?").get(1) as
				| Record<string, unknown>
				| undefined;
		});
		expect(result).toBeTruthy();
		expect(result?.val).toBe("hello");
	});

	test("withReadDb provides working read access", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);
		const acc = getDbAccessor();

		acc.withWriteTx((db) => {
			db.exec("CREATE TABLE read_test (id INTEGER PRIMARY KEY, name TEXT)");
			db.prepare("INSERT INTO read_test (id, name) VALUES (?, ?)").run(
				1,
				"alice",
			);
			db.prepare("INSERT INTO read_test (id, name) VALUES (?, ?)").run(
				2,
				"bob",
			);
		});

		const rows = acc.withReadDb((db) => {
			return db
				.prepare("SELECT name FROM read_test ORDER BY id")
				.all() as Array<Record<string, unknown>>;
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
			db.prepare("INSERT INTO rollback_test (id, val) VALUES (?, ?)").run(
				1,
				"original",
			);
		});

		try {
			acc.withWriteTx((db) => {
				db.prepare("INSERT INTO rollback_test (id, val) VALUES (?, ?)").run(
					2,
					"should-rollback",
				);
				throw new Error("intentional failure");
			});
		} catch {
			// expected
		}

		const rows = acc.withReadDb((db) => {
			return db
				.prepare("SELECT id FROM rollback_test ORDER BY id")
				.all() as Array<Record<string, unknown>>;
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(1);
	});

	test("close works without error", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		// Should not throw
		closeDbAccessor();
	});
});

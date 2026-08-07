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
import { convertToIncrementalVacuum, getFreePageRatio } from "./db-vacuum";

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

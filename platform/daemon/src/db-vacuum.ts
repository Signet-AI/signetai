/**
 * SQLite free-page reclamation (#1139).
 *
 * Without auto_vacuum or periodic VACUUM, free pages from DROP/DELETE/migration
 * operations accumulate forever. A workspace with 5k memories grew to 29GB.
 *
 * Strategy:
 * 1. New databases get PRAGMA auto_vacuum = INCREMENTAL in configurePragmas.
 * 2. Existing databases (auto_vacuum = 0) get a one-time VACUUM to convert
 *    them to incremental mode. This is expensive but bounded and runs once.
 * 3. After free-page-heavy operations (embedding index promotion), run
 *    PRAGMA incremental_vacuum to reclaim pages immediately.
 * 4. The maintenance worker periodically checks freelist_count and runs
 *    incremental_vacuum when free pages exceed 20% of total pages.
 */

import { logger } from "./logger";

/** Marker table name for the one-time VACUUM conversion. */
const VACUUM_CONVERSION_TABLE = "_signet_vacuum_converted";

/** Read-only pragma surface. */
interface PragmaReadDb {
	prepare(sql: string): {
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

/** Read/write pragma surface for conversion operations. */
interface PragmaDb extends PragmaReadDb {
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): unknown;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

/** Check whether the database has incremental auto_vacuum enabled. */
function getAutoVacuumMode(db: PragmaReadDb): number {
	const row = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
	return typeof row?.auto_vacuum === "number" ? row.auto_vacuum : 0;
}

/** Get the free-page ratio (freelist_count / page_count). */
export function getFreePageRatio(db: PragmaReadDb): number {
	const freelist = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const pages = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
	const free = typeof freelist?.freelist_count === "number" ? freelist.freelist_count : 0;
	const total = typeof pages?.page_count === "number" ? pages.page_count : 0;
	return total > 0 ? free / total : 0;
}

/**
 * One-time conversion of existing databases to incremental auto_vacuum mode.
 *
 * PRAGMA auto_vacuum only takes effect on a fresh DB or after VACUUM. For
 * databases created before this fix (auto_vacuum = 0), run VACUUM to rebuild
 * the file and flip the mode. The conversion marker prevents re-running.
 *
 * VACUUM requires temporary disk space roughly equal to the database size.
 * On a 29GB bloated DB this is dramatic but transforms it to ~200MB. After
 * conversion, incremental_vacuum keeps the file compact without full rebuilds.
 *
 * Must be called outside a transaction (VACUUM cannot run inside BEGIN/COMMIT).
 * Returns true if the conversion ran.
 */
export function convertToIncrementalVacuum(db: PragmaDb): boolean {
	const mode = getAutoVacuumMode(db);

	// 2 = INCREMENTAL. Already converted or fresh DB created after the fix.
	if (mode === 2) return false;

	// Check if already converted via marker table.
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.all(VACUUM_CONVERSION_TABLE);
	if (tables.length > 0) return false;

	// Set the desired mode BEFORE VACUUM so the rebuilt file uses it.
	db.exec("PRAGMA auto_vacuum = INCREMENTAL");

	const freelistBefore = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const freeBefore = typeof freelistBefore?.freelist_count === "number" ? freelistBefore.freelist_count : 0;

	logger.info(
		"db-vacuum",
		`Converting database to incremental auto_vacuum (current mode: ${mode}, free pages: ${freeBefore})`,
	);
	logger.info("db-vacuum", "Running one-time VACUUM — this may take several minutes on large databases");

	const startedAt = Date.now();
	db.exec("VACUUM");
	const elapsedMs = Date.now() - startedAt;

	const freelistAfter = db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
	const freeAfter = typeof freelistAfter?.freelist_count === "number" ? freelistAfter.freelist_count : 0;
	const modeAfter = getAutoVacuumMode(db);

	logger.info(
		"db-vacuum",
		`VACUUM complete in ${Math.round(elapsedMs / 1000)}s — free pages: ${freeBefore} -> ${freeAfter}, auto_vacuum: ${mode} -> ${modeAfter}`,
	);

	// Write marker so we never re-run VACUUM on this database.
	db.exec(`CREATE TABLE IF NOT EXISTS ${VACUUM_CONVERSION_TABLE} (converted_at TEXT)`);
	db.prepare(`INSERT INTO ${VACUUM_CONVERSION_TABLE} (converted_at) VALUES (?)`).run(new Date().toISOString());

	return true;
}

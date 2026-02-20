/**
 * Singleton DB accessor for the Signet daemon.
 *
 * Holds a single write connection for the daemon's lifetime and provides
 * transaction wrappers for safe concurrent access. Read connections are
 * opened on demand (SQLite WAL mode allows concurrent readers).
 */

import { Database, type Statement } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runMigrations } from "@signet/core";

// ---------------------------------------------------------------------------
// Public interfaces — thin wrappers over the bun:sqlite Database surface
// ---------------------------------------------------------------------------

export interface WriteDb {
	exec(sql: string): void;
	prepare(sql: string): Statement;
}

export interface ReadDb {
	prepare(sql: string): Statement;
}

export interface DbAccessor {
	/** Run `fn` inside BEGIN IMMEDIATE / COMMIT (ROLLBACK on error). */
	withWriteTx<T>(fn: (db: WriteDb) => T): T;

	/** Open a readonly connection, run `fn`, close it. */
	withReadDb<T>(fn: (db: ReadDb) => T): T;

	/** Close all held connections. Safe to call multiple times. */
	close(): void;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let accessor: DbAccessor | null = null;
let dbPath: string | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function configurePragmas(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA temp_store = MEMORY");
}

/**
 * Initialise the singleton accessor. Must be called once at daemon startup
 * before any route handler runs. Ensures the memory directory exists, opens
 * the write connection, sets pragmas, and runs pending migrations.
 */
export function initDbAccessor(path: string): void {
	if (accessor) {
		throw new Error("DbAccessor already initialised");
	}

	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	dbPath = path;

	const writeConn = new Database(path);
	configurePragmas(writeConn);

	// Run schema migrations — this is the sole schema authority.
	// Failures here are fatal: the daemon must not start on bad schema.
	runMigrations(writeConn);

	accessor = createAccessor(writeConn);
}

// ---------------------------------------------------------------------------
// Accessor factory
// ---------------------------------------------------------------------------

const READ_POOL_SIZE = 4;

function createAccessor(writeConn: Database): DbAccessor {
	let closed = false;

	// Small pool of reusable read connections. Recall does 3 reads per
	// request so opening/closing every time adds measurable overhead.
	const readPool: Database[] = [];
	const readInUse = new Set<Database>();

	function acquireRead(): Database {
		if (dbPath === null) throw new Error("DbAccessor not initialised");
		const pooled = readPool.pop();
		if (pooled) {
			readInUse.add(pooled);
			return pooled;
		}
		const conn = new Database(dbPath, { readonly: true });
		conn.exec("PRAGMA busy_timeout = 5000");
		readInUse.add(conn);
		return conn;
	}

	function releaseRead(conn: Database): void {
		readInUse.delete(conn);
		if (readPool.length < READ_POOL_SIZE) {
			readPool.push(conn);
		} else {
			conn.close();
		}
	}

	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			if (closed) throw new Error("DbAccessor is closed");
			writeConn.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(writeConn);
				writeConn.exec("COMMIT");
				return result;
			} catch (err) {
				writeConn.exec("ROLLBACK");
				throw err;
			}
		},

		withReadDb<T>(fn: (db: ReadDb) => T): T {
			if (closed) throw new Error("DbAccessor is closed");
			const conn = acquireRead();
			try {
				return fn(conn);
			} finally {
				releaseRead(conn);
			}
		},

		close(): void {
			if (closed) return;
			closed = true;
			writeConn.close();
			for (const conn of readPool) conn.close();
			for (const conn of readInUse) conn.close();
			readPool.length = 0;
			readInUse.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Get the initialised accessor. Throws if `initDbAccessor` hasn't been called. */
export function getDbAccessor(): DbAccessor {
	if (!accessor) {
		throw new Error("DbAccessor not initialised — call initDbAccessor() first");
	}
	return accessor;
}

/** Tear down the singleton. Safe to call even if never initialised. */
export function closeDbAccessor(): void {
	if (accessor) {
		accessor.close();
		accessor = null;
		dbPath = null;
	}
}

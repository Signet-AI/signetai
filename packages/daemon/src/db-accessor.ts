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
import {
	runMigrations,
	findSqliteVecExtension,
	DEFAULT_EMBEDDING_DIMENSIONS,
} from "@signet/core";

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

// Cached extension path — resolved once at startup
let vecExtPath: string | null | undefined;

function loadVecExtension(db: Database): void {
	if (vecExtPath === undefined) {
		vecExtPath = findSqliteVecExtension();
		if (!vecExtPath) {
			console.warn("[db-accessor] sqlite-vec extension not found — vector search disabled");
		}
	}
	if (vecExtPath) {
		try {
			db.loadExtension(vecExtPath);
		} catch {
			// Extension may already be loaded or unavailable
		}
	}
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
	loadVecExtension(writeConn);

	// Run schema migrations — this is the sole schema authority.
	// Failures here are fatal: the daemon must not start on bad schema.
	runMigrations(writeConn);

	// Ensure vec_embeddings virtual table exists with correct schema.
	// Older tables may lack the TEXT id column needed to join with embeddings.
	if (vecExtPath) {
		try {
			ensureVecTable(writeConn);
			backfillVecEmbeddings(writeConn);
		} catch {
			// vec0 not usable — vector search will be disabled
		}
	}

	accessor = createAccessor(writeConn);
}

// ---------------------------------------------------------------------------
// Vec table creation + backfill
// ---------------------------------------------------------------------------

function ensureVecTable(db: Database): void {
	// Check if vec_embeddings exists and has the correct schema (TEXT id).
	// If it exists without an id column, drop and recreate.
	const existing = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'",
		)
		.get() as { sql: string } | undefined;

	if (existing) {
		if (existing.sql.includes("id TEXT")) return;
		// Old schema without id — drop it
		db.exec("DROP TABLE vec_embeddings");
	}

	// Detect actual embedding dimensions from existing data
	const dimRow = db
		.prepare("SELECT dimensions FROM embeddings LIMIT 1")
		.get() as { dimensions: number } | undefined;
	const dims = dimRow?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

	db.exec(`
		CREATE VIRTUAL TABLE vec_embeddings USING vec0(
			id TEXT PRIMARY KEY,
			embedding FLOAT[${dims}] distance_metric=cosine
		);
	`);
}

function backfillVecEmbeddings(db: Database): void {
	const vecCount = (
		db.prepare("SELECT count(*) as n FROM vec_embeddings").get() as {
			n: number;
		}
	).n;
	if (vecCount > 0) return;

	const embCount = (
		db.prepare("SELECT count(*) as n FROM embeddings").get() as {
			n: number;
		}
	).n;
	if (embCount === 0) return;

	const rows = db
		.prepare("SELECT id, vector FROM embeddings")
		.all() as Array<{ id: string; vector: Buffer }>;

	const insert = db.prepare(
		"INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)",
	);

	db.exec("BEGIN");
	let migrated = 0;
	for (const row of rows) {
		try {
			const vec = new Float32Array(
				row.vector.buffer.slice(
					row.vector.byteOffset,
					row.vector.byteOffset + row.vector.byteLength,
				),
			);
			insert.run(row.id, vec);
			migrated++;
		} catch {
			// Skip malformed rows
		}
	}
	db.exec("COMMIT");

	if (migrated > 0) {
		// eslint-disable-next-line no-console
		console.log(
			`[db-accessor] Backfilled ${migrated}/${embCount} embeddings into vec_embeddings`,
		);
	}
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
		loadVecExtension(conn);
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

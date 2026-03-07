/**
 * Session memory candidate recording and FTS hit tracking.
 *
 * Records which memories were considered and injected at session start,
 * and tracks FTS hits during user prompt handling. This data feeds
 * the continuity scorer and (eventually) the predictive memory scorer.
 */

import type { Statement } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type WriteDb, getDbAccessor } from "./db-accessor";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Constants & Caching
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 50;

// Optimization: Omit fts_hit_count (defaults to 0) to reduce parameters.
const SESSION_CANDIDATES_BASE_SQL = `INSERT OR IGNORE INTO session_memories
	 (id, session_key, memory_id, source, effective_score,
	  final_score, rank, was_injected, created_at)
	 VALUES `;

const SESSION_CANDIDATES_ROW = "(?,?,?,?,?,?,?,?,?)";

const FTS_HITS_BASE_SQL = `INSERT INTO session_memories
	 (id, session_key, memory_id, source, effective_score,
	  final_score, rank, was_injected, fts_hit_count, created_at)
	 VALUES `;

const FTS_HITS_ROW = "(?, ?, ?, 'fts_only', 0, 0, 0, 0, 1, ?)";

const FTS_HITS_CONFLICT_CLAUSE = `
	 ON CONFLICT(session_key, memory_id) DO UPDATE SET
	  fts_hit_count = fts_hit_count + 1`;

/** Pre-computed SQL fragments for different chunk sizes */
const CANDIDATES_SQL_BY_SIZE = new Array(CHUNK_SIZE + 1);
const FTS_HITS_SQL_BY_SIZE = new Array(CHUNK_SIZE + 1);

for (let i = 1; i <= CHUNK_SIZE; i++) {
	CANDIDATES_SQL_BY_SIZE[i] =
		SESSION_CANDIDATES_BASE_SQL + Array.from({ length: i }, () => SESSION_CANDIDATES_ROW).join(",");
	FTS_HITS_SQL_BY_SIZE[i] =
		FTS_HITS_BASE_SQL + Array.from({ length: i }, () => FTS_HITS_ROW).join(",") + FTS_HITS_CONFLICT_CLAUSE;
}

/** Pre-allocated buffer to avoid GC pressure on the hot path */
const VALUES_BUFFER = new Array(CHUNK_SIZE * 9);

/** Cached database existence check result */
let dbExists: boolean | undefined;
let lastCheckedPath: string | undefined;

function getMemoryDbPath(): string {
	return process.env.SIGNET_PATH
		? join(process.env.SIGNET_PATH, "memory", "memories.db")
		: join(homedir(), ".agents", "memory", "memories.db");
}

function checkDbExists(): boolean {
	const path = getMemoryDbPath();
	if (dbExists === undefined || path !== lastCheckedPath) {
		dbExists = existsSync(path);
		lastCheckedPath = path;
	}
	return dbExists;
}

/**
 * Statement cache to avoid redundant db.prepare calls on the hot path.
 * Statements are tied to a specific database connection instance.
 */
const stmtCache = new WeakMap<WriteDb, Map<string, Statement>>();

function getCachedStmt(db: WriteDb, sql: string): Statement {
	let dbCache = stmtCache.get(db);
	if (!dbCache) {
		dbCache = new Map();
		stmtCache.set(db, dbCache);
	}
	let stmt = dbCache.get(sql);
	if (!stmt) {
		stmt = db.prepare(sql);
		dbCache.set(sql, stmt);
	}
	return stmt;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMemoryCandidate {
	readonly id: string;
	readonly effScore: number;
	readonly source: "effective" | "fts_only";
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Batch-insert all candidate memories for a session. Candidates that
 * were actually injected get was_injected=1; the rest get 0.
 * Safe to call with an empty candidates array (no-op).
 *
 * Optimization: Uses multi-row INSERTs to minimize bridge overhead
 * between Bun and SQLite. Records are processed in chunks of 50 to
 * stay safely within SQLite's parameter limits. Statement caching,
 * redundant index removal, and pre-allocated buffers further reduce overhead.
 */
export function recordSessionCandidates(
	sessionKey: string | undefined,
	candidates: ReadonlyArray<SessionMemoryCandidate>,
	injectedIds: ReadonlySet<string>,
): void {
	if (!sessionKey || candidates.length === 0 || !checkDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			let rank = 0;

			for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
				const chunkLength = Math.min(candidates.length - i, CHUNK_SIZE);

				const sql = CANDIDATES_SQL_BY_SIZE[chunkLength];
				const stmt = getCachedStmt(db, sql);

				let valIdx = 0;
				for (let j = 0; j < chunkLength; j++) {
					const c = candidates[i + j];
					const wasInjected = injectedIds.has(c.id) ? 1 : 0;
					const cid = c.id;

					// Optimization: Using sessionKey + cid as ID is much faster than crypto.randomUUID()
					// and guaranteed unique by the schema's UNIQUE(session_key, memory_id) constraint.
					VALUES_BUFFER[valIdx++] = `${sessionKey}:${cid}`;
					VALUES_BUFFER[valIdx++] = sessionKey;
					VALUES_BUFFER[valIdx++] = cid;
					VALUES_BUFFER[valIdx++] = c.source;
					VALUES_BUFFER[valIdx++] = c.effScore;
					VALUES_BUFFER[valIdx++] = c.effScore; // final_score = effective_score until predictor exists
					VALUES_BUFFER[valIdx++] = rank++;
					VALUES_BUFFER[valIdx++] = wasInjected;
					VALUES_BUFFER[valIdx++] = now;
				}

				if (chunkLength === CHUNK_SIZE) {
					stmt.run(...VALUES_BUFFER);
				} else {
					// Need to slice for partial chunks to avoid passing undefineds
					stmt.run(...VALUES_BUFFER.slice(0, valIdx));
				}
			}
		});

		// Only log at debug level to keep the hot path quiet
		if (logger.level === "debug") {
			logger.debug("session-memories", "Recorded session candidates", {
				sessionKey,
				total: candidates.length,
				injected: injectedIds.size,
			});
		}
	} catch (e) {
		// Non-fatal — don't break session start for recording failures
		logger.warn("session-memories", "Failed to record candidates", {
			error: (e as Error).message,
		});
	}
}

// ---------------------------------------------------------------------------
// FTS hit tracking
// ---------------------------------------------------------------------------

/**
 * Increment fts_hit_count for memories matched during user prompt handling.
 * If a memory wasn't a session-start candidate, inserts a new row with
 * source='fts_only'.
 *
 * Optimization: Uses SQLite UPSERT (INSERT ... ON CONFLICT DO UPDATE) to
 * collapse two queries into one, reducing roundtrips.
 */
export function trackFtsHits(sessionKey: string | undefined, matchedIds: ReadonlyArray<string>): void {
	if (!sessionKey || matchedIds.length === 0 || !checkDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();

			for (let i = 0; i < matchedIds.length; i += CHUNK_SIZE) {
				const chunkLength = Math.min(matchedIds.length - i, CHUNK_SIZE);

				const sql = FTS_HITS_SQL_BY_SIZE[chunkLength];
				const stmt = getCachedStmt(db, sql);

				let valIdx = 0;
				for (let j = 0; j < chunkLength; j++) {
					const mid = matchedIds[i + j];
					VALUES_BUFFER[valIdx++] = `${sessionKey}:${mid}`;
					VALUES_BUFFER[valIdx++] = sessionKey;
					VALUES_BUFFER[valIdx++] = mid;
					VALUES_BUFFER[valIdx++] = now;
				}

				// Need to slice for all chunks because FTS_HITS_ROW has fewer
				// parameters than the buffer capacity (9 per row).
				stmt.run(...VALUES_BUFFER.slice(0, valIdx));
			}
		});
	} catch (e) {
		logger.warn("session-memories", "Failed to track FTS hits", {
			error: (e as Error).message,
		});
	}
}

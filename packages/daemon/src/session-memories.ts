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

let cachedMemoryDbPath: string | null = null;
let lastSignetPath: string | undefined = undefined;

function getMemoryDbPath(): string {
	if (process.env.SIGNET_PATH !== lastSignetPath) {
		lastSignetPath = process.env.SIGNET_PATH;
		const agentsDir = lastSignetPath || join(homedir(), ".agents");
		cachedMemoryDbPath = join(agentsDir, "memory", "memories.db");
	}
	return cachedMemoryDbPath!;
}

/**
 * Statement cache for session memory operations.
 * Keyed by the DB instance to avoid memory leaks when connections are closed.
 */
const STMT_CACHE = new WeakMap<WriteDb, Map<string, Statement>>();

/**
 * Get or prepare a cached statement for the given DB and SQL.
 */
function getCachedStatement(db: WriteDb, sql: string): Statement {
	let dbCache = STMT_CACHE.get(db);
	if (!dbCache) {
		dbCache = new Map();
		STMT_CACHE.set(db, dbCache);
	}
	let stmt = dbCache.get(sql);
	if (!stmt) {
		stmt = db.prepare(sql);
		dbCache.set(sql, stmt);
	}
	return stmt;
}

const SQL_PART_CACHE = new Map<string, string>();
function getValuesSql(row: string, count: number): string {
	const key = `${row}:${count}`;
	let sql = SQL_PART_CACHE.get(key);
	if (!sql) {
		sql = Array.from({ length: count }, () => row).join(",");
		SQL_PART_CACHE.set(key, sql);
	}
	return sql;
}

/** Cache the database path and its existence to avoid redundant syscalls. */
let lastCheckedPath: string | null = null;
let dbExists = false;

function checkMemoryDbExists(): boolean {
	const path = getMemoryDbPath();
	if (path !== lastCheckedPath) {
		lastCheckedPath = path;
		dbExists = existsSync(path);
	}
	return dbExists;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMemoryCandidate {
	readonly id: string;
	readonly effScore: number;
	readonly source: "effective" | "fts_only" | "ka_traversal" | "ka_traversal_pinned" | "exploration";
	readonly predictorScore?: number | null;
	readonly predictorRank?: number | null;
	readonly finalScore?: number;
	readonly entitySlot?: number;
	readonly aspectSlot?: number;
	readonly isConstraint?: number;
	readonly structuralDensity?: number;
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
 * stay safely within SQLite's parameter limits.
 */
export function recordSessionCandidates(
	sessionKey: string | undefined,
	candidates: ReadonlyArray<SessionMemoryCandidate>,
	injectedIds: ReadonlySet<string>,
): void {
	if (!sessionKey || candidates.length === 0 || !checkMemoryDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			// Optimization: use larger chunk size to reduce Bun->SQLite bridge calls.
			// 100 candidates * 15 parameters = 1500 parameters (safe for Bun:SQLite).
			const CHUNK_SIZE = 100;
			const ROW = "(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)";
			const BASE_SQL = `INSERT OR IGNORE INTO session_memories
					 (id, session_key, memory_id, source, effective_score,
					  predictor_score, final_score, rank, was_injected,
					  fts_hit_count, created_at,
					  entity_slot, aspect_slot, is_constraint, structural_density,
					  predictor_rank)
					 VALUES `;

			let rank = 0;
			for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
				const currentChunkSize = Math.min(CHUNK_SIZE, candidates.length - i);

				// Use cached statement and pre-computed values SQL to avoid overhead.
				const sql = BASE_SQL + getValuesSql(ROW, currentChunkSize);
				const stmt = getCachedStatement(db, sql);

				// Optimization: Pre-allocate array to reduce garbage collection pressure.
				const values = new Array(currentChunkSize * 15);
				for (let j = 0; j < currentChunkSize; j++) {
					const c = candidates[i + j];
					const wasInjected = injectedIds.has(c.id) ? 1 : 0;
					const finalScore = c.finalScore ?? c.effScore;
					// Optimization: Deterministic IDs are faster than randomUUID and provide idempotency.
					const id = `${sessionKey}:${c.id}`;

					const offset = j * 15;
					values[offset] = id;
					values[offset + 1] = sessionKey;
					values[offset + 2] = c.id;
					values[offset + 3] = c.source;
					values[offset + 4] = c.effScore;
					values[offset + 5] = c.predictorScore ?? null;
					values[offset + 6] = finalScore;
					values[offset + 7] = rank++;
					values[offset + 8] = wasInjected;
					values[offset + 9] = now;
					values[offset + 10] = c.entitySlot ?? null;
					values[offset + 11] = c.aspectSlot ?? null;
					values[offset + 12] = c.isConstraint ?? 0;
					values[offset + 13] = c.structuralDensity ?? null;
					values[offset + 14] = c.predictorRank ?? null;
				}

				stmt.run(...values);
			}
		});

		logger.debug("session-memories", "Recorded session candidates", {
			sessionKey,
			total: candidates.length,
			injected: injectedIds.size,
		});
	} catch (e) {
		// Non-fatal — don't break session start for recording failures
		logger.warn("session-memories", "Failed to record candidates", {
			error: e instanceof Error ? e.message : String(e),
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
	if (!sessionKey || matchedIds.length === 0 || !checkMemoryDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			const CHUNK_SIZE = 50;
			// Each row contributes 4 params: id, session_key, memory_id, created_at
			const ROW = "(?, ?, ?, 'fts_only', 0, 0, 0, 0, 1, ?)";
			const BASE_SQL = `INSERT INTO session_memories
				 (id, session_key, memory_id, source, effective_score,
				  final_score, rank, was_injected, fts_hit_count, created_at)
				 VALUES `;
			const CONFLICT_CLAUSE = `
				 ON CONFLICT(session_key, memory_id) DO UPDATE SET
				  fts_hit_count = fts_hit_count + 1`;

			for (let i = 0; i < matchedIds.length; i += CHUNK_SIZE) {
				const currentChunkSize = Math.min(CHUNK_SIZE, matchedIds.length - i);

				const sql = BASE_SQL + getValuesSql(ROW, currentChunkSize) + CONFLICT_CLAUSE;
				const stmt = getCachedStatement(db, sql);

				// Optimization: Pre-allocate array to reduce garbage collection pressure.
				const values = new Array(currentChunkSize * 4);
				for (let j = 0; j < currentChunkSize; j++) {
					const id = matchedIds[i + j];
					const rowId = `${sessionKey}:${id}`;
					const offset = j * 4;
					values[offset] = rowId;
					values[offset + 1] = sessionKey;
					values[offset + 2] = id;
					values[offset + 3] = now;
				}

				stmt.run(...values);
			}
		});
	} catch (e) {
		logger.warn("session-memories", "Failed to track FTS hits", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ---------------------------------------------------------------------------
// Agent relevance feedback
// ---------------------------------------------------------------------------

/**
 * Validate and clamp a raw feedback object. Returns a clean map of
 * memory IDs to scores in [-1, 1], or null if the input is invalid.
 */
export function parseFeedback(raw: unknown): Record<string, number> | null {
	if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const result: Record<string, number> = {};
	let count = 0;
	for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof key !== "string" || key.length === 0) continue;
		if (typeof val !== "number" || !Number.isFinite(val)) continue;
		result[key] = Math.max(-1, Math.min(1, val));
		count++;
	}
	return count > 0 ? result : null;
}

/**
 * Accumulate agent relevance feedback for session memories.
 *
 * Uses a running mean: for each memory_id in the feedback map,
 * new_score = (old_score * old_count + score) / (old_count + 1).
 * When old_score is NULL (first feedback), the score is used directly.
 *
 * Operates on the inner WriteDb so callers can integrate into an
 * existing transaction. For standalone use, wrap with withWriteTx.
 */
export function recordAgentFeedbackInner(
	db: WriteDb,
	sessionKey: string,
	feedback: Readonly<Record<string, number>>,
): void {
	// Single-row UPDATE with running mean calculation.
	// CASE handles NULL (first feedback) vs existing score.
	const stmt = db.prepare(`
		UPDATE session_memories
		SET agent_relevance_score = CASE
				WHEN agent_relevance_score IS NULL THEN ?
				ELSE (agent_relevance_score * agent_feedback_count + ?) / (agent_feedback_count + 1)
			END,
			agent_feedback_count = COALESCE(agent_feedback_count, 0) + 1
		WHERE session_key = ? AND memory_id = ?
	`);

	for (const [memoryId, score] of Object.entries(feedback)) {
		stmt.run(score, score, sessionKey, memoryId);
	}
}

/**
 * Public entry point: accumulate agent relevance feedback for a session.
 * Fail-open — logs warnings but never throws.
 */
export function recordAgentFeedback(sessionKey: string | undefined, feedback: Readonly<Record<string, number>>): void {
	if (!sessionKey || Object.keys(feedback).length === 0 || !checkMemoryDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			recordAgentFeedbackInner(db, sessionKey, feedback);
		});

		logger.debug("session-memories", "Recorded agent feedback", {
			sessionKey,
			memoryCount: Object.keys(feedback).length,
		});
	} catch (e) {
		logger.warn("session-memories", "Failed to record agent feedback", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

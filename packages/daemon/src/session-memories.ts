/**
 * Session memory candidate recording and FTS hit tracking.
 *
 * Records which memories were considered and injected at session start,
 * and tracks FTS hits during user prompt handling. This data feeds
 * the continuity scorer and (eventually) the predictive memory scorer.
 *
 * Performance optimizations:
 * - Statement caching via WeakMap (reduces SQL re-parsing by SQLite)
 * - SQL fragment memoization (avoids redundant string builds)
 * - Path and existence caching (skips redundant homedir/existsSync syscalls)
 * - Parameter pre-allocation (minimizes array resizing in hot loops)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDbAccessor, type WriteDb } from "./db-accessor";
import { logger } from "./logger";

/** Cache for prepared SQLite statements keyed by the database instance. */
const STMT_CACHE = new WeakMap<object, Map<string, any>>();

/** Cache for repetitive SQL fragments (e.g. multi-row VALUES clauses). */
const SQL_PART_CACHE = new Map<string, string>();

const CHUNK_SIZE = 50;

const CANDIDATE_ROW_TEMPLATE = "(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)";
const CANDIDATE_BASE_SQL =
	"INSERT OR IGNORE INTO session_memories (id, session_key, memory_id, source, effective_score, predictor_score, final_score, rank, was_injected, fts_hit_count, created_at, entity_slot, aspect_slot, is_constraint, structural_density, predictor_rank) VALUES ";

const FTS_ROW_TEMPLATE = "(?, ?, ?, 'fts_only', 0, 0, 0, 0, 1, ?)";
const FTS_BASE_SQL =
	"INSERT INTO session_memories (id, session_key, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at) VALUES ";
const FTS_CONFLICT_CLAUSE =
	" ON CONFLICT(session_key, memory_id) DO UPDATE SET fts_hit_count = fts_hit_count + 1";

let lastSignetPath: string | undefined = undefined;
let cachedMemoryDbPath: string | undefined = undefined;
let cachedDbExists = false;

function getMemoryDbPath(): string {
	const currentPath = process.env.SIGNET_PATH;
	if (currentPath !== lastSignetPath || !cachedMemoryDbPath) {
		lastSignetPath = currentPath;
		const agentsDir = currentPath || join(homedir(), ".agents");
		cachedMemoryDbPath = join(agentsDir, "memory", "memories.db");
		cachedDbExists = false;
	}
	return cachedMemoryDbPath;
}

/**
 * Get a prepared statement from the cache or compile a new one.
 */
function getCachedStmt(db: WriteDb, sql: string): any {
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

/**
 * Get a multi-row VALUES fragment from the cache or build a new one.
 */
function getValuesFragment(rowTemplate: string, count: number): string {
	const key = `${rowTemplate}:${count}`;
	let fragment = SQL_PART_CACHE.get(key);
	if (!fragment) {
		fragment = Array.from({ length: count }, () => rowTemplate).join(",");
		SQL_PART_CACHE.set(key, fragment);
	}
	return fragment;
}

/**
 * Check if the memory database exists. Caches the positive result to
 * avoid redundant filesystem syscalls on hot paths.
 */
function checkDbExists(): boolean {
	if (cachedDbExists) return true;
	cachedDbExists = existsSync(getMemoryDbPath());
	return cachedDbExists;
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
	if (!sessionKey || candidates.length === 0 || !checkDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			let rank = 0;

			for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
				const chunk = candidates.slice(i, i + CHUNK_SIZE);
				const sql = CANDIDATE_BASE_SQL + getValuesFragment(CANDIDATE_ROW_TEMPLATE, chunk.length);
				const stmt = getCachedStmt(db, sql);

				const values: any[] = new Array(chunk.length * 15);
				for (let j = 0; j < chunk.length; j++) {
					const c = chunk[j];
					const wasInjected = injectedIds.has(c.id) ? 1 : 0;
					const finalScore = c.finalScore ?? c.effScore;
					const offset = j * 15;

					values[offset] = crypto.randomUUID();
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
	if (!sessionKey || matchedIds.length === 0 || !checkDbExists()) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();

			for (let i = 0; i < matchedIds.length; i += CHUNK_SIZE) {
				const chunk = matchedIds.slice(i, i + CHUNK_SIZE);
				const sql = FTS_BASE_SQL + getValuesFragment(FTS_ROW_TEMPLATE, chunk.length) + FTS_CONFLICT_CLAUSE;
				const stmt = getCachedStmt(db, sql);

				const values: any[] = new Array(chunk.length * 4);
				for (let j = 0; j < chunk.length; j++) {
					const offset = j * 4;
					values[offset] = crypto.randomUUID();
					values[offset + 1] = sessionKey;
					values[offset + 2] = chunk[j];
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
export function parseFeedback(
	raw: unknown,
): Record<string, number> | null {
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
export function recordAgentFeedback(
	sessionKey: string | undefined,
	feedback: Readonly<Record<string, number>>,
): void {
	if (!sessionKey || Object.keys(feedback).length === 0 || !checkDbExists()) return;

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

/**
 * Session memory candidate recording and FTS hit tracking.
 *
 * Records which memories were considered and injected at session start,
 * and tracks FTS hits during user prompt handling. This data feeds
 * the continuity scorer and (eventually) the predictive memory scorer.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDbAccessor, type WriteDb } from "./db-accessor";
import { logger } from "./logger";

function getMemoryDbPath(): string {
	const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
	return join(agentsDir, "memory", "memories.db");
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
	if (!sessionKey || candidates.length === 0 || !existsSync(getMemoryDbPath())) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			const CHUNK_SIZE = 50;
			const ROW = "(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)";
			const BASE_SQL = `INSERT OR IGNORE INTO session_memories
					 (id, session_key, memory_id, source, effective_score,
					  predictor_score, final_score, rank, was_injected,
					  fts_hit_count, created_at,
					  entity_slot, aspect_slot, is_constraint, structural_density,
					  predictor_rank)
					 VALUES `;

			// Pre-compile the full-chunk statement once to avoid recompiling
			// identical SQL on every iteration of the loop.
			const fullChunkStmt =
				candidates.length >= CHUNK_SIZE
					? db.prepare(BASE_SQL + Array.from({ length: CHUNK_SIZE }, () => ROW).join(","))
					: null;

			let rank = 0;
			for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
				const chunk = candidates.slice(i, i + CHUNK_SIZE);

				// Reuse pre-compiled statement for full chunks; compile once for
				// the remainder chunk (different SQL, can't reuse).
				const stmt =
					chunk.length === CHUNK_SIZE
						? fullChunkStmt!
						: db.prepare(BASE_SQL + Array.from({ length: chunk.length }, () => ROW).join(","));

				const values: unknown[] = [];
				for (const c of chunk) {
					const wasInjected = injectedIds.has(c.id) ? 1 : 0;
					const finalScore = c.finalScore ?? c.effScore;
					values.push(
						crypto.randomUUID(),
						sessionKey,
						c.id,
						c.source,
						c.effScore,
						c.predictorScore ?? null,
						finalScore,
						rank++,
						wasInjected,
						now,
						c.entitySlot ?? null,
						c.aspectSlot ?? null,
						c.isConstraint ?? 0,
						c.structuralDensity ?? null,
						c.predictorRank ?? null,
					);
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
	if (!sessionKey || matchedIds.length === 0 || !existsSync(getMemoryDbPath())) return;

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

			// Pre-compile the full-chunk UPSERT statement once to avoid
			// recompiling identical SQL for every batch of 50.
			const fullChunkStmt =
				matchedIds.length >= CHUNK_SIZE
					? db.prepare(
							BASE_SQL +
								Array.from({ length: CHUNK_SIZE }, () => ROW).join(",") +
								CONFLICT_CLAUSE,
						)
					: null;

			for (let i = 0; i < matchedIds.length; i += CHUNK_SIZE) {
				const chunk = matchedIds.slice(i, i + CHUNK_SIZE);

				const stmt =
					chunk.length === CHUNK_SIZE
						? fullChunkStmt!
						: db.prepare(
								BASE_SQL +
									Array.from({ length: chunk.length }, () => ROW).join(",") +
									CONFLICT_CLAUSE,
							);

				const values: unknown[] = [];
				for (const id of chunk) {
					values.push(crypto.randomUUID(), sessionKey, id, now);
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
	if (!sessionKey || Object.keys(feedback).length === 0 || !existsSync(getMemoryDbPath())) return;

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

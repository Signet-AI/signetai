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
import { getDbAccessor } from "./db-accessor";
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
	readonly source: "effective" | "fts_only";
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Batch-insert all candidate memories for a session. Candidates that
 * were actually injected get was_injected=1; the rest get 0.
 * Safe to call with an empty candidates array (no-op).
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
			const stmt = db.prepare(
				`INSERT OR IGNORE INTO session_memories
				 (id, session_key, memory_id, source, effective_score,
				  final_score, rank, was_injected, fts_hit_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
			);

			let rank = 0;
			for (const c of candidates) {
				const wasInjected = injectedIds.has(c.id) ? 1 : 0;
				stmt.run(
					crypto.randomUUID(),
					sessionKey,
					c.id,
					c.source,
					c.effScore,
					c.effScore, // final_score = effective_score until predictor exists
					rank++,
					wasInjected,
					now,
				);
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
 */
export function trackFtsHits(
	sessionKey: string | undefined,
	matchedIds: ReadonlyArray<string>,
): void {
	if (!sessionKey || matchedIds.length === 0 || !existsSync(getMemoryDbPath())) return;

	try {
		getDbAccessor().withWriteTx((db) => {
			const now = new Date().toISOString();
			const updateStmt = db.prepare(
				`UPDATE session_memories
				 SET fts_hit_count = fts_hit_count + 1
				 WHERE session_key = ? AND memory_id = ?`,
			);
			const insertStmt = db.prepare(
				`INSERT OR IGNORE INTO session_memories
				 (id, session_key, memory_id, source, effective_score,
				  final_score, rank, was_injected, fts_hit_count, created_at)
				 VALUES (?, ?, ?, 'fts_only', 0, 0, 0, 0, 1, ?)`,
			);

			for (const id of matchedIds) {
				updateStmt.run(sessionKey, id);
				// INSERT OR IGNORE is a no-op if the row already exists
				insertStmt.run(crypto.randomUUID(), sessionKey, id, now);
			}
		});
	} catch (e) {
		logger.warn("session-memories", "Failed to track FTS hits", {
			error: (e as Error).message,
		});
	}
}

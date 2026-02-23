/**
 * Session Continuity Scoring — Phase 2 Task 2.3
 *
 * Tracks how effectively injected memories carry over across sessions.
 * A high continuity score means the agent re-uses its stored knowledge
 * rather than re-asking questions it already has answers for.
 *
 * Score formula:
 *   carryOver = used / max(1, injected)
 *   reconstructionRate = reconstructed / max(1, used + reconstructed)
 *   continuityScore = carryOver * (1 - reconstructionRate)
 *
 * A score of 1.0 means perfect continuity: every injected memory was
 * used and nothing had to be re-asked. A score near 0 means the agent
 * is not leveraging its memory at all.
 */

// Re-use the lightweight MigrationDb interface (exec + prepare)
import type { MigrationDb } from "./migrations/index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMetricsInput {
	sessionId: string;
	harness?: string;
	memoriesInjected: number;
	memoriesUsed: number;
	factsReconstructed: number;
	newMemories: number;
}

export interface SessionMetricsRecord {
	id: string;
	sessionId: string;
	harness: string | null;
	memoriesInjected: number;
	memoriesUsed: number;
	factsReconstructed: number;
	newMemories: number;
	continuityScore: number;
	createdAt: string;
}

export interface SessionTrend {
	sessions: SessionMetricsRecord[];
	averageScore: number;
	direction: "improving" | "declining" | "stable" | "insufficient";
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute a continuity score (0.0 – 1.0) from raw session counts.
 *
 * carryOver: fraction of injected memories that were actually used.
 * reconstructionPenalty: fraction of knowledge that had to be re-asked
 *   instead of being recalled from memory.
 */
export function computeContinuityScore(
	injected: number,
	used: number,
	reconstructed: number,
): number {
	const carryOver = used / Math.max(1, injected);
	const reconstructionRate =
		reconstructed / Math.max(1, used + reconstructed);
	const score = carryOver * (1 - reconstructionRate);
	// Clamp to [0, 1]
	return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Record metrics for a completed session.
 * Returns the generated row id.
 */
export function recordSessionMetrics(
	db: MigrationDb,
	metrics: SessionMetricsInput,
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const score = computeContinuityScore(
		metrics.memoriesInjected,
		metrics.memoriesUsed,
		metrics.factsReconstructed,
	);

	db.prepare(
		`INSERT INTO session_metrics
		 (id, session_id, harness, memories_injected, memories_used,
		  facts_reconstructed, new_memories, continuity_score, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		metrics.sessionId,
		metrics.harness ?? null,
		metrics.memoriesInjected,
		metrics.memoriesUsed,
		metrics.factsReconstructed,
		metrics.newMemories,
		score,
		now,
	);

	return id;
}

/**
 * Get the continuity score trend over the last N sessions.
 * Returns records in reverse-chronological order plus trend analysis.
 */
export function getSessionTrend(
	db: MigrationDb,
	limit: number = 20,
): SessionTrend {
	const rows = db
		.prepare(
			`SELECT * FROM session_metrics
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.all(limit) as Array<Record<string, unknown>>;

	const sessions: SessionMetricsRecord[] = rows.map(rowToSessionMetrics);

	if (sessions.length === 0) {
		return { sessions, averageScore: 0, direction: "insufficient" };
	}

	const averageScore =
		sessions.reduce((sum, s) => sum + s.continuityScore, 0) /
		sessions.length;

	let direction: SessionTrend["direction"];

	if (sessions.length < 3) {
		direction = "insufficient";
	} else {
		// Compare average of first half (newer) vs second half (older)
		const mid = Math.floor(sessions.length / 2);
		const recentAvg =
			sessions.slice(0, mid).reduce((s, r) => s + r.continuityScore, 0) /
			mid;
		const olderAvg =
			sessions.slice(mid).reduce((s, r) => s + r.continuityScore, 0) /
			(sessions.length - mid);

		const delta = recentAvg - olderAvg;

		if (delta > 0.05) {
			direction = "improving";
		} else if (delta < -0.05) {
			direction = "declining";
		} else {
			direction = "stable";
		}
	}

	return { sessions, averageScore, direction };
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToSessionMetrics(
	row: Record<string, unknown>,
): SessionMetricsRecord {
	return {
		id: row.id as string,
		sessionId: row.session_id as string,
		harness: (row.harness as string) ?? null,
		memoriesInjected: row.memories_injected as number,
		memoriesUsed: row.memories_used as number,
		factsReconstructed: row.facts_reconstructed as number,
		newMemories: row.new_memories as number,
		continuityScore: row.continuity_score as number,
		createdAt: row.created_at as string,
	};
}

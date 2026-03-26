/**
 * Session-end predictor comparison logic (Sprint 3).
 *
 * After the continuity scorer produces per-memory relevance scores,
 * this module compares predictor vs baseline rankings using NDCG@10.
 * Results feed the success rate EMA, which adjusts alpha (predictor
 * influence), and triggers retraining when enough data accumulates.
 */

import type { PredictorConfig } from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { countComparisonsSince, getRecentComparisons, recordComparison } from "./predictor-comparisons";
import { getAlphaFloor, getPredictorState, updatePredictorState } from "./predictor-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComparisonResult {
	readonly sessionKey: string;
	readonly predictorNdcg: number;
	readonly baselineNdcg: number;
	readonly predictorWon: boolean;
	readonly margin: number;
	readonly scorerConfidence: number;
	readonly ftsOverlapScore: number;
	readonly candidateCount: number;
	readonly traversalCount: number;
	readonly constraintCount: number;
	readonly predictorTopIds: ReadonlyArray<string>;
	readonly baselineTopIds: ReadonlyArray<string>;
	readonly relevanceScores: Readonly<Record<string, number>>;
	readonly hasPredictorScores: boolean;
	readonly project: string | null;
	readonly focalEntityId: string | null;
	readonly focalEntityName: string | null;
}

interface SessionMemoryRow {
	readonly memory_id: string;
	readonly source: string;
	readonly effective_score: number | null;
	readonly predictor_score: number | null;
	readonly was_injected: number;
	readonly relevance_score: number | null;
	readonly fts_hit_count: number;
	readonly entity_slot: number | null;
	readonly is_constraint: number;
}

interface SessionScoreRow {
	readonly score: number;
	readonly confidence: number | null;
	readonly project: string | null;
}

// ---------------------------------------------------------------------------
// NDCG@k computation
// ---------------------------------------------------------------------------

/**
 * Compute NDCG@k for a given ranking against relevance scores.
 *
 * DCG  = sum(relevance[i] / log2(i + 2)) for i in 0..k-1
 * IDCG = same formula with relevances sorted descending (ideal ranking)
 * NDCG = DCG / IDCG (returns 0 if IDCG is 0)
 */
export function computeNdcg(
	ranking: ReadonlyArray<string>,
	relevanceScores: ReadonlyMap<string, number>,
	k: number,
): number {
	const topK = ranking.slice(0, k);

	// DCG for actual ranking
	let dcg = 0;
	for (let i = 0; i < topK.length; i++) {
		const rel = relevanceScores.get(topK[i]) ?? 0;
		dcg += rel / Math.log2(i + 2);
	}

	// IDCG: sort all relevance scores descending and compute best possible DCG
	const allRelevances = [...relevanceScores.values()].sort((a, b) => b - a);
	let idcg = 0;
	const idcgK = Math.min(k, allRelevances.length);
	for (let i = 0; i < idcgK; i++) {
		idcg += allRelevances[i] / Math.log2(i + 2);
	}

	if (idcg === 0) return 0;
	return dcg / idcg;
}

// ---------------------------------------------------------------------------
// FTS overlap score
// ---------------------------------------------------------------------------

/**
 * Of the injected memories, what fraction had FTS hits during the session?
 */
export function computeFtsOverlapScore(
	sessionMemories: ReadonlyArray<SessionMemoryRow>,
	injectedIds: ReadonlySet<string>,
): number {
	if (injectedIds.size === 0) return 0;

	let injectedWithFts = 0;
	for (const mem of sessionMemories) {
		if (injectedIds.has(mem.memory_id) && mem.fts_hit_count > 0) {
			injectedWithFts++;
		}
	}

	return injectedWithFts / injectedIds.size;
}

// ---------------------------------------------------------------------------
// Session comparison orchestrator
// ---------------------------------------------------------------------------

/**
 * Main comparison logic. Reads session data, computes NDCG@10 for both
 * predictor and baseline rankings, and returns a ComparisonResult.
 *
 * Returns null if there's insufficient data to compare (e.g. no
 * session_memories or no session_scores).
 */
export function runSessionComparison(
	sessionKey: string,
	agentId: string,
	accessor: DbAccessor,
): ComparisonResult | null {
	// Step 1: Read session_scores for continuity confidence
	const sessionScore = accessor.withReadDb((db) => {
		try {
			return db
				.prepare(
					`SELECT score, confidence, project
					 FROM session_scores
					 WHERE session_key = ? AND agent_id = ?
					 ORDER BY created_at DESC
					 LIMIT 1`,
				)
				.get(sessionKey, agentId) as SessionScoreRow | undefined;
		} catch {
			return db
				.prepare(
					`SELECT score, confidence, project
					 FROM session_scores
					 WHERE session_key = ?
					 ORDER BY created_at DESC
					 LIMIT 1`,
				)
				.get(sessionKey) as SessionScoreRow | undefined;
		}
	});

	if (!sessionScore) {
		logger.debug("predictor", "No session score found, skipping comparison", {
			sessionKey,
		});
		return null;
	}

	// Step 2: Read session_memories with relevance scores
	const sessionMemories = accessor.withReadDb((db) => {
		return db
			.prepare(
				`SELECT memory_id, source, effective_score, predictor_score,
				        was_injected, relevance_score, fts_hit_count,
				        entity_slot, is_constraint
				 FROM session_memories
				 WHERE session_key = ?
				   AND agent_id = ?`,
			)
			.all(sessionKey, agentId) as ReadonlyArray<SessionMemoryRow>;
	});

	if (sessionMemories.length === 0) {
		logger.debug("predictor", "No session memories found, skipping comparison", {
			sessionKey,
		});
		return null;
	}

	// Step 3: Build relevance map from session_memories
	const relevanceMap = new Map<string, number>();
	for (const mem of sessionMemories) {
		if (mem.relevance_score !== null) {
			relevanceMap.set(mem.memory_id, mem.relevance_score);
		}
	}

	// Step 4: Build rankings
	// Baseline: sorted by effective_score DESC
	const baselineOrdering = [...sessionMemories]
		.filter((m) => m.effective_score !== null)
		.sort((a, b) => (b.effective_score ?? 0) - (a.effective_score ?? 0))
		.map((m) => m.memory_id);

	// Check if predictor scores exist
	const hasPredictorScores = sessionMemories.some((m) => m.predictor_score !== null);

	// Predictor: sorted by predictor_score DESC
	const predictorOrdering = hasPredictorScores
		? [...sessionMemories]
				.filter((m) => m.predictor_score !== null)
				.sort((a, b) => (b.predictor_score ?? 0) - (a.predictor_score ?? 0))
				.map((m) => m.memory_id)
		: [];

	// Step 5: Compute NDCG@10
	const baselineNdcg = computeNdcg(baselineOrdering, relevanceMap, 10);
	const predictorNdcg = hasPredictorScores ? computeNdcg(predictorOrdering, relevanceMap, 10) : 0;

	// Step 6: FTS overlap
	const injectedIds = new Set<string>();
	for (const mem of sessionMemories) {
		if (mem.was_injected === 1) {
			injectedIds.add(mem.memory_id);
		}
	}
	const ftsOverlapScore = computeFtsOverlapScore(sessionMemories, injectedIds);

	// Step 7: Count structural metadata
	let traversalCount = 0;
	let constraintCount = 0;
	for (const mem of sessionMemories) {
		if (mem.entity_slot !== null) traversalCount++;
		if (mem.is_constraint === 1) constraintCount++;
	}

	// Step 8: Determine winner
	const predictorWon = hasPredictorScores && predictorNdcg > baselineNdcg;
	const margin = hasPredictorScores ? predictorNdcg - baselineNdcg : 0;

	const confidence = sessionScore.confidence ?? 0;

	// Build serializable relevance scores
	const relevanceObj: Record<string, number> = {};
	for (const [k, v] of relevanceMap) {
		relevanceObj[k] = v;
	}

	return {
		sessionKey,
		predictorNdcg,
		baselineNdcg,
		predictorWon,
		margin,
		scorerConfidence: confidence,
		ftsOverlapScore,
		candidateCount: sessionMemories.length,
		traversalCount,
		constraintCount,
		predictorTopIds: predictorOrdering.slice(0, 10),
		baselineTopIds: baselineOrdering.slice(0, 10),
		relevanceScores: relevanceObj,
		hasPredictorScores,
		project: sessionScore.project ?? null,
		focalEntityId: null, // TODO: resolve from session data
		focalEntityName: null,
	};
}

// ---------------------------------------------------------------------------
// EMA update
// ---------------------------------------------------------------------------

/** Minimum confidence threshold for EMA updates. */
const MIN_CONFIDENCE_FOR_EMA = 0.6;

/** EMA smoothing factor. */
const EMA_ALPHA = 0.1;

/**
 * Update the success rate EMA based on a session comparison result.
 * Only updates if the continuity scorer had sufficient confidence.
 */
export function updateSuccessRate(agentId: string, sessionWin: boolean, confidence: number): boolean {
	if (confidence < MIN_CONFIDENCE_FOR_EMA) {
		logger.debug("predictor", "Confidence too low for EMA update", {
			confidence,
			threshold: MIN_CONFIDENCE_FOR_EMA,
		});
		return false;
	}

	const state = getPredictorState(agentId);
	const newRate = EMA_ALPHA * (sessionWin ? 1 : 0) + (1 - EMA_ALPHA) * state.successRate;

	// Alpha = 1 - successRate, but respect floor
	const floor = getAlphaFloor(state.sessionsAfterColdStart);
	const newAlpha = Math.max(floor, 1.0 - newRate);

	updatePredictorState(agentId, {
		successRate: newRate,
		alpha: newAlpha,
		lastComparisonAt: new Date().toISOString(),
	});

	logger.info("predictor", "Updated success rate EMA", {
		agentId,
		win: sessionWin,
		newRate,
		newAlpha,
	});

	return true;
}

// ---------------------------------------------------------------------------
// Record comparison to DB
// ---------------------------------------------------------------------------

/**
 * Persist a comparison result into the predictor_comparisons table.
 */
export function saveComparison(comparison: ComparisonResult, agentId: string, accessor: DbAccessor): void {
	const state = getPredictorState(agentId);

	recordComparison(accessor, {
		sessionKey: comparison.sessionKey,
		agentId,
		predictorNdcg: comparison.predictorNdcg,
		baselineNdcg: comparison.baselineNdcg,
		predictorWon: comparison.predictorWon,
		margin: comparison.margin,
		alpha: state.alpha,
		emaUpdated: comparison.scorerConfidence >= MIN_CONFIDENCE_FOR_EMA,
		focalEntityId: comparison.focalEntityId ?? undefined,
		focalEntityName: comparison.focalEntityName ?? undefined,
		project: comparison.project ?? undefined,
		candidateCount: comparison.candidateCount,
		traversalCount: comparison.traversalCount,
		constraintCount: comparison.constraintCount,
		scorerConfidence: comparison.scorerConfidence,
		successRate: state.successRate,
		predictorTopIds: comparison.predictorTopIds,
		baselineTopIds: comparison.baselineTopIds,
		relevanceScores: comparison.relevanceScores,
		ftsOverlapScore: comparison.ftsOverlapScore,
	});
}

// ---------------------------------------------------------------------------
// Training trigger
// ---------------------------------------------------------------------------

/**
 * Should retraining be triggered based on comparison count?
 * Returns true if enough comparisons have accumulated since last training.
 */
export function shouldTriggerTraining(agentId: string, config: PredictorConfig, accessor: DbAccessor): boolean {
	const state = getPredictorState(agentId);
	const count = countComparisonsSince(accessor, agentId, state.lastTrainingAt);
	return count >= config.trainIntervalSessions;
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

export interface DriftResult {
	readonly drifting: boolean;
	readonly recentWinRate: number;
	readonly windowSize: number;
}

/** Win rate threshold below which we flag drift. */
const DRIFT_WIN_RATE_THRESHOLD = 0.3;

/**
 * Detect predictor drift by examining the recent win rate over a window
 * of comparisons. If win rate drops below 0.3, flags drifting.
 */
export function detectDrift(agentId: string, accessor: DbAccessor, windowSize: number): DriftResult {
	const recent = getRecentComparisons(accessor, agentId, windowSize);

	if (recent.length === 0) {
		return { drifting: false, recentWinRate: 0, windowSize };
	}

	const wins = recent.filter((r) => r.predictorWon).length;
	const recentWinRate = wins / recent.length;

	return {
		drifting: recent.length >= windowSize && recentWinRate < DRIFT_WIN_RATE_THRESHOLD,
		recentWinRate,
		windowSize,
	};
}

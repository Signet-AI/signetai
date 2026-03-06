/**
 * Predictor scoring integration for session-start memory injection.
 *
 * Implements:
 * - Context embedding assembly (mean-pool of top candidate embeddings)
 * - Reciprocal Rank Fusion (RRF) of baseline + predictor rankings
 * - Topic diversity decay (cosine similarity based)
 * - Exploration sampling (epsilon-greedy on rank disagreement)
 * - Predictor status line for session-start output
 */

import type { PredictorConfig } from "@signet/core";
import type { ReadDb, DbAccessor } from "./db-accessor";
import type { PredictorClient, PredictorStatus, ScoreParams } from "./predictor-client";
import type { PredictorState } from "./predictor-state";
import { computeEffectiveAlpha } from "./predictor-state";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankedCandidate {
	readonly id: string;
	readonly baselineRank: number;
	readonly baselineScore: number;
	readonly predictorRank: number | null;
	readonly predictorScore: number | null;
	readonly fusedScore: number;
	readonly source: CandidateSource | "both" | "exploration";
	readonly embedding: ReadonlyArray<number> | null;
}

export interface ScoringResult {
	readonly candidates: ReadonlyArray<RankedCandidate>;
	readonly predictorUsed: boolean;
	readonly alpha: number;
	readonly exploredId: string | null;
	readonly predictorStatus: PredictorStatus | null;
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

function blobToVector(buf: Uint8Array): ReadonlyArray<number> {
	const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const f32 = new Float32Array(raw);
	return Array.from(f32);
}

/**
 * Load embedding vectors for a set of memory IDs from the embeddings table.
 * Returns a map from memory_id -> vector. Missing embeddings are omitted.
 */
export function loadEmbeddings(
	accessor: DbAccessor,
	memoryIds: ReadonlyArray<string>,
): Map<string, ReadonlyArray<number>> {
	if (memoryIds.length === 0) return new Map();

	return accessor.withReadDb((db) => {
		const result = new Map<string, ReadonlyArray<number>>();
		const placeholders = memoryIds.map(() => "?").join(", ");
		const rows = db
			.prepare(
				`SELECT source_id, vector FROM embeddings
				 WHERE source_type = 'memory'
				   AND source_id IN (${placeholders})`,
			)
			.all(...memoryIds) as ReadonlyArray<{
			source_id: string;
			vector: Uint8Array;
		}>;

		for (const row of rows) {
			if (row.vector) {
				result.set(row.source_id, blobToVector(row.vector));
			}
		}
		return result;
	});
}

/**
 * Build a context embedding by mean-pooling the top candidate embeddings.
 * Returns null if no embeddings are available.
 */
export function buildContextEmbedding(
	accessor: DbAccessor,
	candidateIds: ReadonlyArray<string>,
	limit: number,
): ReadonlyArray<number> | null {
	const topIds = candidateIds.slice(0, limit);
	const embeddings = loadEmbeddings(accessor, topIds);

	if (embeddings.size === 0) return null;

	// Mean-pool all available vectors
	let dims = 0;
	const vectors: ReadonlyArray<number>[] = [];
	for (const vec of embeddings.values()) {
		if (dims === 0) dims = vec.length;
		if (vec.length === dims) {
			vectors.push(vec);
		}
	}

	if (vectors.length === 0 || dims === 0) return null;

	const mean = new Array<number>(dims).fill(0);
	for (const vec of vectors) {
		for (let i = 0; i < dims; i++) {
			mean[i] += vec[i];
		}
	}
	const count = vectors.length;
	for (let i = 0; i < dims; i++) {
		mean[i] /= count;
	}
	return mean;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(
	a: ReadonlyArray<number>,
	b: ReadonlyArray<number>,
): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dot / denom;
}

// ---------------------------------------------------------------------------
// RRF Fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion.
 *
 * RRF_score(mem) = alpha / (k + rank_baseline) + (1 - alpha) / (k + rank_predictor)
 *
 * If a memory is missing from one ranker, use rank = candidateCount + 1.
 */
export function rrfFuse(
	baselineRanking: ReadonlyArray<{ readonly id: string; readonly score: number }>,
	predictorRanking: ReadonlyArray<{ readonly id: string; readonly score: number }>,
	alpha: number,
	k: number,
): Map<string, { readonly baselineRank: number; readonly predictorRank: number; readonly fusedScore: number }> {
	const baselineRankById = new Map<string, number>();
	for (let i = 0; i < baselineRanking.length; i++) {
		baselineRankById.set(baselineRanking[i].id, i + 1);
	}

	const predictorRankById = new Map<string, number>();
	for (let i = 0; i < predictorRanking.length; i++) {
		predictorRankById.set(predictorRanking[i].id, i + 1);
	}

	// Union of all IDs
	const allIds = new Set([
		...baselineRanking.map((r) => r.id),
		...predictorRanking.map((r) => r.id),
	]);
	const fallbackRank = allIds.size + 1;

	const result = new Map<
		string,
		{ readonly baselineRank: number; readonly predictorRank: number; readonly fusedScore: number }
	>();

	for (const id of allIds) {
		const bRank = baselineRankById.get(id) ?? fallbackRank;
		const pRank = predictorRankById.get(id) ?? fallbackRank;
		const fused = alpha / (k + bRank) + (1 - alpha) / (k + pRank);
		result.set(id, { baselineRank: bRank, predictorRank: pRank, fusedScore: fused });
	}

	return result;
}

// ---------------------------------------------------------------------------
// Topic Diversity
// ---------------------------------------------------------------------------

/**
 * Apply topic diversity decay to a sorted list of candidates.
 *
 * For each candidate, check cosine similarity against already-selected
 * candidates. If similarity > threshold, apply exponential decay.
 *
 * decay_factor = (1 - floor) * decay^overlap_count + floor
 *
 * Mutates scores in-place on a mutable copy. Returns the adjusted list
 * sorted by adjusted score.
 */
export function applyTopicDiversity(
	candidates: ReadonlyArray<RankedCandidate>,
	embeddingById: ReadonlyMap<string, ReadonlyArray<number>>,
	threshold: number = 0.85,
	decay: number = 0.5,
	floor: number = 0.1,
): ReadonlyArray<RankedCandidate> {
	// Work with mutable copies sorted by fusedScore descending
	const sorted = [...candidates].sort((a, b) => b.fusedScore - a.fusedScore);

	const selected: Array<{ readonly id: string; readonly embedding: ReadonlyArray<number> }> = [];
	const adjusted: Array<RankedCandidate> = [];

	for (const candidate of sorted) {
		const emb = embeddingById.get(candidate.id);
		if (!emb) {
			// No embedding — skip diversity check, keep original score
			adjusted.push(candidate);
			selected.push({ id: candidate.id, embedding: [] });
			continue;
		}

		let overlapCount = 0;
		for (const sel of selected) {
			if (sel.embedding.length === 0) continue;
			const sim = cosineSimilarity(emb, sel.embedding);
			if (sim > threshold) {
				overlapCount++;
			}
		}

		if (overlapCount > 0) {
			const factor = (1 - floor) * Math.pow(decay, overlapCount) + floor;
			adjusted.push({
				...candidate,
				fusedScore: candidate.fusedScore * factor,
			});
		} else {
			adjusted.push(candidate);
		}

		selected.push({ id: candidate.id, embedding: emb });
	}

	// Re-sort by adjusted score
	adjusted.sort((a, b) => b.fusedScore - a.fusedScore);
	return adjusted;
}

// ---------------------------------------------------------------------------
// Exploration Sampling
// ---------------------------------------------------------------------------

/**
 * With probability `explorationRate`, replace the lowest-ranked injected
 * memory with the candidate where predictor and baseline disagree most.
 *
 * Returns the explored memory ID if exploration occurred, null otherwise.
 * Mutates the injected set in-place.
 */
export function maybeExplore(
	candidates: ReadonlyArray<RankedCandidate>,
	injectedIds: Set<string>,
	explorationRate: number,
): string | null {
	if (injectedIds.size === 0) return null;
	if (Math.random() > explorationRate) return null;

	// Find candidate with largest rank disagreement that isn't already injected
	let bestDisagreementId: string | null = null;
	let bestDisagreement = 0;

	for (const c of candidates) {
		if (injectedIds.has(c.id)) continue;
		if (c.predictorRank === null) continue;
		const delta = Math.abs(c.baselineRank - c.predictorRank);
		if (delta > bestDisagreement) {
			bestDisagreement = delta;
			bestDisagreementId = c.id;
		}
	}

	if (bestDisagreementId === null) return null;

	// Find lowest-ranked injected memory
	let lowestId: string | null = null;
	let lowestScore = Number.POSITIVE_INFINITY;
	for (const c of candidates) {
		if (!injectedIds.has(c.id)) continue;
		if (c.fusedScore < lowestScore) {
			lowestScore = c.fusedScore;
			lowestId = c.id;
		}
	}

	if (lowestId === null) return null;

	// Swap
	injectedIds.delete(lowestId);
	injectedIds.add(bestDisagreementId);
	return bestDisagreementId;
}

// ---------------------------------------------------------------------------
// Status Line
// ---------------------------------------------------------------------------

/**
 * Build predictor status line for session-start injection.
 * Single line, near-zero context cost.
 */
export function buildPredictorStatusLine(
	predictorStatus: PredictorStatus | null,
	state: PredictorState,
	config: PredictorConfig | undefined,
): string {
	if (!config?.enabled) {
		return "[predictor: disabled | baseline only]";
	}

	if (predictorStatus === null) {
		return "[predictor: offline | baseline only]";
	}

	if (!state.coldStartExited) {
		const sessionCount = getSessionCount(predictorStatus);
		const minSessions = config.minTrainingSessions;
		return `[predictor: collecting | ${sessionCount}/${minSessions} sessions | baseline only]`;
	}

	const alpha = computeEffectiveAlpha(state);
	const modelLabel = `model_v${predictorStatus.model_version}`;
	return `[predictor: active | α=${alpha.toFixed(2)} | ${modelLabel}]`;
}

function getSessionCount(status: PredictorStatus): number {
	return status.training_pairs;
}

// ---------------------------------------------------------------------------
// Cold Start Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether cold start has been exited.
 *
 * Conditions (all must be met):
 * 1. Predictor has been trained at least once (trained === true)
 * 2. Session count >= minTrainingSessions
 *
 * Condition 3 (success_rate > 0.4 over last 10 comparisons) is deferred
 * to Sprint 3 when session-end comparison logic is implemented.
 */
export function evaluateColdStartExit(
	predictorStatus: PredictorStatus,
	minTrainingSessions: number,
	currentState: PredictorState,
): boolean {
	if (currentState.coldStartExited) return true;
	if (!predictorStatus.trained) return false;
	if (predictorStatus.training_pairs < minTrainingSessions) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Full Scoring Pipeline
// ---------------------------------------------------------------------------

export type CandidateSource = "effective" | "ka_traversal" | "ka_traversal_pinned" | "fts_only";

const DEFAULT_SOURCE: CandidateSource = "effective";

export interface CandidateInput {
	readonly id: string;
	readonly effScore: number;
	readonly source: CandidateSource;
}

export interface PredictorScoringParams {
	readonly candidates: ReadonlyArray<CandidateInput>;
	readonly accessor: DbAccessor | null;
	readonly agentId: string;
	readonly predictorClient: PredictorClient | null;
	readonly config: PredictorConfig | undefined;
	readonly state: PredictorState;
	readonly candidateFeatures: ReadonlyArray<ReadonlyArray<number>> | null;
	readonly project: string | undefined;
}

/**
 * Run the full predictor scoring pipeline:
 *   1. Check predictor availability + cold start
 *   2. Build context embedding
 *   3. Score with predictor sidecar
 *   4. RRF fusion
 *   5. Topic diversity
 *   6. Exploration sampling
 *
 * Returns ranked candidates with fused scores, whether predictor was used,
 * and the exploration ID if applicable.
 */
export async function runPredictorScoring(
	params: PredictorScoringParams,
): Promise<ScoringResult> {
	const {
		candidates,
		accessor,
		agentId,
		predictorClient,
		config,
		state,
		candidateFeatures,
	} = params;

	// Baseline ranking: preserve input order (already sorted by project match + effScore)
	const baselineRanking = candidates.map((c) => ({
		id: c.id,
		score: c.effScore,
	}));

	// Load embeddings for all candidates (needed for context embedding + diversity)
	const allIds = candidates.map((c) => c.id);
	const embeddingById = accessor !== null
		? loadEmbeddings(accessor, allIds)
		: new Map<string, ReadonlyArray<number>>();

	// Default: no predictor
	const alpha = computeEffectiveAlpha(state);
	let predictorScoresMap: Map<string, number> | null = null;
	let predictorUsed = false;
	let fetchedPredictorStatus: PredictorStatus | null = null;

	// Step 1: Check predictor availability (needs accessor for embeddings)
	if (
		config?.enabled &&
		predictorClient !== null &&
		predictorClient.isAlive() &&
		accessor !== null
	) {
		try {
			const predictorStatus = await predictorClient.status();
			fetchedPredictorStatus = predictorStatus;

			if (predictorStatus !== null && predictorStatus.trained) {
				// NOTE: We call the predictor even during cold start (when alpha=1.0
				// gives it zero influence on injection order). This is intentional —
				// predictor scores are recorded in session_memories so Sprint 3 can
				// compute NDCG@10 comparisons at session-end for training feedback.

				// Step 2: Build context embedding
				const topBaselineIds = candidates
					.slice(0, 10)
					.map((c) => c.id);
				const contextEmbedding = buildContextEmbedding(
					accessor,
					topBaselineIds,
					10,
				);

				if (contextEmbedding !== null) {
					// Step 3: Prepare candidate embeddings and score
					const candidateEmbeddings: Array<ReadonlyArray<number> | null> =
						allIds.map((id) => embeddingById.get(id) ?? null);

					const scoreParams: ScoreParams = {
						agent_id: agentId,
						context_embedding: contextEmbedding,
						candidate_ids: allIds,
						candidate_embeddings: candidateEmbeddings,
						candidate_features: candidateFeatures ?? undefined,
					};

					const scoreResult = await predictorClient.score(scoreParams);

					if (scoreResult !== null) {
						predictorScoresMap = new Map<string, number>();
						for (const entry of scoreResult.scores) {
							predictorScoresMap.set(entry.id, entry.score);
						}
						predictorUsed = true;
					}
				}
			}
		} catch (err) {
			// Fail open: predictor errors don't break session start
			logger.debug("predictor", "Predictor scoring failed (non-fatal)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Step 4: RRF fusion (or pure baseline if no predictor)
	let rankedCandidates: RankedCandidate[];

	if (predictorUsed && predictorScoresMap !== null) {
		// Build predictor ranking sorted by predictor score descending
		const predictorEntries = [...predictorScoresMap.entries()].sort(
			(a, b) => b[1] - a[1],
		);
		const predictorRanking = predictorEntries.map(([id, score]) => ({
			id,
			score,
		}));

		const rrfK = config?.rrfK ?? 12;
		const fusedMap = rrfFuse(baselineRanking, predictorRanking, alpha, rrfK);

		// Build source map for quick lookup
		const sourceById = new Map(candidates.map((c) => [c.id, c.source]));

		rankedCandidates = [...fusedMap.entries()].map(
			([id, { baselineRank, predictorRank, fusedScore }]) => ({
				id,
				baselineRank,
				baselineScore:
					baselineRanking.find((r) => r.id === id)?.score ?? 0,
				predictorRank,
				predictorScore: predictorScoresMap?.get(id) ?? null,
				fusedScore,
				source: sourceById.get(id) ?? DEFAULT_SOURCE,
				embedding: embeddingById.get(id) ?? null,
			}),
		);
	} else {
		// Pure baseline: use rank-based fusedScore to preserve input ordering
		// (which includes project-match-first boost from getAllScoredCandidates).
		// A simple 1/(k + rank) ensures the first candidate always sorts highest.
		const sourceById = new Map(candidates.map((c) => [c.id, c.source]));
		const k = config?.rrfK ?? 12;

		rankedCandidates = candidates.map((c, i) => ({
			id: c.id,
			baselineRank: i + 1,
			baselineScore: c.effScore,
			predictorRank: null,
			predictorScore: null,
			fusedScore: 1.0 / (k + i + 1),
			source: sourceById.get(c.id) ?? ("effective" as const),
			embedding: embeddingById.get(c.id) ?? null,
		}));
	}

	// Step 5: Topic diversity decay
	rankedCandidates = [
		...applyTopicDiversity(rankedCandidates, embeddingById),
	];

	// Exploration is done after top-k selection in the caller
	return {
		candidates: rankedCandidates,
		predictorUsed,
		alpha,
		exploredId: null, // Set by caller after top-k selection
		predictorStatus: fetchedPredictorStatus,
	};
}

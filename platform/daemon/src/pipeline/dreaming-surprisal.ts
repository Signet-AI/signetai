import type { DreamingSurprisalConfig } from "@signet/core";
import type { ReadDb } from "../db-accessor";

/** A point-in-time episodic observation with an already persisted embedding. */
export interface DreamingSurprisalObservation {
	readonly id: string;
	readonly capturedAt: string;
	readonly vector: Float32Array;
}

export interface DreamingSurprisalCandidate {
	readonly id: string;
	readonly capturedAt: string;
	readonly score: number;
	readonly rank: number;
	readonly sampleSize: number;
	readonly dimensions: number;
}

export interface DreamingSurprisalSelection {
	readonly candidates: readonly DreamingSurprisalCandidate[];
	readonly sampled: number;
	readonly valid: number;
	readonly durationMs: number;
	/** This selector reuses stored vectors; no provider embedding work is done. */
	readonly embeddingRequests: number;
	readonly embeddingTokens: number;
	readonly embeddingCostUsd: number;
	readonly skippedReason?: "too_few_observations" | "no_valid_vectors" | "embedding_store_unavailable";
}

interface ProjectionTreeLeaf {
	readonly kind: "leaf";
	readonly count: number;
	readonly indexes: readonly number[];
}

interface ProjectionTreeBranch {
	readonly kind: "branch";
	readonly count: number;
	readonly axis: number;
	readonly threshold: number;
	readonly left: ProjectionTreeNode;
	readonly right: ProjectionTreeNode;
}

type ProjectionTreeNode = ProjectionTreeLeaf | ProjectionTreeBranch;

const SURPRISAL_SELECTOR_VERSION = "embedding-surprisal-v1";

function clampInteger(value: number, min: number, max: number, fallback = min): number {
	const normalized = Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.max(min, Math.min(max, normalized));
}

function finiteVector(vector: Float32Array): boolean {
	if (vector.length === 0) return false;
	let norm = 0;
	for (const value of vector) {
		if (!Number.isFinite(value)) return false;
		norm += value * value;
	}
	return norm > 0;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < a.length; index += 1) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		dot += left * right;
		normA += left * left;
		normB += right * right;
	}
	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator > 0 ? Math.max(-1, Math.min(1, dot / denominator)) : 0;
}

function chooseProjectionAxis(indexes: readonly number[], vectors: readonly Float32Array[], depth: number): number {
	const dimensions = vectors[indexes[0] ?? 0]?.length ?? 0;
	if (dimensions === 0) return 0;
	let bestAxis = depth % dimensions;
	let bestVariance = -1;
	for (let axis = 0; axis < dimensions; axis += 1) {
		let mean = 0;
		for (const index of indexes) mean += vectors[index]?.[axis] ?? 0;
		mean /= indexes.length;
		let variance = 0;
		for (const index of indexes) {
			const delta = (vectors[index]?.[axis] ?? 0) - mean;
			variance += delta * delta;
		}
		if (variance > bestVariance) {
			bestVariance = variance;
			bestAxis = axis;
		}
	}
	return bestAxis;
}

/**
 * Build a deterministic projection tree. Honcho's tree family uses random
 * projections; Dreaming needs repeatable attention records so a re-run does
 * not churn the queue, therefore this bounded variant projects onto the
 * highest-variance coordinate and splits at its median.
 */
function buildProjectionTree(
	indexes: readonly number[],
	vectors: readonly Float32Array[],
	leafSize: number,
	depth = 0,
): ProjectionTreeNode {
	if (indexes.length <= leafSize) return { kind: "leaf", count: indexes.length, indexes: [...indexes] };
	const axis = chooseProjectionAxis(indexes, vectors, depth);
	const ordered = [...indexes].sort(
		(left, right) => (vectors[left]?.[axis] ?? 0) - (vectors[right]?.[axis] ?? 0) || left - right,
	);
	const middle = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length / 2)));
	const left = ordered.slice(0, middle);
	const right = ordered.slice(middle);
	const leftValue = vectors[left[left.length - 1] ?? 0]?.[axis] ?? 0;
	const rightValue = vectors[right[0] ?? 0]?.[axis] ?? leftValue;
	return {
		kind: "branch",
		count: indexes.length,
		axis,
		threshold: (leftValue + rightValue) / 2,
		left: buildProjectionTree(left, vectors, leafSize, depth + 1),
		right: buildProjectionTree(right, vectors, leafSize, depth + 1),
	};
}

function pathSurprisal(node: ProjectionTreeNode, vector: Float32Array): number {
	let current = node;
	let score = 0;
	while (current.kind === "branch") {
		const child = (vector[current.axis] ?? 0) < current.threshold ? current.left : current.right;
		if (child.count <= 0 || current.count <= 0) break;
		score += -Math.log(child.count / current.count);
		current = child;
	}
	// A smaller leaf represents a less populated region of the embedding
	// space. Keep this bounded even when a malformed tree is supplied.
	return Number.isFinite(score) ? Math.max(0, score) : 0;
}

function normalizeScores(values: readonly number[]): number[] {
	if (values.length === 0) return [];
	const finite = values.map((value) => (Number.isFinite(value) ? value : 0));
	const min = Math.min(...finite);
	const max = Math.max(...finite);
	if (max <= min) return finite.map(() => 0.5);
	return finite.map((value) => Math.max(0, Math.min(1, (value - min) / (max - min))));
}

function emptySelection(
	sampled: number,
	valid: number,
	durationMs: number,
	skippedReason: DreamingSurprisalSelection["skippedReason"],
): DreamingSurprisalSelection {
	return {
		candidates: [],
		sampled,
		valid,
		durationMs,
		embeddingRequests: 0,
		embeddingTokens: 0,
		embeddingCostUsd: 0,
		skippedReason,
	};
}

/**
 * Rank a bounded observation sample by embedding geometry.
 *
 * The local-density term is the primary signal: an observation is surprising
 * when its nearest neighbours are far away. The projection-tree path term is
 * a small stabilizing signal for sparse regions. This is deliberately a
 * selector only; it never emits an ontology operation or evidence claim.
 */
export function rankDreamingSurprisal(
	observations: readonly DreamingSurprisalObservation[],
	config: Pick<
		DreamingSurprisalConfig,
		"maxCandidates" | "minObservations" | "neighborCount" | "treeLeafSize" | "minScore"
	>,
	now: () => number = Date.now,
): DreamingSurprisalSelection {
	const startedAt = now();
	const dimensions = observations.find((observation) => finiteVector(observation.vector))?.vector.length ?? 0;
	const validObservations = observations.filter(
		(observation) => observation.vector.length === dimensions && finiteVector(observation.vector),
	);
	if (validObservations.length === 0)
		return emptySelection(observations.length, 0, Math.max(0, now() - startedAt), "no_valid_vectors");
	const minObservations = clampInteger(config.minObservations, 1, 500);
	if (validObservations.length < minObservations) {
		return emptySelection(
			observations.length,
			validObservations.length,
			Math.max(0, now() - startedAt),
			"too_few_observations",
		);
	}

	const vectors = validObservations.map((observation) => observation.vector);
	const indexes = vectors.map((_vector, index) => index);
	const tree = buildProjectionTree(indexes, vectors, clampInteger(config.treeLeafSize, 2, 64));
	const neighbourCount = clampInteger(config.neighborCount, 1, Math.max(1, vectors.length - 1));
	const localDistances = vectors.map((vector, index) => {
		const distances = vectors
			.map((other, otherIndex) =>
				otherIndex === index ? Number.POSITIVE_INFINITY : 1 - cosineSimilarity(vector, other),
			)
			.sort((left, right) => left - right)
			.slice(0, neighbourCount);
		return distances.reduce((total, distance) => total + distance, 0) / distances.length;
	});
	const treeScores = vectors.map((vector) => pathSurprisal(tree, vector));
	const normalizedDistances = normalizeScores(localDistances);
	const normalizedTreeScores = normalizeScores(treeScores);
	const ranked = validObservations
		.map((observation, index) => ({
			observation,
			score: Math.max(
				0,
				Math.min(1, 0.75 * (normalizedDistances[index] ?? 0) + 0.25 * (normalizedTreeScores[index] ?? 0)),
			),
		}))
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.observation.capturedAt.localeCompare(left.observation.capturedAt) ||
				left.observation.id.localeCompare(right.observation.id),
		);
	const maxCandidates = clampInteger(config.maxCandidates, 1, 20);
	const minScore = Math.max(0, Math.min(1, Number.isFinite(config.minScore) ? config.minScore : 1));
	const candidates = ranked
		.filter((item) => item.score >= minScore)
		.slice(0, maxCandidates)
		.map((item, index) => ({
			id: item.observation.id,
			capturedAt: item.observation.capturedAt,
			score: item.score,
			rank: index + 1,
			sampleSize: validObservations.length,
			dimensions,
		}));

	return {
		candidates,
		sampled: observations.length,
		valid: validObservations.length,
		durationMs: Math.max(0, now() - startedAt),
		embeddingRequests: 0,
		embeddingTokens: 0,
		embeddingCostUsd: 0,
	};
}

function blobToVector(value: unknown): Float32Array | null {
	if (value instanceof ArrayBuffer) {
		if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
		return Float32Array.from(new Float32Array(value));
	}
	if (!ArrayBuffer.isView(value)) return null;
	const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
	const aligned = new Uint8Array(bytes.byteLength);
	aligned.set(bytes);
	return Float32Array.from(new Float32Array(aligned.buffer));
}

/** Read only primary, scoped memory embeddings; never asks the provider for new vectors. */
export function selectDreamingSurprisalInDb(
	db: ReadDb,
	agentId: string,
	config: DreamingSurprisalConfig,
	since: string | null,
): DreamingSurprisalSelection {
	const startedAt = Date.now();
	try {
		const limit = clampInteger(config.sampleSize, 20, 500);
		const rows = db
			.prepare(
				`SELECT m.id, m.created_at AS capturedAt, e.vector, e.dimensions
				 FROM memories AS m
				 JOIN embeddings AS e ON e.source_type = 'memory' AND e.source_id = m.id
				   AND e.id = (
					   SELECT latest.id
					   FROM embeddings AS latest
					   WHERE latest.source_type = 'memory'
						 AND latest.source_id = m.id
						 AND (latest.agent_id = m.agent_id OR latest.agent_id IS NULL)
					   ORDER BY latest.created_at DESC, latest.id DESC
					   LIMIT 1
				   )
				 WHERE m.agent_id = ?
				   AND (e.agent_id = ? OR e.agent_id IS NULL)
				   AND COALESCE(m.memory_kind, 'episodic') = 'episodic'
				   AND COALESCE(m.is_deleted, 0) = 0
				   AND (m.visibility IS NULL OR m.visibility <> 'archived')
				   AND COALESCE(m.scope, '') = ''
				   AND COALESCE(m.pinned, 0) = 0
				   AND (? IS NULL OR julianday(m.created_at) > julianday(?))
				 ORDER BY m.created_at DESC, m.id DESC
				 LIMIT ?`,
			)
			.all(agentId, agentId, since, since, limit) as Array<{
			id: string;
			capturedAt: string;
			vector: unknown;
			dimensions: number;
		}>;
		const observations = rows.flatMap((row) => {
			const vector = blobToVector(row.vector);
			return vector === null || !Number.isInteger(row.dimensions) || row.dimensions !== vector.length
				? []
				: [{ id: row.id, capturedAt: row.capturedAt, vector }];
		});
		const selection = rankDreamingSurprisal(observations, config);
		return { ...selection, sampled: rows.length, durationMs: Math.max(0, Date.now() - startedAt) };
	} catch {
		return emptySelection(0, 0, Math.max(0, Date.now() - startedAt), "embedding_store_unavailable");
	}
}

export const DREAMING_SURPRISAL_SELECTOR_VERSION = SURPRISAL_SELECTOR_VERSION;

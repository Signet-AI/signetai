/**
 * RaBitQ compressed vector index — integration layer.
 *
 * Loads embeddings from the SQLite `embeddings` table, builds a compressed
 * index using the RaBitQ algorithm, and provides `compressedVectorSearch()`
 * as a drop-in alternative to `vectorSearch()` from @signet/core.
 *
 * The index is built once at daemon startup and cached in memory. When new
 * embeddings are inserted, the index is rebuilt on next search (lazy
 * invalidation via row-count check).
 */

// ---------------------------------------------------------------------------
// Memory overhead notes
// ---------------------------------------------------------------------------
//
// For dim=768, the rotation matrix alone is 768x768x4 bytes = 2.36 MB.
// Each compressed vector is ~392 bytes vs 3072 bytes uncompressed (7.8x).
// However, the rotation matrix overhead means compression only saves net
// memory above ~5,000 vectors. Below that threshold, sqlite-vec brute-force
// search is cheaper in both memory and wall-clock time.
//
// Approximate break-even analysis (dim=768, 4-bit):
//   Overhead:  2.36 MB (rotation) + 64 B (codebook) = 2.36 MB
//   Savings per vector: 3072 - 392 = 2680 bytes
//   Break-even: 2,360,000 / 2,680 = 881 vectors (memory only)
//   Practical break-even with build cost: ~5,000 vectors
//

import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import {
	type CompressedIndex,
	type CompressedSearchResult,
	compressedSearch,
	computeCodebook,
	generateRotationMatrix,
	quantize,
} from "./rabitq";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** RaBitQ index configuration (matches daemon config conventions). */
export interface RaBitQConfig {
	/** Whether compressed vector search is enabled. */
	enabled: boolean;
	/** Quantization bits per coordinate (default: 4). */
	bits: number;
	/** Seed for deterministic rotation matrix (default: 42). */
	seed: number;
	/** Expected embedding dimensionality (default: 768). */
	dimensions: number;
	/** Top-K candidates from compressed search before exact re-rank (default: 50). */
	prefilterTopK: number;
	/** Final top-K after exact re-rank (default: 10). */
	rerankTopK: number;
}

export const DEFAULT_RABITQ_CONFIG: RaBitQConfig = {
	enabled: false,
	bits: 4,
	seed: 42,
	dimensions: 768,
	prefilterTopK: 50,
	rerankTopK: 10,
};

// ---------------------------------------------------------------------------
// Cached Index State
// ---------------------------------------------------------------------------

interface IndexState {
	index: CompressedIndex;
	rowCount: number;
	/** Max updated_at or rowid to detect in-place re-embeds. */
	contentHash: string;
	builtAt: number;
	/** Config params the index was built with — invalidate if they change. */
	configDimensions: number;
	configBits: number;
	configSeed: number;
}

let cachedState: IndexState | null = null;
let buildInProgress = false;

// ---------------------------------------------------------------------------
// Index Construction
// ---------------------------------------------------------------------------

/**
 * Load all embeddings from the database and build the compressed index.
 *
 * @param config - RaBitQ configuration
 * @returns The compressed index, or null if no embeddings exist
 */
function buildIndex(config: RaBitQConfig): CompressedIndex | null {
	const startMs = performance.now();

	try {
		// Fetch all embeddings
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.source_id, e.vector
						 FROM embeddings e
						 JOIN memories m ON e.source_id = m.id
						 WHERE m.is_deleted = 0
						   AND e.vector IS NOT NULL`,
					)
					.all() as Array<{
					source_id: string;
					vector: Buffer;
				}>,
		);

		if (rows.length === 0) {
			logger.info("memory", "RaBitQ: no embeddings found, skipping index build");
			return null;
		}

		// Parse vectors
		const vectors: Float32Array[] = [];
		const ids: string[] = [];
		let skipped = 0;

		for (const row of rows) {
			const buf = row.vector;
			const expectedBytes = config.dimensions * 4;

			if (buf.byteLength !== expectedBytes) {
				skipped++;
				continue;
			}

			const vec = new Float32Array(buf.buffer, buf.byteOffset, config.dimensions);
			vectors.push(vec);
			ids.push(row.source_id);
		}

		if (vectors.length === 0) {
			logger.warn("memory", "RaBitQ: all embeddings had dimension mismatches", {
				total: rows.length,
				skipped,
			});
			return null;
		}

		if (skipped > 0) {
			logger.warn("memory", `RaBitQ: skipped ${skipped} embeddings with wrong dimensions`);
		}

		// Generate rotation matrix and codebook (these are deterministic)
		const rotationMatrix = generateRotationMatrix(config.dimensions, config.seed);
		const codebook = computeCodebook(config.bits, config.dimensions);

		// Build compressed index
		const index = quantize(vectors, ids, rotationMatrix, codebook, config.bits);

		const elapsedMs = performance.now() - startMs;
		logger.info("memory", "RaBitQ: built compressed index", {
			vectors: vectors.length,
			dimensions: config.dimensions,
			bits: config.bits,
			elapsedMs: Math.round(elapsedMs),
		});

		return index;
	} catch (e) {
		logger.error("memory", "RaBitQ: index build failed", e instanceof Error ? e : new Error(String(e)));
		return null;
	}
}

/**
 * Get the current row count and content fingerprint from the embeddings table.
 *
 * Uses MAX(rowid) and SUM(rowid) as the fingerprint signals:
 * - MAX(rowid) advances on any INSERT (including delete+reinsert re-embeds)
 * - SUM(rowid) changes whenever the set of embedding rows changes structurally
 *
 * Note: pure in-place UPDATE (vector column overwritten without row replacement)
 * does not change rowid. Those cases are handled by the explicit `invalidateIndex()`
 * hook called from the maintenance worker after embedding repair operations.
 */
function getEmbeddingFingerprint(): { count: number; hash: string } {
	try {
		const result = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT COUNT(*) as cnt,
						        COALESCE(MAX(e.rowid), 0) || ':' || COALESCE(SUM(e.rowid), 0) as fingerprint
						 FROM embeddings e
						 JOIN memories m ON e.source_id = m.id
						 WHERE m.is_deleted = 0 AND e.vector IS NOT NULL`,
					)
					.get() as { cnt: number; fingerprint: string } | undefined,
		);
		return { count: result?.cnt ?? 0, hash: result?.fingerprint ?? "" };
	} catch {
		return { count: 0, hash: "" };
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the compressed index is built and up-to-date.
 *
 * Lazily rebuilds when the embedding count changes. Single-threaded guard via
 * build-in-progress flag (Bun JS is single-threaded; not safe across worker threads).
 *
 * @param config - RaBitQ configuration
 * @returns The current compressed index, or null if unavailable
 */
export function ensureIndex(config: RaBitQConfig): CompressedIndex | null {
	if (!config.enabled) return null;

	const { count: currentCount, hash: currentHash } = getEmbeddingFingerprint();

	// Skip building for very small datasets where brute-force is cheaper
	if (currentCount > 0 && currentCount < 1000) {
		logger.info("memory", "RaBitQ: skipping index build, brute-force is cheaper for <1000 vectors", {
			vectorCount: currentCount,
		});
		return null;
	}

	// Check if cached index is still valid (count + content fingerprint + config params)
	if (
		cachedState !== null &&
		cachedState.rowCount === currentCount &&
		cachedState.contentHash === currentHash &&
		cachedState.configDimensions === config.dimensions &&
		cachedState.configBits === config.bits &&
		cachedState.configSeed === config.seed
	) {
		return cachedState.index;
	}

	// Avoid concurrent builds
	if (buildInProgress) {
		return cachedState?.index ?? null;
	}

	buildInProgress = true;
	try {
		const index = buildIndex(config);
		if (index !== null) {
			cachedState = {
				index,
				rowCount: currentCount,
				contentHash: currentHash,
				builtAt: Date.now(),
				configDimensions: config.dimensions,
				configBits: config.bits,
				configSeed: config.seed,
			};
		}
		return index;
	} finally {
		buildInProgress = false;
	}
}

/**
 * Compressed vector search — drop-in alternative to `vectorSearch()`.
 *
 * Uses the pre-built RaBitQ index for fast approximate nearest-neighbour
 * search. Returns results in the same format as `vectorSearch()`.
 *
 * @param queryVector - Query embedding (Float32Array, dim=768)
 * @param config - RaBitQ configuration
 * @param topK - Number of results to return
 * @returns Array of {id, score} sorted by descending score
 */
export function compressedVectorSearch(
	queryVector: Float32Array,
	config: RaBitQConfig,
	topK?: number,
): Array<{ id: string; score: number }> {
	const index = ensureIndex(config);
	if (index === null) return [];

	const k = topK ?? config.prefilterTopK;
	return compressedSearch(queryVector, index, k);
}

/** Filter options passed through from the search pipeline. */
export interface CompressedSearchFilters {
	/** Memory type filter (e.g. "fact", "preference", "decision"). */
	type?: "fact" | "preference" | "decision";
	/** Scope filter (null = unscoped, string = specific scope). */
	scope?: string | null;
	/** Project filter (auth scope enforcement). */
	project?: string;
	/** Agent ID for visibility filtering. */
	agentId?: string;
	/** Agent read policy ('isolated' | 'shared' | 'group'). */
	readPolicy?: string;
	/** Policy group name (required when readPolicy is 'group'). */
	policyGroup?: string | null;
	/** Final result limit (overrides config.rerankTopK to match pipeline top_k). */
	limit?: number;
	/** Pre-filter candidate count (overrides config.prefilterTopK for scoped queries). */
	prefilterLimit?: number;
}

/**
 * Two-phase search: compressed pre-filter → exact re-rank.
 *
 * 1. Use compressed search to find approximate top-N candidates
 * 2. Fetch exact embeddings for those candidates from SQLite
 *    (applying type/project/scope filters during hydration)
 * 3. Re-rank by exact cosine similarity
 * 4. Return final top-K
 *
 * This gives near-exact recall with the speed of compressed search.
 *
 * @param queryVector - Query embedding (Float32Array, dim=768)
 * @param config - RaBitQ configuration
 * @param filters - Optional pipeline filters (type, limit overrides)
 * @returns Array of {id, score} sorted by exact cosine similarity
 */
export function compressedVectorSearchWithRerank(
	queryVector: Float32Array,
	config: RaBitQConfig,
	filters?: CompressedSearchFilters,
): Array<{ id: string; score: number }> {
	const index = ensureIndex(config);
	if (index === null) return [];

	// Use pipeline limits when provided, otherwise fall back to config defaults
	const prefilterK = filters?.prefilterLimit ?? config.prefilterTopK;
	const rerankK = filters?.limit ?? config.rerankTopK;

	// Phase 1: compressed pre-filter (over-fetch to compensate for filter losses)
	// Fetch 3× the rerank target to leave room for type/scope filtering
	const overFetchK = Math.max(prefilterK, rerankK * 3);
	const candidates = compressedSearch(queryVector, index, overFetchK);
	if (candidates.length === 0) return [];

	// Phase 2: fetch exact embeddings and re-rank (with type filter)
	const candidateIds = candidates.map((c) => c.id);
	const placeholders = candidateIds.map(() => "?").join(", ");

	// Build filter clauses for the hydration query (type, scope, project)
	const filterParts: string[] = [];
	const queryArgs: unknown[] = [...candidateIds];
	if (filters?.type) {
		filterParts.push("m.type = ?");
		queryArgs.push(filters.type);
	}
	if (filters?.scope !== undefined) {
		if (filters.scope === null) {
			filterParts.push("m.scope IS NULL");
		} else {
			filterParts.push("m.scope = ?");
			queryArgs.push(filters.scope);
		}
	} else {
		// Default: exclude scoped memories from unscoped searches (matches vectorSearch behavior)
		filterParts.push("m.scope IS NULL");
	}
	if (filters?.project) {
		filterParts.push("m.project = ?");
		queryArgs.push(filters.project);
	}
	// Agent visibility filtering (mirrors buildAgentScopeClause in memory-search.ts)
	if (filters?.agentId && filters?.readPolicy) {
		const rp = filters.readPolicy;
		if (rp === "shared") {
			filterParts.push("(m.visibility = 'global' OR m.agent_id = ?) AND m.visibility != 'archived'");
			queryArgs.push(filters.agentId);
		} else if (rp === "group" && filters.policyGroup) {
			filterParts.push(
				"((m.visibility = 'global' AND m.agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR m.agent_id = ?) AND m.visibility != 'archived'",
			);
			queryArgs.push(filters.policyGroup, filters.agentId);
		} else {
			// Default: isolated — only this agent's memories
			filterParts.push("m.agent_id = ? AND m.visibility != 'archived'");
			queryArgs.push(filters.agentId);
		}
	}
	const filterClause = filterParts.length > 0 ? ` AND ${filterParts.join(" AND ")}` : "";

	try {
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.source_id, e.vector FROM embeddings e
						 JOIN memories m ON e.source_id = m.id
						 WHERE e.source_id IN (${placeholders})
						   AND m.is_deleted = 0${filterClause}`,
					)
					.all(...queryArgs) as Array<{
					source_id: string;
					vector: Buffer;
				}>,
		);

		// Exact cosine re-rank
		let queryNormSq = 0;
		for (let i = 0; i < queryVector.length; i++) {
			queryNormSq += queryVector[i] * queryVector[i];
		}
		const queryNorm = Math.sqrt(queryNormSq);

		const reranked: Array<{ id: string; score: number }> = [];

		for (const row of rows) {
			const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);

			let dot = 0;
			let vecNormSq = 0;
			const len = Math.min(queryVector.length, vec.length);
			for (let i = 0; i < len; i++) {
				dot += queryVector[i] * vec[i];
				vecNormSq += vec[i] * vec[i];
			}
			const vecNorm = Math.sqrt(vecNormSq);
			const cosine = queryNorm > 0 && vecNorm > 0 ? dot / (queryNorm * vecNorm) : 0;

			reranked.push({ id: row.source_id, score: Math.max(0, cosine) });
		}

		reranked.sort((a, b) => b.score - a.score);
		return reranked.slice(0, rerankK);
	} catch (e) {
		logger.warn("memory", "RaBitQ: exact re-rank failed, returning compressed results", {
			error: e instanceof Error ? e.message : String(e),
		});
		return candidates.slice(0, rerankK);
	}
}

/**
 * Invalidate the cached index, forcing a rebuild on next search.
 * Call this after bulk embedding operations.
 */
export function invalidateIndex(): void {
	cachedState = null;
}

/**
 * Get diagnostic info about the current index state.
 */
export function getIndexStats(): {
	built: boolean;
	vectorCount: number;
	dimensions: number;
	bits: number;
	builtAt: string | null;
} {
	if (cachedState === null) {
		return {
			built: false,
			vectorCount: 0,
			dimensions: 0,
			bits: 0,
			builtAt: null,
		};
	}

	return {
		built: true,
		vectorCount: cachedState.index.count,
		dimensions: cachedState.index.dim,
		bits: cachedState.index.bits,
		builtAt: new Date(cachedState.builtAt).toISOString(),
	};
}

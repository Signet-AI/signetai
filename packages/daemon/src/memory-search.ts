/**
 * Hybrid recall search orchestration.
 *
 * Extracted from daemon.ts — this module contains the pure search logic
 * between "parse request" and "format response". The route handler in
 * daemon.ts is now a thin HTTP wrapper that delegates here.
 */

import { vectorSearch } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import type { EmbeddingConfig, MemorySearchConfig, ResolvedMemoryConfig } from "./memory-config";
import { constructContextBlocks } from "./pipeline/context-construction";
import { DEFAULT_DAMPENING, type ScoredRow, applyDampening } from "./pipeline/dampening";
import { getGraphBoostIds, tokenizeGraphQuery } from "./pipeline/graph-search";
import { resolveFocalEntities, setTraversalStatus, traverseKnowledgeGraph } from "./pipeline/graph-traversal";
import { type RerankCandidate, noopReranker, rerank } from "./pipeline/reranker";
import { createEmbeddingReranker } from "./pipeline/reranker-embedding";
import { FTS_STOP } from "./pipeline/stop-words";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecallParams {
	query: string;
	keywordQuery?: string;
	limit?: number;
	agentId?: string;
	/** Agent read policy — 'isolated' | 'shared' | 'group'. When set with agentId, filters by visibility. */
	readPolicy?: string;
	/** Policy group name (required when readPolicy is 'group'). */
	policyGroup?: string | null;
	type?: string;
	tags?: string;
	who?: string;
	pinned?: boolean;
	importance_min?: number;
	since?: string;
	until?: string;
	scope?: string | null;
	expand?: boolean;
	/** When set, restricts results to memories belonging to this project (auth scope enforcement). */
	project?: string;
}

export interface RecallResult {
	id: string;
	content: string;
	content_length: number;
	truncated: boolean;
	score: number;
	source: string;
	type: string;
	tags: string | null;
	pinned: boolean;
	importance: number;
	who: string;
	project: string | null;
	created_at: string;
	supplementary?: boolean;
}

export interface RecallResponse {
	results: RecallResult[];
	query: string;
	method: "hybrid" | "keyword";
	entities?: Array<{
		name: string;
		type: string;
		aspects: Array<{
			name: string;
			attributes: Array<{ content: string; status: string; importance: number }>;
		}>;
	}>;
	sources?: Record<string, string>;
}

export type EmbedFn = (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;

// ---------------------------------------------------------------------------
// Agent scope clause (exported for testing)
// ---------------------------------------------------------------------------

export function buildAgentScopeClause(
	agentId: string,
	readPolicy: string,
	policyGroup: string | null,
): { sql: string; args: unknown[] } {
	if (readPolicy === "shared") {
		return {
			sql: " AND (m.visibility = 'global' OR m.agent_id = ?) AND m.visibility != 'archived'",
			args: [agentId],
		};
	}
	if (readPolicy === "group") {
		return {
			sql: " AND ((m.visibility = 'global' AND m.agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR m.agent_id = ?) AND m.visibility != 'archived'",
			args: [policyGroup, agentId],
		};
	}
	// 'isolated' or unknown — own memories only
	return {
		sql: " AND m.agent_id = ? AND m.visibility != 'archived'",
		args: [agentId],
	};
}

// ---------------------------------------------------------------------------
// Filter clause builder (private)
// ---------------------------------------------------------------------------

interface FilterClause {
	sql: string;
	args: unknown[];
}

function buildFilterClause(params: RecallParams): FilterClause {
	const parts: string[] = [];
	const args: unknown[] = [];

	// Scope isolation: explicit scope filters to that scope, undefined
	// defaults to excluding all scoped memories from normal searches.
	if (params.scope !== undefined) {
		if (params.scope === null) {
			parts.push("m.scope IS NULL");
		} else {
			parts.push("m.scope = ?");
			args.push(params.scope);
		}
	} else {
		parts.push("m.scope IS NULL");
	}

	if (params.type) {
		parts.push("m.type = ?");
		args.push(params.type);
	}
	if (params.tags) {
		for (const t of params.tags
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			parts.push("m.tags LIKE ?");
			args.push(`%${t}%`);
		}
	}
	if (params.who) {
		parts.push("m.who = ?");
		args.push(params.who);
	}
	if (params.pinned) {
		parts.push("m.pinned = 1");
	}
	if (typeof params.importance_min === "number") {
		parts.push("m.importance >= ?");
		args.push(params.importance_min);
	}
	if (params.since) {
		parts.push("m.created_at >= ?");
		args.push(params.since);
	}
	if (params.until) {
		parts.push("m.created_at <= ?");
		args.push(params.until);
	}
	// Auth scope enforcement: restrict to token's project when present.
	if (params.project) {
		parts.push("m.project = ?");
		args.push(params.project);
	}

	const base: FilterClause = {
		sql: parts.length ? ` AND ${parts.join(" AND ")}` : "",
		args,
	};

	// Agent visibility filtering — only applied when both agentId and readPolicy are provided.
	if (params.agentId && params.readPolicy) {
		const scope = buildAgentScopeClause(params.agentId, params.readPolicy, params.policyGroup ?? null);
		return { sql: base.sql + scope.sql, args: [...base.args, ...scope.args] };
	}

	return base;
}

// ---------------------------------------------------------------------------
// FTS5 query sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a query string for FTS5 MATCH.
 *
 * Strips FTS5 syntax characters, removes stop words, and quotes each
 * token as a literal. Short queries (<=3 tokens) use implicit AND for
 * precision; longer queries use OR so BM25 IDF ranks by term importance.
 */
export function sanitizeFtsQuery(raw: string): string {
	const tokens = raw
		.replace(/'/g, " ")
		.split(/\s+/)
		.map((token) => {
			const cleaned = token
				.replace(/[":()^*?]/g, "")
				.trim()
				.toLowerCase();
			if (!cleaned || cleaned.length < 2) return null;
			if (FTS_STOP.has(cleaned)) return null;
			return `"${cleaned}"`;
		})
		.filter(Boolean) as string[];

	if (tokens.length === 0) return "";
	// Short queries (<=3 content tokens): implicit AND for precision.
	// Longer queries: OR so BM25 IDF ranks by term importance.
	if (tokens.length <= 3) return tokens.join(" ");
	return tokens.join(" OR ");
}

// ---------------------------------------------------------------------------
// Rehearsal boost (shared between traversal-primary and legacy paths)
// ---------------------------------------------------------------------------

function applyRehearsalBoost(
	scored: Array<{ id: string; score: number; source: string }>,
	search: MemorySearchConfig,
): void {
	if (!search.rehearsal_enabled || search.rehearsal_weight <= 0 || scored.length === 0) return;
	try {
		const ids = scored.map((s) => s.id);
		const placeholders = ids.map(() => "?").join(", ");
		const accessRows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, access_count, last_accessed
						 FROM memories
						 WHERE id IN (${placeholders})`,
					)
					.all(...ids) as Array<{
					id: string;
					access_count: number;
					last_accessed: string | null;
				}>,
		);

		const nowMs = Date.now();
		const rw = search.rehearsal_weight;
		const accessMap = new Map(accessRows.map((r) => [r.id, r]));
		for (const s of scored) {
			const row = accessMap.get(s.id);
			if (!row || row.access_count <= 0) continue;
			const daysSinceAccess = row.last_accessed
				? (nowMs - new Date(row.last_accessed).getTime()) / 86_400_000
				: search.rehearsal_half_life_days;
			const recencyFactor = 0.5 ** (daysSinceAccess / search.rehearsal_half_life_days);
			const boost = rw * Math.log(row.access_count + 1) * recencyFactor;
			s.score *= 1 + boost;
		}
		scored.sort((a, b) => b.score - a.score);
	} catch (e) {
		logger.warn("memory", "Rehearsal boost failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ---------------------------------------------------------------------------
// Main search orchestration
// ---------------------------------------------------------------------------

export async function hybridRecall(
	params: RecallParams,
	cfg: ResolvedMemoryConfig,
	embedFn: EmbedFn,
): Promise<RecallResponse> {
	const query = params.query;
	const keywordQuery = sanitizeFtsQuery((params.keywordQuery ?? params.query).trim());
	const limit = params.limit ?? 10;
	const alpha = cfg.search.alpha;
	const minScore = cfg.search.min_score;

	const filter = buildFilterClause(params);
	const scoped = params.scope !== undefined;

	// --- BM25 keyword search via FTS5 ---
	const bm25Map = new Map<string, number>();
	try {
		getDbAccessor().withReadDb((db) => {
			const ftsRows = (
				db.prepare(`
        SELECT m.id, bm25(memories_fts) AS raw_score
        FROM memories_fts
        JOIN memories m ON memories_fts.rowid = m.rowid
        WHERE memories_fts MATCH ?${filter.sql}
        ORDER BY raw_score
        LIMIT ?
      `) as any
			).all(keywordQuery, ...filter.args, cfg.search.top_k) as Array<{
				id: string;
				raw_score: number;
			}>;

			// Min-max normalize BM25 scores to [0,1] within the batch
			const rawScores = ftsRows.map((r) => Math.abs(r.raw_score));
			const maxRaw = rawScores.length > 0 ? Math.max(...rawScores) : 1;
			const normalizer = maxRaw > 0 ? maxRaw : 1;
			for (const row of ftsRows) {
				const normalised = Math.abs(row.raw_score) / normalizer;
				bm25Map.set(row.id, normalised);
			}
		});
	} catch (e) {
		logger.warn("memory", "FTS search failed, continuing with vector only", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	// --- Prospective hints FTS5 (bridges cue-trigger semantic gap) ---
	// Hints are hypothetical queries generated at write time. A hint match
	// elevates its parent memory via Math.max (not additive stacking).
	if (cfg.pipelineV2.hints?.enabled) {
		try {
			getDbAccessor().withReadDb((db) => {
				const sql = scoped
					? `SELECT h.memory_id AS id, bm25(memory_hints_fts) AS raw_score
					   FROM memory_hints_fts
					   JOIN memory_hints h ON memory_hints_fts.rowid = h.rowid
					   JOIN memories m ON m.id = h.memory_id
					   WHERE memory_hints_fts MATCH ? AND h.agent_id = ? AND m.scope = ?
					   ORDER BY raw_score LIMIT ?`
					: `SELECT h.memory_id AS id, bm25(memory_hints_fts) AS raw_score
					   FROM memory_hints_fts
					   JOIN memory_hints h ON memory_hints_fts.rowid = h.rowid
					   WHERE memory_hints_fts MATCH ? AND h.agent_id = ?
					   ORDER BY raw_score LIMIT ?`;

				const agentId = params.agentId ?? "default";
				const args = scoped
					? [keywordQuery, agentId, params.scope, cfg.search.top_k]
					: [keywordQuery, agentId, cfg.search.top_k];

				const rows = (db.prepare(sql) as any).all(...args) as Array<{
					id: string;
					raw_score: number;
				}>;

				// Normalize hint scores the same way as memory FTS
				const rawScores = rows.map((r) => Math.abs(r.raw_score));
				const maxRaw = rawScores.length > 0 ? Math.max(...rawScores) : 1;
				const normalizer = maxRaw > 0 ? maxRaw : 1;
				for (const row of rows) {
					const hint = Math.abs(row.raw_score) / normalizer;
					const content = bm25Map.get(row.id) ?? 0;
					// Blend content (70%) and hint (30%) when both exist.
					// Hint-only memories score on their own merit (0-1) — capping
					// at 0.3 placed them exactly at the min_score cliff, filtering
					// out the memories hints were designed to rescue.
					const blended = content > 0 ? content * 0.7 + hint * 0.3 : hint;
					bm25Map.set(row.id, Math.max(content, blended));
				}
			});
		} catch (e) {
			// memory_hints_fts may not exist on pre-038 databases — silent fallback
			logger.warn("memory", "Hints FTS query failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Query embedding (used by reranker even when vector search is skipped) ---
	let queryVecF32: Float32Array | null = null;
	try {
		const queryVec = await embedFn(query, cfg.embedding);
		if (queryVec) queryVecF32 = new Float32Array(queryVec);
	} catch (e) {
		logger.warn("memory", "Embedding failed", { error: String(e) });
	}

	// --- Vector search via sqlite-vec ---
	// sqlite-vec cannot pre-filter by scope, so scoped queries over-fetch
	// (2x top_k) and rely on hydration-time scope filtering (line ~685).
	// This ensures scoped queries still benefit from vector similarity
	// when graph traversal yields no focal entities.
	const vectorMap = new Map<string, number>();
	if (queryVecF32) {
		const vecLimit = scoped ? cfg.search.top_k * 2 : cfg.search.top_k;
		try {
			getDbAccessor().withReadDb((db) => {
				const vecResults = vectorSearch(db as any, queryVecF32!, {
					limit: vecLimit,
					type: params.type as "fact" | "preference" | "decision" | undefined,
				});
				for (const r of vecResults) {
					vectorMap.set(r.id, r.score);
				}
			});
		} catch (e) {
			logger.warn("memory", "Vector search failed, using keyword only", {
				error: String(e),
			});
		}
	}

	// --- Flat search: merge BM25 + vector scores ---
	const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
	const flatScored: Array<{ id: string; score: number; source: string }> = [];

	for (const id of allIds) {
		const bm25 = bm25Map.get(id) ?? 0;
		const vec = vectorMap.get(id) ?? 0;
		let score: number;
		let source: string;

		if (bm25 > 0 && vec > 0) {
			score = alpha * vec + (1 - alpha) * bm25;
			source = "hybrid";
		} else if (vec > 0) {
			score = vec;
			source = "vector";
		} else {
			score = bm25;
			source = "keyword";
		}

		if (score >= minScore) flatScored.push({ id, score, source });
	}

	flatScored.sort((a, b) => b.score - a.score);

	// --- Score pipeline: traversal-primary vs legacy boost ---
	const traversalPrimary =
		cfg.pipelineV2.graph.enabled && cfg.pipelineV2.traversal?.enabled && cfg.pipelineV2.traversal?.primary !== false;

	let scored: Array<{ id: string; score: number; source: string }>;

	if (traversalPrimary) {
		// Channel A: graph traversal (primary retrieval path per DP-6)
		const traversalScored: Array<{ id: string; score: number; source: string }> = [];

		if (cfg.pipelineV2.traversal) {
			try {
				const traversalCfg = cfg.pipelineV2.traversal;
				const queryTokens = tokenizeGraphQuery(query);
				if (queryTokens.length > 0) {
					const agentId = params.agentId ?? "default";
					const focal = getDbAccessor().withReadDb((db) => resolveFocalEntities(db, agentId, { queryTokens }));

					if (focal.entityIds.length > 0) {
						const traversal = getDbAccessor().withReadDb((db) =>
							traverseKnowledgeGraph(focal.entityIds, db, agentId, {
								maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
								maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
								maxDependencyHops: traversalCfg.maxDependencyHops,
								minDependencyStrength: traversalCfg.minDependencyStrength,
								maxBranching: traversalCfg.maxBranching,
								maxTraversalPaths: traversalCfg.maxTraversalPaths,
								minConfidence: traversalCfg.minConfidence,
								timeoutMs: traversalCfg.timeoutMs,
								scope: params.scope,
							}),
						);

						// Cosine re-scoring: when query embedding is available,
						// blend structural importance with semantic similarity so
						// traversal results rank by relevance, not just graph
						// proximity.  Without this, uniform importance (0.5/0.8)
						// makes traversal ordering effectively random.
						const cosineMap = new Map<string, number>();
						if (queryVecF32 && traversal.memoryScores.size > 0) {
							const ids = [...traversal.memoryScores.keys()];
							const ph = ids.map(() => "?").join(", ");
							const embRows = getDbAccessor().withReadDb(
								(db) =>
									db
										.prepare(
											`SELECT source_id, vector FROM embeddings
										 WHERE source_id IN (${ph})`,
										)
										.all(...ids) as Array<{
										source_id: string;
										vector: Buffer;
									}>,
							);
							const qv = queryVecF32;
							for (const row of embRows) {
								const mv = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
								// Cosine similarity (vectors are normalized by embedding model)
								let dot = 0;
								const len = Math.min(qv.length, mv.length);
								for (let i = 0; i < len; i++) dot += qv[i] * mv[i];
								cosineMap.set(row.source_id, Math.max(0, dot));
							}
						}

						const cosineWeight = 0.7;
						for (const [memoryId, importance] of traversal.memoryScores) {
							const cosine = cosineMap.get(memoryId) ?? 0;
							const imp = Math.max(minScore, Math.min(1, importance));
							const score = cosine > 0 ? cosineWeight * cosine + (1 - cosineWeight) * imp : imp;
							traversalScored.push({
								id: memoryId,
								score,
								source: "traversal",
							});
						}

						setTraversalStatus({
							phase: "recall",
							at: new Date().toISOString(),
							source: focal.source,
							focalEntityNames: focal.entityNames,
							focalEntities: focal.entityIds.length,
							traversedEntities: traversal.entityCount,
							memoryCount: traversal.memoryIds.size,
							constraintCount: traversal.constraints.length,
							timedOut: traversal.timedOut,
						});
					}
				}
			} catch (e) {
				logger.warn("memory", "Traversal channel failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Channel merge: ensure flat candidates are eligible to compete in the
		// final sorted pool. Flat gets at least 40% of pre-sort slots so hub
		// entities (high-mention traversal walks) can't exclude keyword/vector
		// matches entirely. After the sort, final top-N is score-ordered —
		// the guarantee is eligibility, not placement.
		const traversalIds = new Set(traversalScored.map((s) => s.id));
		const flatOnly = flatScored.filter((s) => !traversalIds.has(s.id));
		const minFlat = Math.ceil(limit * 0.4);
		const maxTraversal = limit - Math.min(minFlat, flatOnly.length);
		scored = [
			...traversalScored.slice(0, maxTraversal),
			// When traversal underperforms its cap, flat absorbs the surplus
			// slots — this is intentional, not a bug.
			...flatOnly.slice(0, limit - Math.min(maxTraversal, traversalScored.length)),
		];
		scored.sort((a, b) => b.score - a.score);

		applyRehearsalBoost(scored, cfg.search);
	} else {
		scored = flatScored;

		applyRehearsalBoost(scored, cfg.search);

		// --- Graph boost: pull up memories linked via knowledge graph ---
		if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.graph.boostWeight > 0) {
			try {
				const graphResult = getDbAccessor().withReadDb((db) =>
					getGraphBoostIds(query, db, cfg.pipelineV2.graph.boostTimeoutMs, params.agentId),
				);
				if (graphResult.graphLinkedIds.size > 0) {
					const gw = cfg.pipelineV2.graph.boostWeight;
					for (const s of scored) {
						if (graphResult.graphLinkedIds.has(s.id)) {
							s.score = (1 - gw) * s.score + gw;
						}
					}
					scored.sort((a, b) => b.score - a.score);
				}
			} catch (e) {
				logger.warn("memory", "Graph boost failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// --- KA traversal boost: structural one-hop retrieval via KA tables ---
		if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.traversal?.enabled) {
			try {
				const traversalCfg = cfg.pipelineV2.traversal;
				const queryTokens = tokenizeGraphQuery(query);
				if (queryTokens.length > 0) {
					const agentId = params.agentId ?? "default";
					const focal = getDbAccessor().withReadDb((db) => resolveFocalEntities(db, agentId, { queryTokens }));

					if (focal.entityIds.length > 0) {
						const traversal = getDbAccessor().withReadDb((db) =>
							traverseKnowledgeGraph(focal.entityIds, db, agentId, {
								maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
								maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
								maxDependencyHops: traversalCfg.maxDependencyHops,
								minDependencyStrength: traversalCfg.minDependencyStrength,
								maxBranching: traversalCfg.maxBranching,
								maxTraversalPaths: traversalCfg.maxTraversalPaths,
								minConfidence: traversalCfg.minConfidence,
								timeoutMs: traversalCfg.timeoutMs,
							}),
						);

						const tw = traversalCfg.boostWeight;
						const scoredById = new Map(scored.map((row) => [row.id, row]));
						const missingIds: string[] = [];

						for (const memoryId of traversal.memoryIds) {
							const existing = scoredById.get(memoryId);
							if (existing) {
								existing.score = (1 - tw) * existing.score + tw;
							} else {
								missingIds.push(memoryId);
							}
						}

						if (missingIds.length > 0) {
							const placeholders = missingIds.map(() => "?").join(", ");
							const baseRows = getDbAccessor().withReadDb(
								(db) =>
									db
										.prepare(
											`SELECT
												 m.id,
												 COALESCE(MAX(ea.importance), m.importance, 0.5) AS traversal_score
											 FROM memories m
											 LEFT JOIN entity_attributes ea
											   ON ea.memory_id = m.id
											  AND ea.agent_id = ?
											  AND ea.status = 'active'
											 WHERE m.id IN (${placeholders})
											   AND m.is_deleted = 0
											 ${filter.sql}
											 GROUP BY m.id, m.importance`,
										)
										.all(agentId, ...missingIds, ...filter.args) as Array<{
										id: string;
										traversal_score: number;
									}>,
							);

							for (const row of baseRows) {
								scored.push({
									id: row.id,
									score: Math.max(minScore, Math.min(1, row.traversal_score)),
									source: "ka_traversal",
								});
							}
						}

						scored.sort((a, b) => b.score - a.score);

						setTraversalStatus({
							phase: "recall",
							at: new Date().toISOString(),
							source: focal.source,
							focalEntityNames: focal.entityNames,
							focalEntities: focal.entityIds.length,
							traversedEntities: traversal.entityCount,
							memoryCount: traversal.memoryIds.size,
							constraintCount: traversal.constraints.length,
							timedOut: traversal.timedOut,
						});
					}
				}
			} catch (e) {
				logger.warn("memory", "KA traversal boost failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}

	// --- Optional reranker hook ---
	if (cfg.pipelineV2.reranker.enabled) {
		try {
			const topForRerank = scored.slice(0, cfg.pipelineV2.reranker.topN);
			const rerankIds = topForRerank.map((s) => s.id);
			const rerankPlaceholders = rerankIds.map(() => "?").join(", ");

			// Fetch content for reranker — cross-encoders need document text
			const contentRows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT id, content FROM memories
							 WHERE id IN (${rerankPlaceholders})`,
						)
						.all(...rerankIds) as Array<{
						id: string;
						content: string;
					}>,
			);
			const contentMap = new Map(contentRows.map((r) => [r.id, r.content]));

			const candidates: RerankCandidate[] = topForRerank.map((s) => ({
				id: s.id,
				content: contentMap.get(s.id) ?? "",
				score: s.score,
			}));
			// Use embedding reranker when query vector is available, else noop
			const provider = queryVecF32 ? createEmbeddingReranker(getDbAccessor(), queryVecF32) : noopReranker;
			const reranked = await rerank(query, candidates, provider, {
				topN: cfg.pipelineV2.reranker.topN,
				timeoutMs: cfg.pipelineV2.reranker.timeoutMs,
				model: cfg.pipelineV2.reranker.model,
			});
			// Update scores from reranked results
			const rerankedMap = new Map(reranked.map((r, i) => [r.id, i]));
			for (const s of scored) {
				const idx = rerankedMap.get(s.id);
				if (idx !== undefined) {
					// Preserve relative order from reranker
					s.score = 1 - idx / reranked.length;
				}
			}
			scored.sort((a, b) => b.score - a.score);
		} catch (e) {
			logger.warn("memory", "Reranker failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Post-fusion dampening (DP-16) ---
	// Three corrections after all scoring but before the final slice:
	// gravity (penalize zero-term-overlap semantic hits), hub (penalize
	// high-degree entity dominance), resolution (boost actionable types).
	if (scored.length > 0) {
		try {
			const dampenIds = scored.map((s) => s.id);
			const dampenPh = dampenIds.map(() => "?").join(", ");

			// Fetch content + type for dampening analysis
			const dampenRows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT id, content, type FROM memories
							 WHERE id IN (${dampenPh})`,
						)
						.all(...dampenIds) as Array<{
						id: string;
						content: string;
						type: string;
					}>,
			);
			const meta = new Map(dampenRows.map((r) => [r.id, r]));

			// Build entity linkage: memory_id -> set of entity_ids
			const entities = new Map<string, Set<string>>();
			const degrees = new Map<string, number>();

			if (cfg.pipelineV2.graph.enabled) {
				const links = getDbAccessor().withReadDb(
					(db) =>
						db
							.prepare(
								`SELECT memory_id, entity_id FROM memory_entity_mentions
								 WHERE memory_id IN (${dampenPh})`,
							)
							.all(...dampenIds) as Array<{
							memory_id: string;
							entity_id: string;
						}>,
				);

				const entityIds = new Set<string>();
				for (const row of links) {
					let set = entities.get(row.memory_id);
					if (!set) {
						set = new Set();
						entities.set(row.memory_id, set);
					}
					set.add(row.entity_id);
					entityIds.add(row.entity_id);
				}

				// Fetch degree (total mention count) for each linked entity
				if (entityIds.size > 0) {
					const eidList = [...entityIds];
					const eidPh = eidList.map(() => "?").join(", ");
					const degreeRows = getDbAccessor().withReadDb(
						(db) =>
							db
								.prepare(
									`SELECT entity_id, COUNT(*) AS cnt
									 FROM memory_entity_mentions
									 WHERE entity_id IN (${eidPh})
									 GROUP BY entity_id`,
								)
								.all(...eidList) as Array<{
								entity_id: string;
								cnt: number;
							}>,
					);
					for (const row of degreeRows) {
						degrees.set(row.entity_id, row.cnt);
					}
				}
			}

			// Assemble ScoredRow array for dampening
			const dampened = applyDampening(
				scored
					.map((s) => {
						const m = meta.get(s.id);
						if (!m) return null;
						return {
							id: s.id,
							score: s.score,
							source: s.source,
							content: m.content,
							type: m.type,
						};
					})
					.filter((r): r is ScoredRow => r !== null),
				query,
				DEFAULT_DAMPENING,
				entities,
				degrees,
			);

			// Write dampened scores back into scored array
			const dampenedMap = new Map(dampened.map((r) => [r.id, r.score]));
			for (const s of scored) {
				const ds = dampenedMap.get(s.id);
				if (ds !== undefined) s.score = ds;
			}
			scored.sort((a, b) => b.score - a.score);
		} catch (e) {
			logger.warn("memory", "Dampening failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Over-fetch before hydration when scoped. Vector search can't
	// pre-filter by scope, so out-of-scope IDs get dropped at
	// hydration. 3x compensates for the expected discard rate.
	const preHydrate = scoped ? limit * 3 : limit;
	const topIds = scored.slice(0, preHydrate).map((s) => s.id);

	if (topIds.length === 0) {
		return { results: [], query, method: "hybrid" };
	}

	// --- Fetch full memory rows ---
	// Scope filter on hydration catches any results that bypassed
	// the FTS filter clause (e.g. unscoped graph boost results).
	// Agent scope filter also applied here to catch vector/traversal
	// results that bypass FTS-level agent filtering.
	const scopeClause =
		params.scope !== undefined
			? params.scope === null
				? " AND m.scope IS NULL"
				: " AND m.scope = ?"
			: " AND m.scope IS NULL";
	const scopeArgs: unknown[] = params.scope !== undefined && params.scope !== null ? [params.scope] : [];
	const agentScope =
		params.agentId && params.readPolicy
			? buildAgentScopeClause(params.agentId, params.readPolicy, params.policyGroup ?? null)
			: { sql: "", args: [] };
	const placeholders = topIds.map(() => "?").join(", ");

	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT m.id, m.content, m.source_id, m.type, m.tags, m.pinned, m.importance, m.who, m.project, m.created_at
        FROM memories m
        WHERE m.id IN (${placeholders})${scopeClause}${agentScope.sql}`,
				)
				.all(...topIds, ...scopeArgs, ...agentScope.args) as Array<{
				id: string;
				content: string;
				source_id: string | null;
				type: string;
				tags: string | null;
				pinned: number;
				importance: number;
				who: string;
				project: string | null;
				created_at: string;
			}>,
	);

	// Update access tracking (don't fail if this fails)
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memories
          SET last_accessed = datetime('now'), access_count = access_count + 1
          WHERE id IN (${placeholders})`,
			).run(...topIds);
		});
	} catch (e) {
		logger.warn("memory", "Failed to update access tracking", e as Error);
	}

	const rowMap = new Map(rows.map((r) => [r.id, r]));
	const recallTruncate = cfg.pipelineV2.guardrails.recallTruncateChars;
	const results: RecallResult[] = scored
		.slice(0, limit)
		.filter((s) => rowMap.has(s.id))
		.map((s) => {
			const r = rowMap.get(s.id)!;
			const isTruncated = r.content.length > recallTruncate;
			return {
				id: r.id,
				content: isTruncated ? `${r.content.slice(0, recallTruncate)} [truncated]` : r.content,
				content_length: r.content.length,
				truncated: isTruncated,
				score: Math.round(s.score * 100) / 100,
				source: s.source,
				type: r.type,
				tags: r.tags,
				pinned: !!r.pinned,
				importance: r.importance,
				who: r.who,
				project: r.project,
				created_at: r.created_at,
			};
		});

	// --- Decision-rationale linking: auto-fetch linked rationale memories ---
	const decisionIds = results.filter((r) => r.type === "decision").map((r) => r.id);
	const existingIds = new Set(results.map((r) => r.id));

	if (decisionIds.length > 0 && cfg.pipelineV2.graph.enabled) {
		try {
			const supplementary = getDbAccessor().withReadDb((db) => {
				// Find entities linked to decision memories
				const dPlaceholders = decisionIds.map(() => "?").join(", ");
				const entityIds = db
					.prepare(
						`SELECT DISTINCT entity_id FROM memory_entity_mentions
							 WHERE memory_id IN (${dPlaceholders})`,
					)
					.all(...decisionIds) as Array<{ entity_id: string }>;

				if (entityIds.length === 0) return [];

				// Find rationale memories linked to same entities
				const ePlaceholders = entityIds.map(() => "?").join(", ");
				const eIds = entityIds.map((r) => r.entity_id);

				return db
					.prepare(
						`SELECT DISTINCT m.id, m.content, m.type, m.tags, m.pinned,
							        m.importance, m.who, m.project, m.created_at
							 FROM memory_entity_mentions mem
							 JOIN memories m ON m.id = mem.memory_id
							 WHERE mem.entity_id IN (${ePlaceholders})
							   AND m.type = 'rationale'
							   AND m.is_deleted = 0
							   ${scopeClause}${agentScope.sql}
							 LIMIT 10`,
					)
					.all(...eIds, ...scopeArgs, ...agentScope.args) as Array<{
					id: string;
					content: string;
					type: string;
					tags: string | null;
					pinned: number;
					importance: number;
					who: string;
					project: string | null;
					created_at: string;
				}>;
			});

			for (const r of supplementary) {
				if (existingIds.has(r.id)) continue;
				existingIds.add(r.id);
				const isTrunc = r.content.length > recallTruncate;
				results.push({
					id: r.id,
					content: isTrunc ? `${r.content.slice(0, recallTruncate)} [truncated]` : r.content,
					content_length: r.content.length,
					truncated: isTrunc,
					score: 0,
					source: "graph",
					type: r.type,
					tags: r.tags,
					pinned: !!r.pinned,
					importance: r.importance,
					who: r.who,
					project: r.project,
					created_at: r.created_at,
					supplementary: true,
				});
			}
		} catch (e) {
			logger.warn("memory", "Rationale linking failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Entity context + constructed memories (DP-7) ---
	let entityContext: RecallResponse["entities"];
	let focalEids: string[] = [];

	if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.traversal?.enabled) {
		try {
			const queryTokens = tokenizeGraphQuery(query);
			if (queryTokens.length > 0) {
				const agentId = params.agentId ?? "default";
				const ctx = getDbAccessor().withReadDb((db) => {
					const focal = resolveFocalEntities(db, agentId, { queryTokens });
					if (focal.entityIds.length === 0) return null;

					// Scope-filter: only include entities mentioned in
					// in-scope memories so unscoped entities (codebase
					// concepts etc.) don't pollute scoped searches.
					let eids = focal.entityIds;
					if (params.scope !== undefined) {
						const ph = eids.map(() => "?").join(", ");
						const sc = params.scope === null ? "m.scope IS NULL" : "m.scope = ?";
						const sa: unknown[] = params.scope === null ? [] : [params.scope];
						const sr = db
							.prepare(
								`SELECT DISTINCT mem.entity_id
								 FROM memory_entity_mentions mem
								 JOIN memories m ON m.id = mem.memory_id
								 WHERE mem.entity_id IN (${ph})
								   AND ${sc} AND m.is_deleted = 0`,
							)
							.all(...eids, ...sa) as Array<{ entity_id: string }>;
						eids = sr.map((r) => r.entity_id);
						if (eids.length === 0) return null;
					}

					const placeholders = eids.map(() => "?").join(", ");
					const entities = db
						.prepare(
							`SELECT id, name, entity_type FROM entities
							 WHERE id IN (${placeholders})`,
						)
						.all(...eids) as Array<{
						id: string;
						name: string;
						entity_type: string;
					}>;

					const structured = entities
						.map((ent) => {
							const aspects = db
								.prepare(
									`SELECT id, name FROM entity_aspects
								 WHERE entity_id = ? AND agent_id = ?
								 ORDER BY weight DESC LIMIT 10`,
								)
								.all(ent.id, agentId) as Array<{ id: string; name: string }>;

							return {
								name: ent.name,
								type: ent.entity_type,
								aspects: aspects
									.map((asp) => {
										const attrs = db
											.prepare(
												`SELECT content, status, importance FROM entity_attributes
										 WHERE aspect_id = ? AND agent_id = ? AND status = 'active'
										 ORDER BY importance DESC LIMIT 5`,
											)
											.all(asp.id, agentId) as Array<{
											content: string;
											status: string;
											importance: number;
										}>;
										return { name: asp.name, attributes: attrs };
									})
									.filter((a) => a.attributes.length > 0),
							};
						})
						.filter((e) => e.aspects.length > 0);

					return { eids, structured };
				});

				if (ctx) {
					entityContext = ctx.structured;
					focalEids = ctx.eids;
				}
			}
		} catch (e) {
			logger.warn("memory", "Entity context fetch failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Constructed memories: synthesize from graph paths (DP-7) ---
	// Constructed cards use structural density as their score, which is
	// query-independent. To prevent large entity cards from outranking
	// actual memories that answer the query, cap their scores below the
	// lowest real result score.
	if (focalEids.length > 0) {
		try {
			const agentId = params.agentId ?? "default";
			const cap = Math.max(3, Math.ceil(limit * 0.3));
			const blocks = getDbAccessor().withReadDb((db) => constructContextBlocks(db, agentId, focalEids, cap));
			const now = new Date().toISOString();
			const minReal = results.length > 0 ? Math.min(...results.map((r) => r.score)) : 0.5;
			const maxConstructed = Math.max(0.01, minReal - 0.01);
			let added = 0;
			for (const block of blocks) {
				if (added >= cap) break;
				const syntheticId = `constructed:${block.provenance.entityName}`;
				if (existingIds.has(syntheticId)) continue;
				existingIds.add(syntheticId);
				added++;

				results.push({
					id: syntheticId,
					content: block.content,
					content_length: block.content.length,
					truncated: false,
					score: Math.round(Math.min(block.score, maxConstructed) * 100) / 100,
					source: "constructed",
					type: "semantic",
					tags: null,
					pinned: false,
					importance: 0.85,
					who: "",
					project: null,
					created_at: now,
					supplementary: true,
				});
			}
		} catch (e) {
			logger.warn("memory", "Constructed context failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Lossless expansion: fetch raw session transcripts ---
	let sources: Record<string, string> | undefined;
	if (params.expand) {
		try {
			const keys = [
				...new Set([...rowMap.values()].map((r) => r.source_id).filter((s): s is string => s !== null && s !== "")),
			];
			if (keys.length > 0) {
				const ph = keys.map(() => "?").join(", ");
				const agentId = params.agentId ?? "default";
				const transcripts = getDbAccessor().withReadDb(
					(db) =>
						db
							.prepare(
								`SELECT session_key, content FROM session_transcripts
								 WHERE agent_id = ? AND session_key IN (${ph})`,
							)
							.all(agentId, ...keys) as Array<{ session_key: string; content: string }>,
				);
				if (transcripts.length > 0) {
					sources = {};
					for (const t of transcripts) sources[t.session_key] = t.content;
				}
			}
		} catch {
			// Non-fatal — table may not exist pre-migration
		}
	}

	return {
		results,
		query,
		method: vectorMap.size > 0 ? "hybrid" : "keyword",
		entities: entityContext && entityContext.length > 0 ? entityContext : undefined,
		sources,
	};
}

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
import type { EmbeddingConfig, ResolvedMemoryConfig } from "./memory-config";
import { getGraphBoostIds, tokenizeGraphQuery } from "./pipeline/graph-search";
import {
	resolveFocalEntities,
	setTraversalStatus,
	traverseKnowledgeGraph,
} from "./pipeline/graph-traversal";
import { type RerankCandidate, noopReranker, rerank } from "./pipeline/reranker";
import { createEmbeddingReranker } from "./pipeline/reranker-embedding";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecallParams {
	query: string;
	keywordQuery?: string;
	limit?: number;
	agentId?: string;
	type?: string;
	tags?: string;
	who?: string;
	pinned?: boolean;
	importance_min?: number;
	since?: string;
	until?: string;
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
}

export type EmbedFn = (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;

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

	return {
		sql: parts.length ? ` AND ${parts.join(" AND ")}` : "",
		args,
	};
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
	const keywordQuery = (params.keywordQuery ?? params.query).trim();
	const limit = params.limit ?? 10;
	const alpha = cfg.search.alpha;
	const minScore = cfg.search.min_score;

	const filter = buildFilterClause(params);

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
			const maxRaw =
				rawScores.length > 0 ? Math.max(...rawScores) : 1;
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

	// --- Vector search via sqlite-vec ---
	const vectorMap = new Map<string, number>();
	let queryVecF32: Float32Array | null = null;
	try {
		const queryVec = await embedFn(query, cfg.embedding);
		if (queryVec) {
			queryVecF32 = new Float32Array(queryVec);
			getDbAccessor().withReadDb((db) => {
				const vecResults = vectorSearch(db as any, queryVecF32!, {
					limit: cfg.search.top_k,
					type: params.type as "fact" | "preference" | "decision" | undefined,
				});
				for (const r of vecResults) {
					vectorMap.set(r.id, r.score);
				}
			});
		}
	} catch (e) {
		logger.warn("memory", "Vector search failed, using keyword only", {
			error: String(e),
		});
	}

	// --- Merge scores ---
	const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
	const scored: Array<{ id: string; score: number; source: string }> = [];

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

		if (score >= minScore) scored.push({ id, score, source });
	}

	scored.sort((a, b) => b.score - a.score);

	// --- Rehearsal boost: frequently accessed memories rank higher ---
	if (cfg.search.rehearsal_enabled && cfg.search.rehearsal_weight > 0 && scored.length > 0) {
		try {
			const rehearsalIds = scored.map((s) => s.id);
			const placeholders = rehearsalIds.map(() => "?").join(", ");
			const accessRows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT id, access_count, last_accessed
							 FROM memories
							 WHERE id IN (${placeholders})`,
						)
						.all(...rehearsalIds) as Array<{
						id: string;
						access_count: number;
						last_accessed: string | null;
					}>,
			);

			const nowMs = Date.now();
			const rw = cfg.search.rehearsal_weight;

			const accessMap = new Map(accessRows.map((r) => [r.id, r]));
			for (const s of scored) {
				const row = accessMap.get(s.id);
				if (!row || row.access_count <= 0) continue;

				const daysSinceAccess = row.last_accessed
					? (nowMs - new Date(row.last_accessed).getTime()) / 86_400_000
					: cfg.search.rehearsal_half_life_days;
				const recencyFactor = 0.5 ** (daysSinceAccess / cfg.search.rehearsal_half_life_days);
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

	// --- Graph boost: pull up memories linked via knowledge graph ---
	if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.graph.boostWeight > 0) {
		try {
			const graphResult = getDbAccessor().withReadDb((db) =>
				getGraphBoostIds(query, db, cfg.pipelineV2.graph.boostTimeoutMs),
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
				const focal = getDbAccessor().withReadDb((db) =>
					resolveFocalEntities(db, agentId, { queryTokens }),
				);

				if (focal.entityIds.length > 0) {
					const traversal = getDbAccessor().withReadDb((db) =>
						traverseKnowledgeGraph(focal.entityIds, db, agentId, {
							maxAspectsPerEntity: traversalCfg.maxAspectsPerEntity,
							maxAttributesPerAspect: traversalCfg.maxAttributesPerAspect,
							maxDependencyHops: traversalCfg.maxDependencyHops,
							minDependencyStrength: traversalCfg.minDependencyStrength,
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
										 GROUP BY m.id, m.importance`,
									)
									.all(agentId, ...missingIds) as Array<{
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

	const topIds = scored.slice(0, limit).map((s) => s.id);

	if (topIds.length === 0) {
		return { results: [], query, method: "hybrid" };
	}

	// --- Fetch full memory rows ---
	const placeholders = topIds.map(() => "?").join(", ");

	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT id, content, type, tags, pinned, importance, who, project, created_at
        FROM memories
        WHERE id IN (${placeholders})`,
				)
				.all(...topIds) as Array<{
				id: string;
				content: string;
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
							 LIMIT 10`,
					)
					.all(...eIds) as Array<{
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

	return {
		results,
		query,
		method: vectorMap.size > 0 ? "hybrid" : "keyword",
	};
}

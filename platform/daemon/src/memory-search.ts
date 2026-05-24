/**
 * Hybrid recall search orchestration.
 *
 * This module turns a user query into a bounded, authorized recall response.
 * The route handler in daemon.ts owns HTTP parsing and permissions; this file
 * owns retrieval mechanics, score shaping, fallback sources, and response
 * assembly.
 *
 * The critical invariant is ordering: broad candidate IDs may come from vector
 * search, graph traversal, or source rescue paths, but memory content must not
 * be loaded for reranking, dampening, summaries, expansion, or access tracking
 * until the shared scope/project/agent filter has authorized those IDs.
 */

import { createHash } from "node:crypto";
import {
	LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE,
	SOURCE_CHUNK_SOURCE_TYPE,
	type LlmUsage,
	vectorSearch,
} from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { getLlmProvider } from "./llm";
import { logger } from "./logger";
import type { EmbeddingConfig, MemorySearchConfig, ResolvedMemoryConfig } from "./memory-config";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";
import { constructContextBlocks } from "./pipeline/context-construction";
import { DEFAULT_DAMPENING, type ScoredRow, applyDampening } from "./pipeline/dampening";
import { getGraphBoostIds, tokenizeGraphQuery } from "./pipeline/graph-search";
import { resolveFocalEntities, setTraversalStatus, traverseKnowledgeGraph } from "./pipeline/graph-traversal";
import { type RerankCandidate, noopReranker, rerank } from "./pipeline/reranker";
import { createEmbeddingReranker } from "./pipeline/reranker-embedding";
import { createLlmReranker, summarizeRecallWithLlm } from "./pipeline/reranker-llm";
import { FTS_STOP } from "./pipeline/stop-words";
import {
	type EvidenceCandidateInput,
	shapeByFacetCoverage,
	shapeStructuredEvidence,
} from "./pipeline/structured-evidence";
import { findStructuredPathCandidates, scoreStructuredPathEvidence } from "./pipeline/structured-path-evidence";
import { type RecallDedupeMeta, applyRecallDedupe } from "./session-recall-dedupe";
import { escapeLike } from "./sql-utils";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecallParams {
	query: string;
	keywordQuery?: string;
	limit?: number;
	aggregate?: boolean;
	aggregateBudget?: "small" | "medium" | "large";
	aggregate_budget?: "small" | "medium" | "large";
	saveAggregate?: boolean;
	save_aggregate?: boolean;
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
	/** Enables per-session context dedupe when present. Sessionless recall is unchanged. */
	sessionKey?: string;
	/** Return already-recalled rows and annotate them instead of suppressing them. */
	includeRecalled?: boolean;
	/** Restrict recall to source-backed artifacts/chunks instead of normal memory rows. */
	sourceOnly?: boolean;
	/** Internal ledger metadata for call-site attribution. */
	recallSurface?: string;
	recallMode?: string;
	/** Internal escape hatch for hooks that must claim only injected rows. */
	claimRecallResults?: boolean;
	/** Internal escape hatch for hooks that must track only injected rows elsewhere. */
	trackRecallAccess?: boolean;
}

export interface RecallResult {
	id: string;
	content: string;
	content_length: number;
	truncated: boolean;
	score: number;
	source: string;
	source_id?: string;
	session_id?: string;
	source_path?: string;
	type: string;
	tags: string | null;
	pinned: boolean;
	importance: number;
	who: string;
	project: string | null;
	created_at: string;
	visibility?: string | null;
	scope?: string | null;
	supplementary?: boolean;
	already_recalled?: boolean;
}

export interface RecallResponse {
	results: RecallResult[];
	query: string;
	method: "hybrid" | "keyword";
	meta: {
		totalReturned: number;
		hasSupplementary: boolean;
		noHits: boolean;
		timings: RecallTimings;
		dedupe?: RecallDedupeMeta;
	};
	aggregate?: {
		savedMemoryId: string | null;
		saved: boolean;
		deduped: boolean;
		budget: "small" | "medium" | "large";
		queries: readonly string[];
		sourceMemoryIds: readonly string[];
		stoppedReason: "complete" | "no_evidence" | "router_unavailable" | "synthesis_failed";
		usage?: AggregateRecallUsage;
	};
	entities?: Array<{
		name: string;
		type: string;
		aspects: Array<{
			name: string;
			attributes: Array<{ content: string; status: string; importance: number }>;
		}>;
	}>;
}

export interface AggregateRecallUsage extends LlmUsage {
	readonly stages: readonly AggregateRecallUsageStage[];
}

export interface AggregateRecallUsageStage extends LlmUsage {
	readonly name: "planning" | "synthesis";
	readonly targetRef: string | null;
	readonly attemptCount: number;
	readonly fallbackCount: number;
}

export type EmbedFn = (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;

export interface RecallStageTiming {
	name: string;
	durationMs: number;
}

export interface RecallTimings {
	totalMs: number;
	stages: RecallStageTiming[];
}

type UntimedRecallResponse = Omit<RecallResponse, "meta"> & {
	meta: Omit<RecallResponse["meta"], "timings">;
};

const RECALL_TIMING_LOG_THRESHOLD_MS = 1000;

function roundDuration(ms: number): number {
	return Math.round(ms * 100) / 100;
}

function createRecallTimingCollector(): {
	readonly record: (name: string, start: number) => void;
	readonly time: <T>(name: string, fn: () => T) => T;
	readonly timeAsync: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
	readonly finish: () => RecallTimings;
} {
	const start = performance.now();
	const stages: RecallStageTiming[] = [];
	const record = (name: string, stageStart: number): void => {
		stages.push({ name, durationMs: roundDuration(performance.now() - stageStart) });
	};
	return {
		record,
		time<T>(name: string, fn: () => T): T {
			const stageStart = performance.now();
			try {
				return fn();
			} finally {
				record(name, stageStart);
			}
		},
		async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
			const stageStart = performance.now();
			try {
				return await fn();
			} finally {
				record(name, stageStart);
			}
		},
		finish(): RecallTimings {
			return {
				totalMs: roundDuration(performance.now() - start),
				stages: [...stages],
			};
		},
	};
}

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
	if (readPolicy === "group" && policyGroup) {
		return {
			sql: " AND ((m.visibility = 'global' AND m.agent_id IN (SELECT id FROM agents WHERE policy_group = ?)) OR m.agent_id = ?) AND m.visibility != 'archived'",
			args: [policyGroup, agentId],
		};
	}
	// 'isolated', 'group' without policyGroup, or unknown — own memories only
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
			parts.push("m.tags LIKE ? ESCAPE '\\'");
			args.push(`%${escapeLike(t)}%`);
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

	// Agent visibility filtering defaults to isolated when an agent is known.
	if (params.agentId) {
		const scope = buildAgentScopeClause(params.agentId, params.readPolicy ?? "isolated", params.policyGroup ?? null);
		return { sql: base.sql + scope.sql, args: [...base.args, ...scope.args] };
	}

	return base;
}

function hasMemoryMetadataFilters(params: RecallParams): boolean {
	const hasTags =
		params.tags
			?.split(",")
			.map((tag) => tag.trim())
			.some(Boolean) === true;
	return (
		params.type !== undefined ||
		hasTags ||
		params.who !== undefined ||
		params.pinned === true ||
		typeof params.importance_min === "number" ||
		params.since !== undefined ||
		params.until !== undefined ||
		params.scope !== undefined
	);
}

function normalizeRecallLimit(raw: number | undefined): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 10;
	return Math.max(1, Math.min(50, Math.floor(raw)));
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

const BAKING_QUERY_TRIGGERS = new Set([
	"bake",
	"baked",
	"baking",
	"brownie",
	"brownies",
	"cake",
	"cakes",
	"chocolate",
	"cookie",
	"cookies",
	"dessert",
	"desserts",
	"pastry",
	"pastries",
	"recipe",
	"recipes",
]);

const BAKING_QUERY_EXPANSIONS = [
	"baking",
	"dessert",
	"desserts",
	"flavor",
	"flavour",
	"ingredient",
	"ingredients",
	"recipe",
	"recipes",
	"sugar",
	"texture",
] as const;

const ENTERTAINMENT_QUERY_TRIGGERS = new Set([
	"documentary",
	"documentaries",
	"film",
	"films",
	"movie",
	"movies",
	"netflix",
	"show",
	"shows",
	"streaming",
	"television",
	"tv",
	"watch",
	"watching",
]);

const ENTERTAINMENT_QUERY_EXPANSIONS = [
	"comedy",
	"documentary",
	"film",
	"hulu",
	"netflix",
	"show",
	"stand up",
	"storytelling",
	"streaming",
	"television",
	"tv",
	"watchlist",
] as const;

function normalizeExpansionToken(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.trim();
	if (!cleaned) return "";
	if (cleaned.endsWith("ies") && cleaned.length > 4) return `${cleaned.slice(0, -3)}y`;
	if (cleaned.endsWith("s") && cleaned.length > 3) return cleaned.slice(0, -1);
	return cleaned;
}

/**
 * Add a small set of mechanical recall expansions for common class-to-instance
 * gaps. This intentionally stays conservative: it only fires for explicit
 * baking/recipe terms, and it feeds FTS/hints only. Semantic vector search and
 * answer generation still see the user's original query.
 */
export function expandRecallKeywordQuery(raw: string): string {
	const tokens = raw
		.split(/\s+/)
		.map(normalizeExpansionToken)
		.filter((token) => token.length >= 2 && !FTS_STOP.has(token));

	const expansions: string[] = [];
	const existing = new Set(tokens);
	const addMissing = (items: readonly string[]): void => {
		for (const item of items) {
			const normalized = normalizeExpansionToken(item);
			if (!existing.has(normalized) && !expansions.includes(item)) expansions.push(item);
		}
	};

	if (tokens.some((token) => BAKING_QUERY_TRIGGERS.has(token))) {
		addMissing(BAKING_QUERY_EXPANSIONS);
	}
	if (tokens.some((token) => ENTERTAINMENT_QUERY_TRIGGERS.has(token))) {
		addMissing(ENTERTAINMENT_QUERY_EXPANSIONS);
	}

	if (expansions.length === 0) return raw;
	return `${raw} ${expansions.join(" ")}`;
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

function mergeCandidate(
	rows: Map<string, { id: string; score: number; source: string }>,
	row: { id: string; score: number; source: string },
): void {
	const existing = rows.get(row.id);
	if (!existing || row.score > existing.score) {
		rows.set(row.id, row);
	}
}

function authorizeScoredCandidates(
	scored: ReadonlyArray<{ id: string; score: number; source: string }>,
	filter: FilterClause,
): Array<{ id: string; score: number; source: string }> {
	// Candidate collectors intentionally cast a wide net. This is the single
	// pre-content gate for database-backed memories: after this point the IDs
	// are safe to use in stages that read content or mutate access metadata.
	const ids = [...new Set(scored.map((row) => row.id))];
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	const allowed = getDbAccessor().withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT m.id
				 FROM memories m
				 WHERE m.id IN (${placeholders})
				   AND m.is_deleted = 0${filter.sql}`,
			)
			.all(...ids, ...filter.args) as Array<{ id: string }>;
		return new Set(rows.map((row) => row.id));
	});
	return scored.filter((row) => allowed.has(row.id));
}

interface CurrentnessInfo {
	readonly active: readonly string[];
	readonly superseded: ReadonlyArray<{
		readonly content: string;
		readonly replacement: string | null;
	}>;
}

function shortenCurrentnessContent(content: string): string {
	const oneLine = content.replace(/\s+/g, " ").trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

function loadCurrentnessInfo(ids: readonly string[], agentId: string): Map<string, CurrentnessInfo> {
	if (ids.length === 0) return new Map();
	const placeholders = ids.map(() => "?").join(", ");
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT
						 ea.memory_id,
						 ea.content,
						 ea.status,
						 replacement.content AS replacement_content
					 FROM entity_attributes ea
					 LEFT JOIN entity_attributes replacement
					   ON replacement.id = ea.superseded_by
					  AND replacement.agent_id = ea.agent_id
					 WHERE ea.memory_id IN (${placeholders})
					   AND ea.agent_id = ?
					   AND ea.status IN ('active', 'superseded')
					 ORDER BY ea.importance DESC, ea.created_at DESC`,
				)
				.all(...ids, agentId) as Array<{
				memory_id: string;
				content: string;
				status: string;
				replacement_content: string | null;
			}>,
	);

	const mutable = new Map<
		string,
		{ active: string[]; superseded: Array<{ content: string; replacement: string | null }> }
	>();
	for (const row of rows) {
		const existing = mutable.get(row.memory_id) ?? { active: [], superseded: [] };
		if (row.status === "active" && existing.active.length < 3) {
			existing.active.push(shortenCurrentnessContent(row.content));
		}
		if (row.status === "superseded" && existing.superseded.length < 3) {
			existing.superseded.push({
				content: shortenCurrentnessContent(row.content),
				replacement: row.replacement_content ? shortenCurrentnessContent(row.replacement_content) : null,
			});
		}
		mutable.set(row.memory_id, existing);
	}
	return new Map(mutable);
}

function applyCurrentnessBias(
	scored: Array<{ id: string; score: number; source: string }>,
	currentness: ReadonlyMap<string, CurrentnessInfo>,
): void {
	for (const row of scored) {
		const info = currentness.get(row.id);
		if (!info) continue;
		if (info.active.length === 0 && info.superseded.length > 0) {
			row.score *= 0.65;
			continue;
		}
		if (info.superseded.length > 0) {
			row.score *= 0.85;
			continue;
		}
		if (info.active.length > 0) {
			row.score *= 1.03;
		}
	}
	scored.sort((a, b) => b.score - a.score);
}

function annotateCurrentness(content: string, info: CurrentnessInfo | undefined): string {
	if (!info || info.superseded.length === 0) return content;
	const lines = ["[Signet currentness]"];
	if (info.active.length > 0) {
		lines.push("Current structured facts:");
		for (const item of info.active) lines.push(`- ${item}`);
	}
	if (info.superseded.length > 0) {
		lines.push("Superseded structured facts, historical unless the question asks about the past:");
		for (const item of info.superseded) {
			lines.push(`- ${item.content}`);
			if (item.replacement) lines.push(`  Current replacement: ${item.replacement}`);
		}
	}
	return `${lines.join("\n")}\n\n${content}`;
}

interface NativeArtifactRecallHit {
	readonly rowid: number;
	readonly sourcePath: string;
	readonly sourceKind: string;
	readonly harness: string | null;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly content: string;
	readonly rank: number;
}

interface SourceChunkVectorHit {
	readonly embeddingId: string;
	readonly sourceId: string;
	readonly sourceType: string;
	readonly sourcePath: string;
	readonly chunkText: string;
	readonly score: number;
	readonly createdAt: string;
	readonly project: string | null;
}

function nativeIdSegment(value: string | null | undefined): string {
	return (
		value
			?.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unknown"
	);
}

function nativeArtifactPublicId(hit: NativeArtifactRecallHit): string {
	const digest = createHash("sha256").update(hit.sourcePath).digest("hex").slice(0, 16);
	return `native:${nativeIdSegment(hit.harness)}:${nativeIdSegment(hit.sourceKind)}:${digest}`;
}

function nativeArtifactRecallContent(hit: NativeArtifactRecallHit): string {
	if (hit.harness === "obsidian") {
		return `[Obsidian vault note: ${hit.sourcePath}]\n${hit.content}`;
	}
	return `[Native ${hit.harness ?? "harness"} memory: ${hit.sourcePath}]\n${hit.content}`;
}

function nativeArtifactRecallSource(hit: NativeArtifactRecallHit): string {
	return hit.harness === "obsidian" ? "source_obsidian" : "native_memory";
}

function nativeArtifactRecallTags(hit: NativeArtifactRecallHit): string {
	return [hit.harness, hit.harness === "obsidian" ? "source" : "native-memory", hit.sourceKind]
		.filter(Boolean)
		.join(",");
}

function sourcePathFromChunkText(chunkText: string): string {
	const line = chunkText.split("\n").find((part) => part.toLowerCase().startsWith("source_path:"));
	return line?.slice("source_path:".length).trim() ?? "";
}

function sourceChunkRecallSource(sourceId: string): string {
	return sourceId.startsWith("obsidian:") ? "source_obsidian" : "source";
}

function sourceChunkProvider(sourceId: string): string {
	const separator = sourceId.indexOf(":");
	return separator > 0 ? sourceId.slice(0, separator) : "source";
}

function sourceChunkRecallTags(hit: SourceChunkVectorHit): string {
	const provider = sourceChunkProvider(hit.sourceId);
	return [provider, "source", hit.sourceType, "vector"].join(",");
}

function buildSourceChunkVectorHits(
	queryVec: Float32Array | null,
	existingSourceIds: ReadonlySet<string>,
	limit: number,
	agentId: string,
	project?: string,
): SourceChunkVectorHit[] {
	if (!queryVec || limit <= 0) return [];
	// Source chunk embeddings only carry agent_id plus an embedding source_id.
	// The live artifact table carries project, but not the source root/id needed
	// to bind an embedding to that project without filename spoofing. Skip this
	// rescue path for project-scoped recall until the index has that strong key.
	if (project) return [];
	try {
		return getDbAccessor().withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT id, source_type, source_id, vector, chunk_text, created_at
					 FROM embeddings
					 WHERE source_type IN (?, ?)
					   AND vector IS NOT NULL
					   AND agent_id = ?`,
				)
				.all(SOURCE_CHUNK_SOURCE_TYPE, LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE, agentId) as Array<{
				id: string;
				source_type: string;
				source_id: string;
				vector: Buffer;
				chunk_text: string;
				created_at: string;
			}>;
			return rows
				.flatMap((row) => {
					const sourcePath = sourcePathFromChunkText(row.chunk_text);
					return [
						{
							embeddingId: row.id,
							sourceId: row.source_id,
							sourceType: row.source_type,
							sourcePath,
							chunkText: row.chunk_text,
							score: cosineSimilarity(
								queryVec,
								new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
							),
							createdAt: row.created_at,
							project: null,
						},
					];
				})
				.filter((row) => row.score > 0 && !existingSourceIds.has(row.sourceId))
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
		});
	} catch (e) {
		logger.warn("memory", "Source chunk vector recall failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
		return [];
	}
}

function sessionIdFromSourceId(sourceId: string): string {
	const index = sourceId.lastIndexOf(":");
	return index >= 0 ? sourceId.slice(index + 1) : sourceId;
}

function expandTranscriptTerms(terms: readonly string[]): string[] {
	const expanded = new Set(terms);
	const add = (from: string, variants: readonly string[]): void => {
		if (!expanded.has(from)) return;
		for (const variant of variants) expanded.add(variant);
	};
	add("meet", ["met", "meeting"]);
	add("met", ["meet", "meeting"]);
	add("buy", ["bought", "got", "purchased", "acquired"]);
	add("bought", ["buy", "got", "purchased", "acquired"]);
	add("purchase", ["purchased", "bought", "got", "acquired"]);
	add("investment", ["invest", "invested", "investing"]);
	return [...expanded];
}

function scoreTranscriptWindow(
	window: string,
	terms: readonly string[],
	wantsQuantity: boolean,
	wantsTemporal: boolean,
): number {
	const lower = window.toLowerCase();
	const matched = terms.filter((term) => lower.includes(term));
	const density = matched.reduce((sum, term) => sum + Math.min(term.length, 12), 0);
	const quantityBonus = wantsQuantity && /\b\d+(?:[.,]\d+)?\b/.test(window) ? 8 : 0;
	const temporalBonus =
		wantsTemporal &&
		/\b(ago|week|weeks|month|months|year|years|today|yesterday|last|next|earlier|later)\b|\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
			window,
		)
			? 10
			: 0;
	return matched.length * 20 + density + quantityBonus + temporalBonus;
}

export function transcriptExcerpt(content: string, query: string, maxChars = 650): string {
	const clean = content.replace(/\s+/g, " ").trim();
	if (clean.length <= maxChars) return clean;

	const weakTerms = new Set([
		"brand",
		"brands",
		"conversation",
		"end",
		"going",
		"high",
		"previous",
		"recommend",
		"recommendation",
		"recommendations",
		"remind",
		"show",
		"tonight",
		"watch",
		"wondering",
	]);
	const terms = expandTranscriptTerms(
		expandRecallKeywordQuery(query)
			.toLowerCase()
			.split(/\W+/)
			.map(normalizeExpansionToken)
			.filter((term, index, all) => term.length >= 3 && !FTS_STOP.has(term) && all.indexOf(term) === index)
			.sort((a, b) => Number(weakTerms.has(a)) - Number(weakTerms.has(b)) || b.length - a.length)
			.slice(0, 12),
	);
	const lower = clean.toLowerCase();
	const wantsQuantity = /\b(how many|how much|count|number|total)\b/i.test(query);
	const wantsTemporal = /\b(first|before|after|earlier|later|ago|week|month|year|when|date)\b/i.test(query);
	let best = -1;
	let bestScore = -1;
	for (const term of terms) {
		let from = 0;
		let seen = 0;
		while (seen < 8) {
			const index = lower.indexOf(term, from);
			if (index === -1) break;
			const start = Math.max(0, index - Math.floor(maxChars * 0.35));
			const window = clean.slice(start, Math.min(clean.length, start + maxChars));
			const score = scoreTranscriptWindow(window, terms, wantsQuantity, wantsTemporal);
			if (score > bestScore) {
				bestScore = score;
				best = index;
			}
			from = index + term.length;
			seen++;
		}
	}

	if (best === -1) return `${clean.slice(0, maxChars - 3).trim()}...`;
	const start = Math.max(0, best - Math.floor(maxChars * 0.35));
	const end = Math.min(clean.length, start + maxChars);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < clean.length ? "..." : "";
	return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

function buildNativeArtifactRecallHits(
	params: RecallParams,
	query: string,
	existingSourceIds: ReadonlySet<string>,
): NativeArtifactRecallHit[] {
	const fts = sanitizeFtsQuery(query);
	if (fts.length === 0) return [];

	try {
		return getDbAccessor().withReadDb((db) => {
			const table = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_artifacts_fts'`)
				.get();
			if (!table) return [];

			const parts = [
				"SELECT ma.rowid, ma.source_path, ma.source_kind, ma.harness, ma.project,",
				"COALESCE(ma.updated_at, ma.captured_at) AS updated_at, ma.content,",
				"bm25(memory_artifacts_fts) AS rank",
				"FROM memory_artifacts_fts",
				"JOIN memory_artifacts ma ON ma.rowid = memory_artifacts_fts.rowid",
				"WHERE memory_artifacts_fts MATCH ?",
				"AND ma.agent_id = ?",
				"AND (ma.source_kind LIKE 'native_%' OR ma.source_kind LIKE 'source_%')",
				"AND COALESCE(ma.is_deleted, 0) = 0",
				"AND ma.source_node_id = ?",
				"AND ma.harness IS NOT NULL",
			];
			const args: unknown[] = [fts, params.agentId ?? "default", NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID];
			if (params.project) {
				parts.push("AND (ma.project = ? OR ma.project IS NULL)");
				args.push(params.project);
			}
			parts.push("ORDER BY rank ASC, updated_at DESC LIMIT ?");
			args.push(Math.max(2, Math.min(50, params.limit ?? 10) + existingSourceIds.size));

			const rows = db.prepare(parts.join("\n")).all(...args) as Array<{
				rowid: number;
				source_path: string;
				source_kind: string;
				harness: string | null;
				project: string | null;
				updated_at: string;
				content: string;
				rank: number;
			}>;

			const maxRank = rows.reduce((max, row) => Math.max(max, Math.abs(row.rank)), 1);
			return rows
				.map((row) => ({
					rowid: row.rowid,
					sourcePath: row.source_path,
					sourceKind: row.source_kind,
					harness: row.harness,
					project: row.project,
					updatedAt: row.updated_at,
					content: transcriptExcerpt(row.content, query, 900),
					rank: maxRank > 0 ? Math.abs(row.rank) / maxRank : 0.2,
				}))
				.filter((row) => row.content.length > 0 && !existingSourceIds.has(nativeArtifactPublicId(row)));
		});
	} catch (e) {
		logger.warn("memory", "Native artifact recall failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
		return [];
	}
}

function cosineSimilarity(query: Float32Array, memory: Float32Array): number {
	const len = Math.min(query.length, memory.length);
	let dot = 0;
	let queryNorm = 0;
	let memoryNorm = 0;
	for (let i = 0; i < len; i++) {
		const q = query[i] ?? 0;
		const m = memory[i] ?? 0;
		dot += q * m;
		queryNorm += q * q;
		memoryNorm += m * m;
	}
	const denom = Math.sqrt(queryNorm) * Math.sqrt(memoryNorm);
	if (denom <= 0) return 0;
	return Math.max(0, Math.min(1, dot / denom));
}

// ---------------------------------------------------------------------------
// Main search orchestration
// ---------------------------------------------------------------------------

// Hints are synthetic retrieval scouts. Pure hint matches should rescue recall,
// not outrank directly grounded lexical/vector/structured evidence. A hint
// supported by direct evidence can keep its score; only hint-only rows are capped.
const HINT_ONLY_SCORE_CAP = 0.75;

/**
 * Run the recall pipeline.
 *
 * The stages are deliberately split into two halves:
 *
 * 1. Candidate collection: FTS, hints, vector, structured path search, and
 *    graph traversal collect IDs and scores. These stages may over-fetch.
 * 2. Authorized content handling: after `authorize_candidates`, later stages
 *    may read content, call rerankers, apply dampening/currentness, hydrate
 *    results, and update access counts.
 *
 * Keep that boundary intact. It is what prevents high-recall channels such as
 * vector search and traversal from leaking out-of-scope content into model or
 * summary paths.
 */
export async function hybridRecall(
	params: RecallParams,
	cfg: ResolvedMemoryConfig,
	embedFn: EmbedFn,
): Promise<RecallResponse> {
	const query = params.query;
	const expandedQuery = expandRecallKeywordQuery(params.query);
	const keywordQuery = sanitizeFtsQuery((params.keywordQuery ?? expandedQuery).trim());
	const limit = normalizeRecallLimit(params.limit);
	const alpha = cfg.search.alpha;
	const minScore = cfg.search.min_score;
	const filter = buildFilterClause(params);
	const needsPostFilter = params.scope !== undefined || !!params.project || !!params.agentId;
	const timings = createRecallTimingCollector();
	const selectionSuppressedIds = new Set<string>();
	const selectionDedupeEnabled = !!params.sessionKey?.trim() && params.includeRecalled !== true;
	const suppressPreviouslyRecalledForSelection = <T extends RecallResult>(items: T[]): T[] => {
		if (!selectionDedupeEnabled || items.length === 0) return items;
		const deduped = applyRecallDedupe({
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			includeRecalled: false,
			surface: params.recallSurface ?? "recall",
			mode: params.recallMode ?? "direct",
			claim: false,
			items,
		});
		if (!deduped.meta.enabled) return items;
		const kept = new Set(deduped.items.map((row) => row.id));
		for (const item of items) {
			if (!kept.has(item.id)) selectionSuppressedIds.add(item.id);
		}
		return deduped.items;
	};
	const finish = async (response: UntimedRecallResponse): Promise<RecallResponse> => {
		const deduped = applyRecallDedupe({
			sessionKey: params.sessionKey,
			agentId: params.agentId,
			includeRecalled: params.includeRecalled,
			surface: params.recallSurface ?? "recall",
			mode: params.recallMode ?? "direct",
			claim: params.claimRecallResults !== false,
			items: response.results,
			markRepeated: (item) => ({ ...item, already_recalled: true }),
		});
		const dedupeMeta = deduped.meta.enabled
			? {
					...deduped.meta,
					suppressed: deduped.meta.suppressed + selectionSuppressedIds.size,
				}
			: deduped.meta;
		response.results = deduped.items;
		response.meta = {
			...response.meta,
			totalReturned: response.results.length,
			hasSupplementary: response.results.some((row) => row.supplementary === true),
			noHits: response.results.length === 0,
			...(dedupeMeta.enabled ? { dedupe: dedupeMeta } : {}),
		};
		try {
			const trackedIds = response.results.map((row) => row.id).filter((id) => !id.includes(":"));
			if (params.trackRecallAccess !== false && trackedIds.length > 0) {
				timings.time("access_tracking_update", () => {
					const trackedPlaceholders = trackedIds.map(() => "?").join(", ");
					getDbAccessor().withWriteTx((db) => {
						db.prepare(
							`UPDATE memories
							 SET last_accessed = datetime('now'), access_count = access_count + 1
							 WHERE id IN (
							   SELECT m.id
							   FROM memories m
							   WHERE m.id IN (${trackedPlaceholders})
							     AND m.is_deleted = 0${filter.sql}
							 )`,
						).run(...trackedIds, ...filter.args);
					});
				});
			}
		} catch (e) {
			logger.warn("memory", "Failed to update access tracking", e as Error);
		}
		const recallTimings = timings.finish();
		if (recallTimings.totalMs >= RECALL_TIMING_LOG_THRESHOLD_MS) {
			logger.warn("memory", "Recall stage timings", {
				agentId: params.agentId ?? "default",
				limit,
				resultCount: response.meta.totalReturned,
				totalMs: recallTimings.totalMs,
				stages: recallTimings.stages,
			});
		}
		return {
			...response,
			meta: {
				...response.meta,
				timings: recallTimings,
			},
		};
	};
	const queryVecPromise = (() => {
		const embeddingStart = performance.now();
		let promise: Promise<number[] | null>;
		try {
			promise = Promise.resolve(embedFn(query, cfg.embedding));
		} catch (e) {
			promise = Promise.reject(e);
		}
		const timed = promise.finally(() => {
			timings.record("query_embedding_total", embeddingStart);
		});
		// The actual error path is handled later at query_embedding_wait, but
		// Bun can report a fast rejection before synchronous DB work reaches it.
		timed.catch(() => undefined);
		return timed;
	})();
	let graphQueryTokens: string[] | undefined;
	let focalCache: { agentId: string; value: ReturnType<typeof resolveFocalEntities> } | null = null;
	const getGraphQueryTokens = (): string[] => {
		graphQueryTokens ??= tokenizeGraphQuery(query);
		return graphQueryTokens;
	};
	const getFocalEntities = (agentId: string): ReturnType<typeof resolveFocalEntities> => {
		if (focalCache?.agentId === agentId) return focalCache.value;
		const value = getDbAccessor().withReadDb((db) =>
			resolveFocalEntities(db, agentId, {
				queryTokens: getGraphQueryTokens(),
				includePinned: false,
			}),
		);
		focalCache = { agentId, value };
		return value;
	};

	// --- BM25 keyword search via FTS5 ---
	const bm25Map = new Map<string, number>();
	const hintMap = new Map<string, number>();
	const traversalEvidenceMap = new Map<string, number>();
	try {
		timings.time("memory_fts", () => {
			if (keywordQuery.length === 0) return;
			getDbAccessor().withReadDb((db) => {
				// CROSS JOIN keeps SQLite from scanning memories first via
				// low-selectivity filters before applying the FTS rowid match.
				const ftsRows = (
					db.prepare(`
        SELECT m.id, bm25(memories_fts) AS raw_score
        FROM memories_fts
        CROSS JOIN memories m ON memories_fts.rowid = m.rowid
        WHERE memories_fts MATCH ?
          AND m.is_deleted = 0${filter.sql}
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
			timings.time("hints_fts", () => {
				if (keywordQuery.length === 0) return;
				getDbAccessor().withReadDb((db) => {
					// Keep memory_hints_fts first; the agent/scope indexes are much
					// less selective than the FTS match on large workspaces.
					const sql = `SELECT h.memory_id AS id, bm25(memory_hints_fts) AS raw_score
					   FROM memory_hints_fts
					   CROSS JOIN memory_hints h ON memory_hints_fts.rowid = h.rowid
					   CROSS JOIN memories m ON m.id = h.memory_id
					   WHERE memory_hints_fts MATCH ?
					     AND h.agent_id = ?
					     AND m.is_deleted = 0${filter.sql}
					   ORDER BY raw_score LIMIT ?`;

					const agentId = params.agentId ?? "default";
					const args = [keywordQuery, agentId, ...filter.args, cfg.search.top_k];

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
						hintMap.set(row.id, Math.max(hintMap.get(row.id) ?? 0, hint));
					}
				});
			});
		} catch (e) {
			// memory_hints_fts may not exist on pre-038 databases — silent fallback
			logger.warn("memory", "Hints FTS query failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Query embedding (used by reranker even when vector search is skipped) ---
	// Start embedding before the synchronous lexical/structured DB work above.
	// Local embedding providers are often the slowest prompt-submit step, so
	// overlapping that I/O with candidate lookup reduces wall-clock latency
	// without changing the recall channels or final ranking math.
	let queryVecF32: Float32Array | null = null;
	try {
		const queryVec = await timings.timeAsync("query_embedding_wait", () => queryVecPromise);
		if (queryVec) queryVecF32 = new Float32Array(queryVec);
	} catch (e) {
		logger.warn("memory", "Embedding failed", { error: String(e) });
	}

	// --- Vector search via sqlite-vec ---
	// sqlite-vec cannot pre-filter by recall scope/project/agent policy, so
	// constrained queries over-fetch and rely on candidate authorization.
	// This keeps constrained queries eligible for vector similarity when graph
	// traversal yields no focal entities.
	const vectorMap = new Map<string, number>();
	if (queryVecF32) {
		const queryVector = queryVecF32;
		const vecLimit = needsPostFilter ? cfg.search.top_k * 2 : cfg.search.top_k;
		try {
			timings.time("vector_search", () => {
				getDbAccessor().withReadDb((db) => {
					const vecResults = vectorSearch(db as any, queryVector, {
						limit: vecLimit,
						type: params.type as "fact" | "preference" | "decision" | undefined,
					});
					for (const r of vecResults) {
						vectorMap.set(r.id, r.score);
					}
				});
			});
		} catch (e) {
			logger.warn("memory", "Vector search failed, using keyword only", {
				error: String(e),
			});
		}
	}
	const semanticEvidenceMap = new Map(vectorMap);

	// --- Structured path candidate search ---
	// SEC can only reshape memories that make it into the candidate pool.
	// Query the navigable entity/aspect/group/claim path directly so structured
	// memories can be recalled even when their raw prose does not share enough
	// surface text with the question.
	const structuredCandidateMap = new Map<string, number>();
	if (cfg.pipelineV2.graph.enabled) {
		try {
			const agentId = params.agentId ?? "default";
			const candidates = timings.time("structured_path_candidates", () =>
				getDbAccessor().withReadDb((db) =>
					findStructuredPathCandidates(db, query, agentId, {
						limit: cfg.search.top_k,
						minScore,
						filterSql: filter.sql,
						filterArgs: filter.args,
					}),
				),
			);
			for (const [id, score] of candidates) structuredCandidateMap.set(id, score);
		} catch (e) {
			logger.warn("memory", "Structured path candidate search failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// --- Flat search: merge BM25 + vector + structured path candidate scores ---
	const allIds = new Set([...bm25Map.keys(), ...hintMap.keys(), ...vectorMap.keys(), ...structuredCandidateMap.keys()]);
	const flatScored: Array<{ id: string; score: number; source: string }> = [];

	timings.time("flat_score_merge", () => {
		for (const id of allIds) {
			const bm25 = bm25Map.get(id) ?? 0;
			const hint = hintMap.get(id) ?? 0;
			const vec = vectorMap.get(id) ?? 0;
			const structured = structuredCandidateMap.get(id) ?? 0;
			let score: number;
			let source: string;

			if (bm25 > 0 && vec > 0) {
				score = alpha * vec + (1 - alpha) * bm25;
				source = "hybrid";
			} else if (vec > 0) {
				score = vec;
				source = "vector";
			} else if (bm25 > 0) {
				score = bm25;
				source = "keyword";
			} else {
				score = structured;
				source = "structured";
			}
			if (hint > 0 && hint >= score) {
				const hasDirectEvidence = bm25 > 0 || vec > 0 || structured > 0;
				score = hasDirectEvidence ? hint : Math.min(hint, HINT_ONLY_SCORE_CAP);
				source = bm25 > 0 || vec > 0 ? "hybrid" : structured > 0 ? "sec" : "hint";
			}
			if (structured > 0 && structured >= score) {
				score = structured;
				source = bm25 > 0 || vec > 0 || hint > 0 ? "sec" : "structured";
			}

			if (score >= minScore) flatScored.push({ id, score, source });
		}

		flatScored.sort((a, b) => b.score - a.score);
	});

	// --- Score pipeline: traversal-primary vs legacy boost ---
	const traversalPrimary =
		cfg.pipelineV2.graph.enabled && cfg.pipelineV2.traversal?.enabled && cfg.pipelineV2.traversal?.primary !== false;

	let scored: Array<{ id: string; score: number; source: string }> = [];

	if (traversalPrimary) {
		timings.time("traversal_primary", () => {
			// Channel A: graph traversal (primary retrieval path per DP-6)
			const traversalScored: Array<{ id: string; score: number; source: string }> = [];

			if (cfg.pipelineV2.traversal) {
				try {
					const traversalCfg = cfg.pipelineV2.traversal;
					const queryTokens = getGraphQueryTokens();
					if (queryTokens.length > 0) {
						const agentId = params.agentId ?? "default";
						const focal = getFocalEntities(agentId);

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
							// proximity. Without this, uniform importance (0.5/0.8)
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
											 WHERE source_id IN (${ph}) AND vector IS NOT NULL`,
											)
											.all(...ids) as Array<{
											source_id: string;
											vector: Buffer | null;
										}>,
								);
								const qv = queryVecF32;
								for (const row of embRows) {
									if (!row.vector) continue;
									const mv = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
									const cosine = cosineSimilarity(qv, mv);
									cosineMap.set(row.source_id, cosine);
									semanticEvidenceMap.set(row.source_id, Math.max(semanticEvidenceMap.get(row.source_id) ?? 0, cosine));
								}
							}

							const cosineWeight = 0.7;
							for (const [memoryId, importance] of traversal.memoryScores) {
								const cosine = cosineMap.get(memoryId) ?? 0;
								const imp = Math.max(minScore, Math.min(1, importance));
								traversalEvidenceMap.set(memoryId, Math.max(traversalEvidenceMap.get(memoryId) ?? 0, imp));
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

			// Channel merge: max-fuse overlapping flat/traversal candidates so a
			// weak graph score never discards stronger lexical/vector evidence.
			traversalScored.sort((a, b) => b.score - a.score);
			const candidateBudget = Math.max(limit, Math.min(cfg.search.top_k, limit * 4));
			const flatIds = new Set(flatScored.map((row) => row.id));
			const minFlat = Math.ceil(candidateBudget * 0.4);
			const byId = new Map<string, { id: string; score: number; source: string }>();
			for (const row of flatScored) mergeCandidate(byId, row);
			for (const row of traversalScored) mergeCandidate(byId, row);
			const fused = [...byId.values()].sort((a, b) => b.score - a.score);
			const selected: Array<{ id: string; score: number; source: string }> = [];
			let flatCount = 0;
			for (const row of fused) {
				if (selected.length >= candidateBudget) break;
				const isFlat = flatIds.has(row.id);
				const remaining = candidateBudget - selected.length;
				const neededFlat = Math.max(0, Math.min(minFlat, flatScored.length) - flatCount);
				if (!isFlat && neededFlat >= remaining) continue;
				selected.push(row);
				if (isFlat) flatCount++;
			}
			scored = selected;
		});
	} else {
		scored = flatScored;

		// --- Graph boost: pull up memories linked via knowledge graph ---
		if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.graph.boostWeight > 0) {
			try {
				const graphResult = timings.time("graph_boost", () =>
					getDbAccessor().withReadDb((db) =>
						getGraphBoostIds(query, db, cfg.pipelineV2.graph.boostTimeoutMs, params.agentId),
					),
				);
				if (graphResult.graphLinkedIds.size > 0) {
					const gw = cfg.pipelineV2.graph.boostWeight;
					for (const s of scored) {
						if (graphResult.graphLinkedIds.has(s.id)) {
							s.score = (1 - gw) * s.score + gw;
							traversalEvidenceMap.set(s.id, Math.max(traversalEvidenceMap.get(s.id) ?? 0, gw));
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
				timings.time("traversal_boost", () => {
					const traversalCfg = cfg.pipelineV2.traversal;
					const queryTokens = getGraphQueryTokens();
					if (traversalCfg && queryTokens.length > 0) {
						const agentId = params.agentId ?? "default";
						const focal = getFocalEntities(agentId);

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
									traversalEvidenceMap.set(memoryId, Math.max(traversalEvidenceMap.get(memoryId) ?? 0, tw));
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
									const traversalScore = Math.max(minScore, Math.min(1, row.traversal_score));
									traversalEvidenceMap.set(row.id, Math.max(traversalEvidenceMap.get(row.id) ?? 0, traversalScore));
									scored.push({
										id: row.id,
										score: traversalScore,
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
				});
			} catch (e) {
				logger.warn("memory", "KA traversal boost failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}

	if (structuredCandidateMap.size > 0) {
		const byId = new Map<string, { id: string; score: number; source: string }>();
		for (const row of scored) mergeCandidate(byId, row);
		for (const [id, score] of [...structuredCandidateMap.entries()].sort((a, b) => b[1] - a[1])) {
			mergeCandidate(byId, { id, score, source: "structured" });
		}
		scored = [...byId.values()].sort((a, b) => b.score - a.score);
	}

	if (scored.length > 0) {
		scored = timings.time("authorize_candidates", () => authorizeScoredCandidates(scored, filter));
	}

	// Everything below this point may assume `scored` only contains memory IDs
	// visible to the caller. Keep new content-bearing stages below this line.
	const structuredEvidenceMap = new Map(structuredCandidateMap);

	// --- Structured Evidence Convolution (SEC-lite) ---
	// Keep retrieval channels separate until after traversal/boosting. This
	// prevents graph-only memories from outranking directly anchored evidence,
	// while still letting prospective hints rescue class-to-instance matches.
	if (scored.length > 0) {
		const structuredEvidenceStart = performance.now();
		try {
			const byId = new Map<string, { id: string; score: number; source: string }>();
			for (const row of scored) mergeCandidate(byId, row);

			const candidates = [...byId.values()];
			try {
				const agentId = params.agentId ?? "default";
				const structured = getDbAccessor().withReadDb((db) =>
					scoreStructuredPathEvidence(
						db,
						candidates.map((row) => row.id),
						query,
						agentId,
					),
				);
				for (const [id, score] of structured) {
					structuredEvidenceMap.set(id, score);
				}
			} catch (e) {
				logger.warn("memory", "Structured path evidence failed (non-fatal)", {
					error: e instanceof Error ? e.message : String(e),
				});
			}

			const evidence: EvidenceCandidateInput[] = candidates.map((row) => ({
				id: row.id,
				source: row.source,
				lexical: bm25Map.get(row.id),
				semantic: semanticEvidenceMap.get(row.id),
				hint: hintMap.get(row.id),
				traversal: traversalEvidenceMap.get(row.id),
				structured: structuredEvidenceMap.get(row.id),
			}));

			const shaped = shapeStructuredEvidence(evidence, { minScore });
			if (shaped.length > 0) {
				const coverageLimit = Math.max(limit, cfg.search.top_k);
				const coverageIds = shaped.slice(0, coverageLimit).map((row) => row.id);
				let contentMap = new Map<string, string>();
				if (coverageIds.length > 0) {
					const placeholders = coverageIds.map(() => "?").join(", ");
					const contentRows = getDbAccessor().withReadDb(
						(db) =>
							db
								.prepare(
									`SELECT id, content FROM memories
									 WHERE id IN (${placeholders})`,
								)
								.all(...coverageIds) as Array<{ id: string; content: string }>,
					);
					contentMap = new Map(contentRows.map((row) => [row.id, row.content]));
				}

				const coverageQuery = params.keywordQuery ? query : expandedQuery;
				scored = shapeByFacetCoverage(coverageQuery, shaped, contentMap, coverageLimit).map((row) => ({
					id: row.id,
					score: row.score,
					source: row.source,
				}));
			}
		} catch (e) {
			logger.warn("memory", "Structured evidence shaping failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			timings.record("structured_evidence", structuredEvidenceStart);
		}
	}

	timings.time("rehearsal_boost", () => {
		applyRehearsalBoost(scored, cfg.search);
	});

	// --- Optional reranker hook ---
	let recallSummary: string | undefined;
	// Remaining timeout budget to use for LLM summary after reranking.
	// Set inside the reranker block; consumed after final results are assembled.
	let summarizeLeft = 0;
	if (cfg.pipelineV2.reranker.enabled && scored.length > 0) {
		const rerankerStageStart = performance.now();
		try {
			const rerankStart = Date.now();
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
			const provider = cfg.pipelineV2.reranker.useExtractionModel
				? createLlmReranker(getLlmProvider())
				: queryVecF32
					? createEmbeddingReranker(getDbAccessor(), queryVecF32)
					: noopReranker;
			const reranked = await rerank(query, candidates, provider, {
				topN: cfg.pipelineV2.reranker.topN,
				timeoutMs: cfg.pipelineV2.reranker.timeoutMs,
				model: cfg.pipelineV2.reranker.model,
			});
			// Update scores from reranked results without collapsing calibrated
			// relevance into rank-position placeholders.
			const rerankedMap = new Map(reranked.map((row) => [row.id, row.score]));
			for (const s of scored) {
				const score = rerankedMap.get(s.id);
				if (typeof score === "number" && Number.isFinite(score)) {
					s.score = score;
				}
			}
			if (cfg.pipelineV2.reranker.useExtractionModel) {
				const elapsed = Date.now() - rerankStart;
				const left = cfg.pipelineV2.reranker.timeoutMs - elapsed;
				if (left <= 0) {
					logger.warn("memory", "LLM summary skipped (reranker timeout budget exhausted)", {
						timeoutMs: cfg.pipelineV2.reranker.timeoutMs,
						elapsedMs: elapsed,
					});
				} else {
					// Store remaining budget; summary is generated after final
					// results are assembled so it is grounded in the recalled set.
					summarizeLeft = left;
				}
			}
			scored.sort((a, b) => b.score - a.score);
		} catch (e) {
			logger.warn("memory", "Reranker failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			timings.record("reranker", rerankerStageStart);
		}
	}

	// --- Post-fusion dampening (DP-16) ---
	// Three corrections after all scoring but before the final slice:
	// gravity (penalize zero-term-overlap semantic hits), hub (penalize
	// high-degree entity dominance), resolution (boost actionable types).
	if (scored.length > 0) {
		const dampeningStart = performance.now();
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
				params.keywordQuery ? query : expandedQuery,
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
		} finally {
			timings.record("dampening", dampeningStart);
		}
	}

	let currentness = new Map<string, CurrentnessInfo>();
	if (scored.length > 0) {
		const currentnessStart = performance.now();
		try {
			currentness = loadCurrentnessInfo(
				scored.map((row) => row.id),
				params.agentId ?? "default",
			);
			applyCurrentnessBias(scored, currentness);
		} catch (e) {
			logger.warn("memory", "Currentness shaping failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			timings.record("currentness", currentnessStart);
		}
	}

	timings.time("final_rank", () => {
		for (const row of scored) {
			const hasDirectEvidence =
				(bm25Map.get(row.id) ?? 0) > 0 ||
				(vectorMap.get(row.id) ?? 0) > 0 ||
				(structuredEvidenceMap.get(row.id) ?? 0) > 0;
			if (row.source === "hint" && !hasDirectEvidence) row.score = Math.min(row.score, HINT_ONLY_SCORE_CAP);
		}
		scored.sort((a, b) => b.score - a.score);
	});

	// Over-fetch before hydration for constrained searches. Broad candidate
	// channels can include IDs that candidate authorization or hydration drops.
	// 3x compensates for the expected discard rate.
	const preHydrate = selectionDedupeEnabled
		? Math.max(needsPostFilter ? limit * 3 : limit, Math.min(scored.length, Math.max(limit * 4, limit + 10)))
		: needsPostFilter
			? limit * 3
			: limit;
	const topIds = params.sourceOnly === true ? [] : scored.slice(0, preHydrate).map((s) => s.id);
	const recallTruncate = cfg.pipelineV2.guardrails.recallTruncateChars;
	const allowSourceFallbacks = !hasMemoryMetadataFilters(params);

	if (topIds.length === 0) {
		const fallbackLimit = selectionDedupeEnabled ? Math.max(limit * 3, limit + 10) : limit;
		const sourceChunkHits = allowSourceFallbacks
			? timings.time("source_chunk_vector_fallback", () =>
					buildSourceChunkVectorHits(
						queryVecF32,
						new Set(),
						fallbackLimit,
						params.agentId ?? "default",
						params.project,
					),
				)
			: [];
		if (sourceChunkHits.length > 0) {
			const results = suppressPreviouslyRecalledForSelection(
				sourceChunkHits.slice(0, fallbackLimit).map((hit): RecallResult => {
					const content = `[Source chunk: ${hit.sourcePath}]\n${hit.chunkText}`;
					const truncated = content.length > recallTruncate;
					return {
						id: `source-chunk:${hit.embeddingId}`,
						content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
						content_length: content.length,
						truncated,
						score: Math.round(Math.max(0.01, Math.min(1, hit.score)) * 100) / 100,
						source: sourceChunkRecallSource(hit.sourceId),
						source_id: hit.sourceId,
						session_id: hit.sourceId,
						type: hit.sourceType,
						tags: sourceChunkRecallTags(hit),
						pinned: false,
						importance: 0.6,
						who: sourceChunkProvider(hit.sourceId),
						project: hit.project,
						created_at: hit.createdAt,
						source_path: hit.sourcePath,
						supplementary: true,
					};
				}),
			).slice(0, limit);
			if (results.length > 0) {
				return await finish({
					results,
					query,
					method: "hybrid",
					meta: {
						totalReturned: results.length,
						hasSupplementary: true,
						noHits: false,
					},
				});
			}
		}
		const nativeHits = allowSourceFallbacks
			? timings.time("native_artifact_fallback", () => buildNativeArtifactRecallHits(params, expandedQuery, new Set()))
			: [];
		if (nativeHits.length > 0) {
			const results = suppressPreviouslyRecalledForSelection(
				nativeHits.slice(0, fallbackLimit).map((hit): RecallResult => {
					const content = nativeArtifactRecallContent(hit);
					const truncated = content.length > recallTruncate;
					const sourceId = nativeArtifactPublicId(hit);
					return {
						id: `native-artifact:${hit.rowid}`,
						content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
						content_length: content.length,
						truncated,
						score: Math.round(Math.max(0.01, Math.min(1.1, hit.rank)) * 100) / 100,
						source: nativeArtifactRecallSource(hit),
						source_id: sourceId,
						session_id: sourceId,
						type: hit.sourceKind,
						tags: nativeArtifactRecallTags(hit),
						pinned: false,
						importance: 0.55,
						who: hit.harness ?? "",
						project: hit.project,
						created_at: hit.updatedAt,
						source_path: hit.sourcePath,
						supplementary: true,
					};
				}),
			).slice(0, limit);
			if (results.length > 0) {
				return await finish({
					results,
					query,
					method: "keyword",
					meta: {
						totalReturned: results.length,
						hasSupplementary: true,
						noHits: false,
					},
				});
			}
		}
		return await finish({
			results: [],
			query,
			method: "hybrid",
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
			},
		});
	}

	// --- Fetch full memory rows ---
	// Hydration uses the same auth/scope/project filter as candidate
	// authorization so no alternate path can widen access.
	const placeholders = topIds.map(() => "?").join(", ");

	const rows = timings.time("hydrate_memory_rows", () =>
		getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.id, m.content, m.source_id, m.type, m.tags, m.pinned, m.importance, m.who, m.project, m.created_at, m.visibility, m.scope
        FROM memories m
        WHERE m.id IN (${placeholders}) AND m.is_deleted = 0${filter.sql}`,
					)
					.all(...topIds, ...filter.args) as Array<{
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
					visibility: string | null;
					scope: string | null;
				}>,
		),
	);

	const rowMap = new Map(rows.map((r) => [r.id, r]));
	// No pre-decrement: always fetch `limit` memories. The summary card is
	// injected after assembly and the array is capped to `limit` at that point.
	let results: RecallResult[] = timings.time("assemble_results", () =>
		suppressPreviouslyRecalledForSelection(
			scored
				.slice(0, preHydrate)
				.filter((s) => rowMap.has(s.id))
				.flatMap((s) => {
					const r = rowMap.get(s.id);
					if (!r) return [];
					const content = annotateCurrentness(r.content, currentness.get(r.id));
					const isTruncated = content.length > recallTruncate;
					return [
						{
							id: r.id,
							content: isTruncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
							content_length: content.length,
							truncated: isTruncated,
							score: Math.round(s.score * 100) / 100,
							source: s.source,
							...(r.source_id ? { source_id: r.source_id, session_id: sessionIdFromSourceId(r.source_id) } : {}),
							type: r.type,
							tags: r.tags,
							pinned: !!r.pinned,
							importance: r.importance,
							who: r.who,
							project: r.project,
							created_at: r.created_at,
							visibility: r.visibility,
							scope: r.scope,
						},
					];
				}),
		).slice(0, limit),
	);

	if (results.length < limit) {
		const existingSourceIds = new Set(results.map((row) => row.source_id).filter((id): id is string => !!id));
		const fill = limit - results.length;
		const sourceChunkHits = allowSourceFallbacks
			? timings.time("source_chunk_vector_supplement", () =>
					buildSourceChunkVectorHits(
						queryVecF32,
						existingSourceIds,
						selectionDedupeEnabled ? Math.max(fill * 3, fill + 10) : fill,
						params.agentId ?? "default",
						params.project,
					),
				)
			: [];
		const candidates = sourceChunkHits.map((hit): RecallResult => {
			const content = `[Source chunk: ${hit.sourcePath}]\n${hit.chunkText}`;
			const truncated = content.length > recallTruncate;
			return {
				id: `source-chunk:${hit.embeddingId}`,
				content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
				content_length: content.length,
				truncated,
				score: Math.round(Math.max(0.01, Math.min(1, hit.score)) * 100) / 100,
				source: sourceChunkRecallSource(hit.sourceId),
				source_id: hit.sourceId,
				session_id: hit.sourceId,
				type: hit.sourceType,
				tags: sourceChunkRecallTags(hit),
				pinned: false,
				importance: 0.6,
				who: sourceChunkProvider(hit.sourceId),
				project: hit.project,
				created_at: hit.createdAt,
				source_path: hit.sourcePath,
				supplementary: true,
			};
		});
		for (const row of suppressPreviouslyRecalledForSelection(candidates)) {
			if (results.length >= limit) break;
			results.push(row);
			if (row.source_id) existingSourceIds.add(row.source_id);
		}
	}

	if (results.length < limit) {
		const existingSourceIds = new Set(results.map((row) => row.source_id).filter((id): id is string => !!id));
		const nativeHits = allowSourceFallbacks
			? timings.time("native_artifact_supplement", () =>
					buildNativeArtifactRecallHits(params, expandedQuery, existingSourceIds),
				)
			: [];
		const candidates = nativeHits.map((hit): RecallResult => {
			const content = nativeArtifactRecallContent(hit);
			const truncated = content.length > recallTruncate;
			const sourceId = nativeArtifactPublicId(hit);
			return {
				id: `native-artifact:${hit.rowid}`,
				content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
				content_length: content.length,
				truncated,
				score: Math.round(Math.max(0.01, Math.min(1, hit.rank * 0.85)) * 100) / 100,
				source: nativeArtifactRecallSource(hit),
				source_id: sourceId,
				session_id: sourceId,
				type: hit.sourceKind,
				tags: nativeArtifactRecallTags(hit),
				pinned: false,
				importance: 0.55,
				who: hit.harness ?? "",
				project: hit.project,
				created_at: hit.updatedAt,
				source_path: hit.sourcePath,
				supplementary: true,
			};
		});
		for (const row of suppressPreviouslyRecalledForSelection(candidates)) {
			if (results.length >= limit) break;
			results.push(row);
		}
	}

	// Generate LLM summary from the final recalled set (not pre-filter candidates).
	// Skip when limit < 2: can't fit a summary card without evicting the only
	// real memory, which would leave the caller with nothing to verify against.
	if (summarizeLeft > 0 && results.length > 0 && limit >= 2) {
		const llmSummaryStart = performance.now();
		try {
			const summCandidates = results.slice(0, 12).map((r) => ({ id: r.id, content: r.content, score: r.score }));
			const s = await summarizeRecallWithLlm(getLlmProvider(), query, summCandidates, summarizeLeft);
			if (s) recallSummary = s;
		} catch (e) {
			logger.warn("memory", "LLM summary failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			timings.record("llm_summary", llmSummaryStart);
		}
	}

	if (recallSummary && limit >= 2) {
		const digest = createHash("sha1").update(query).digest("hex").slice(0, 12);
		const content = `[model summary, verify against source memories] ${recallSummary}`;
		const score = results.length > 0 ? Math.max(0.01, Math.min(1, results[0].score)) : 0.5;
		const summary = suppressPreviouslyRecalledForSelection([
			{
				id: `summary:${digest}`,
				content,
				content_length: content.length,
				truncated: false,
				score,
				source: "llm_summary",
				type: "semantic",
				tags: null,
				pinned: false,
				importance: 0.9,
				who: "",
				project: null,
				created_at: new Date().toISOString(),
				supplementary: true,
			},
		]);
		if (summary.length > 0) {
			if (results.length >= limit) results.length = limit - 1;
			results.unshift(summary[0]);
		}
	}

	// --- Decision-rationale linking: auto-fetch linked rationale memories ---
	const decisionIds = results.filter((r) => r.type === "decision").map((r) => r.id);
	const existingIds = new Set(results.map((r) => r.id));

	if (decisionIds.length > 0 && cfg.pipelineV2.graph.enabled) {
		const rationaleStart = performance.now();
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
							        m.importance, m.who, m.project, m.created_at, m.visibility, m.scope
							 FROM memory_entity_mentions mem
							 JOIN memories m ON m.id = mem.memory_id
							 WHERE mem.entity_id IN (${ePlaceholders})
							   AND m.type = 'rationale'
							   AND m.is_deleted = 0
							   ${filter.sql}
							 LIMIT 10`,
					)
					.all(...eIds, ...filter.args) as Array<{
					id: string;
					content: string;
					type: string;
					tags: string | null;
					pinned: number;
					importance: number;
					who: string;
					project: string | null;
					created_at: string;
					visibility?: string | null;
					scope?: string | null;
				}>;
			});

			for (const r of supplementary) {
				if (results.length >= limit) break;
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
					visibility: r.visibility,
					scope: r.scope,
					supplementary: true,
				});
			}
		} catch (e) {
			logger.warn("memory", "Rationale linking failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			timings.record("rationale_linking", rationaleStart);
		}
	}

	// --- Entity context + constructed memories (DP-7) ---
	let entityContext: RecallResponse["entities"];
	let focalEids: string[] = [];

	if (cfg.pipelineV2.graph.enabled && cfg.pipelineV2.traversal?.enabled) {
		const entityContextStart = performance.now();
		try {
			const queryTokens = getGraphQueryTokens();
			if (queryTokens.length > 0) {
				const agentId = params.agentId ?? "default";
				const focal = getFocalEntities(agentId);
				const ctx = getDbAccessor().withReadDb((db) => {
					if (focal.entityIds.length === 0) return null;

					// Project/scope-constrained recall should not let broad focal
					// entities pull in structural context from outside that slice.
					let eids = focal.entityIds;
					if (params.scope !== undefined || params.project) {
						const ph = eids.map(() => "?").join(", ");
						const sr = db
							.prepare(
								`SELECT DISTINCT mem.entity_id
								 FROM memory_entity_mentions mem
								 JOIN memories m ON m.id = mem.memory_id
								 WHERE mem.entity_id IN (${ph})
								   AND m.is_deleted = 0${filter.sql}`,
							)
							.all(...eids, ...filter.args) as Array<{ entity_id: string }>;
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
									`SELECT id, name FROM entity_aspects INDEXED BY idx_entity_aspects_entity
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
												`SELECT content, status, importance FROM entity_attributes INDEXED BY idx_entity_attributes_aspect
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
		} finally {
			timings.record("entity_context", entityContextStart);
		}
	}

	// --- Constructed memories: synthesize from graph paths (DP-7) ---
	// Constructed cards use structural density as their score, which is
	// query-independent. To prevent large entity cards from outranking
	// actual memories that answer the query, cap their scores below the
	// lowest real result score.
	if (focalEids.length > 0) {
		const constructedStart = performance.now();
		try {
			const agentId = params.agentId ?? "default";
			const cap = Math.max(3, Math.ceil(limit * 0.3));
			const blocks = getDbAccessor().withReadDb((db) => constructContextBlocks(db, agentId, focalEids, cap));
			const now = new Date().toISOString();
			const minReal = results.length > 0 ? Math.min(...results.map((r) => r.score)) : 0.5;
			const maxConstructed = Math.max(0.01, minReal - 0.01);
			let added = 0;
			for (const block of blocks) {
				if (added >= cap || results.length >= limit) break;
				const syntheticId = `constructed:${block.provenance.entityName}`;
				if (existingIds.has(syntheticId)) continue;
				existingIds.add(syntheticId);
				added++;

				results.push({
					id: syntheticId,
					content: block.content,
					content_length: block.content.length,
					truncated: block.truncated,
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
		} finally {
			timings.record("constructed_context", constructedStart);
		}
	}

	results = suppressPreviouslyRecalledForSelection(results);
	if (results.length > limit) results.length = limit;

	return await finish({
		results,
		query,
		method: vectorMap.size > 0 ? "hybrid" : "keyword",
		meta: {
			totalReturned: results.length,
			hasSupplementary: results.some((row) => row.supplementary === true),
			noHits: results.length === 0,
		},
		entities: entityContext && entityContext.length > 0 ? entityContext : undefined,
	});
}

/**
 * Hybrid recall search orchestration.
 *
 * Extracted from daemon.ts — this module contains the pure search logic
 * between "parse request" and "format response". The route handler in
 * daemon.ts is now a thin HTTP wrapper that delegates here.
 */

import { createHash } from "node:crypto";
import { vectorSearch } from "@signet/core";
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
import { escapeLike } from "./sql-utils";

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
	source_id?: string;
	session_id?: string;
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
	meta: {
		totalReturned: number;
		hasSupplementary: boolean;
		noHits: boolean;
	};
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

interface TranscriptRecallHit {
	readonly sessionKey: string;
	readonly project: string | null;
	readonly updatedAt: string;
	readonly excerpt: string;
	readonly rank: number;
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

function buildTranscriptRecallHits(
	params: RecallParams,
	query: string,
	existingSourceIds: Set<string>,
): TranscriptRecallHit[] {
	if (!params.expand) return [];
	const fts = sanitizeFtsQuery(query);
	if (fts.length === 0) return [];

	try {
		return getDbAccessor().withReadDb((db) => {
			const table = db
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='session_transcripts_fts'`)
				.get();
			if (!table) return [];

			const parts = [
				"SELECT st.session_key, st.project, COALESCE(st.updated_at, st.created_at) AS updated_at,",
				`st.content, snippet(session_transcripts_fts, 0, '', '', ' … ', 36) AS excerpt,`,
				"bm25(session_transcripts_fts) AS rank",
				"FROM session_transcripts_fts",
				"JOIN session_transcripts st ON st.rowid = session_transcripts_fts.rowid",
				"WHERE session_transcripts_fts MATCH ?",
				"AND st.agent_id = ?",
			];
			const args: unknown[] = [fts, params.agentId ?? "default"];
			if (params.project) {
				parts.push("AND st.project = ?");
				args.push(params.project);
			}
			if (params.scope !== undefined && params.scope !== null) {
				parts.push(`AND st.session_key LIKE ? ESCAPE '\\'`);
				args.push(`${escapeLike(params.scope)}:%`);
			}
			if (existingSourceIds.size > 0) {
				const placeholders = [...existingSourceIds].map(() => "?").join(", ");
				parts.push(`AND st.session_key NOT IN (${placeholders})`);
				args.push(...existingSourceIds);
			}
			parts.push("ORDER BY rank ASC, updated_at DESC LIMIT ?");
			args.push(Math.max(2, Math.min(3, params.limit ?? 10)));

			const rows = db.prepare(parts.join("\n")).all(...args) as Array<{
				session_key: string;
				project: string | null;
				updated_at: string;
				content: string;
				excerpt: string | null;
				rank: number;
			}>;

			const maxRank = rows.reduce((max, row) => Math.max(max, Math.abs(row.rank)), 1);
			return rows
				.map((row) => ({
					sessionKey: row.session_key,
					project: row.project,
					updatedAt: row.updated_at,
					excerpt: transcriptExcerpt(row.content || row.excerpt || "", query),
					rank: maxRank > 0 ? Math.abs(row.rank) / maxRank : 0.2,
				}))
				.filter((row) => row.excerpt.length > 0);
		});
	} catch (e) {
		logger.warn("memory", "Transcript recall fallback failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
		return [];
	}
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
				"AND ma.source_kind LIKE 'native_%'",
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

function loadStructuredSummariesBySourceId(params: RecallParams, sourceIds: readonly string[]): Map<string, string> {
	const unique = [...new Set(sourceIds.filter((sourceId) => sourceId.length > 0))];
	if (unique.length === 0) return new Map();

	try {
		return getDbAccessor().withReadDb((db) => {
			const placeholders = unique.map(() => "?").join(", ");
			const parts = [
				"SELECT source_id, content",
				"FROM memories",
				`WHERE source_id IN (${placeholders})`,
				"AND agent_id = ?",
				"AND COALESCE(is_deleted, 0) = 0",
				"AND TRIM(content) != ''",
			];
			const args: unknown[] = [...unique, params.agentId ?? "default"];
			if (params.project) {
				parts.push("AND project = ?");
				args.push(params.project);
			}
			parts.push("ORDER BY importance DESC, updated_at DESC, created_at DESC");

			const rows = db.prepare(parts.join("\n")).all(...args) as Array<{
				source_id: string | null;
				content: string;
			}>;

			const summaries = new Map<string, string>();
			for (const row of rows) {
				if (!row.source_id || summaries.has(row.source_id)) continue;
				summaries.set(row.source_id, row.content.trim());
			}
			return summaries;
		});
	} catch (e) {
		logger.warn("memory", "Transcript summary hydration failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
		return new Map();
	}
}

function buildTranscriptFallbackContent(
	excerpt: string,
	summary: string | undefined,
	recallTruncate: number,
): { content: string; contentLength: number; truncated: boolean } {
	const content = summary
		? `[Structured memory summary]\n${summary}\n\n[Transcript excerpt]\n${excerpt}`
		: `[Transcript excerpt]\n${excerpt}`;
	const truncated = content.length > recallTruncate;
	return {
		content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
		contentLength: content.length,
		truncated,
	};
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

export async function hybridRecall(
	params: RecallParams,
	cfg: ResolvedMemoryConfig,
	embedFn: EmbedFn,
): Promise<RecallResponse> {
	const query = params.query;
	const expandedQuery = expandRecallKeywordQuery(params.query);
	const keywordQuery = sanitizeFtsQuery((params.keywordQuery ?? expandedQuery).trim());
	const limit = params.limit ?? 10;
	const alpha = cfg.search.alpha;
	const minScore = cfg.search.min_score;

	const filter = buildFilterClause(params);
	const scoped = params.scope !== undefined;

	// --- BM25 keyword search via FTS5 ---
	const bm25Map = new Map<string, number>();
	const hintMap = new Map<string, number>();
	const traversalEvidenceMap = new Map<string, number>();
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
					hintMap.set(row.id, Math.max(hintMap.get(row.id) ?? 0, hint));
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
			const candidates = getDbAccessor().withReadDb((db) =>
				findStructuredPathCandidates(db, query, agentId, {
					limit: cfg.search.top_k,
					minScore,
					filterSql: filter.sql,
					filterArgs: filter.args,
				}),
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
			score = hint;
			source = bm25 > 0 || vec > 0 ? "hybrid" : "hint";
		}
		if (structured > 0 && structured >= score) {
			score = structured;
			source = bm25 > 0 || vec > 0 || hint > 0 ? "sec" : "structured";
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
					const focal = getDbAccessor().withReadDb((db) =>
						resolveFocalEntities(db, agentId, {
							queryTokens,
							includePinned: false,
						}),
					);

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

		// Channel merge: ensure flat candidates are eligible to compete in the
		// final sorted pool. Flat gets at least 40% of pre-sort slots so hub
		// entities (high-mention traversal walks) can't exclude keyword/vector
		// matches entirely. After the sort, final top-N is score-ordered —
		// the guarantee is eligibility, not placement.
		const traversalIds = new Set(traversalScored.map((s) => s.id));
		const flatOnly = flatScored.filter((s) => !traversalIds.has(s.id));
		const candidateBudget = Math.max(limit, Math.min(cfg.search.top_k, limit * 4));
		const minFlat = Math.ceil(candidateBudget * 0.4);
		const maxTraversal = candidateBudget - Math.min(minFlat, flatOnly.length);
		scored = [
			...traversalScored.slice(0, maxTraversal),
			// When traversal underperforms its cap, flat absorbs the surplus
			// slots — this is intentional, not a bug. Keep the pre-SEC pool
			// wider than the final limit so structured evidence can rescue
			// lower raw-rank but better path-matched candidates.
			...flatOnly.slice(0, candidateBudget - Math.min(maxTraversal, traversalScored.length)),
		];
		scored.sort((a, b) => b.score - a.score);
	} else {
		scored = flatScored;

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
				const traversalCfg = cfg.pipelineV2.traversal;
				const queryTokens = tokenizeGraphQuery(query);
				if (queryTokens.length > 0) {
					const agentId = params.agentId ?? "default";
					const focal = getDbAccessor().withReadDb((db) =>
						resolveFocalEntities(db, agentId, {
							queryTokens,
							includePinned: false,
						}),
					);

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

	const structuredEvidenceMap = new Map(structuredCandidateMap);

	// --- Structured Evidence Convolution (SEC-lite) ---
	// Keep retrieval channels separate until after traversal/boosting. This
	// prevents graph-only memories from outranking directly anchored evidence,
	// while still letting prospective hints rescue class-to-instance matches.
	if (scored.length > 0) {
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
		}
	}

	applyRehearsalBoost(scored, cfg.search);

	// --- Optional reranker hook ---
	let recallSummary: string | undefined;
	// Remaining timeout budget to use for LLM summary after reranking.
	// Set inside the reranker block; consumed after final results are assembled.
	let summarizeLeft = 0;
	if (cfg.pipelineV2.reranker.enabled) {
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
		}
	}

	let currentness = new Map<string, CurrentnessInfo>();
	if (scored.length > 0) {
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
		}
	}

	// Over-fetch before hydration when scoped. Vector search can't
	// pre-filter by scope, so out-of-scope IDs get dropped at
	// hydration. 3x compensates for the expected discard rate.
	const preHydrate = scoped ? limit * 3 : limit;
	const topIds = scored.slice(0, preHydrate).map((s) => s.id);
	const recallTruncate = cfg.pipelineV2.guardrails.recallTruncateChars;

	if (topIds.length === 0) {
		const nativeHits = buildNativeArtifactRecallHits(params, expandedQuery, new Set());
		if (nativeHits.length > 0) {
			const results = nativeHits.slice(0, limit).map((hit): RecallResult => {
				const content = `[Native ${hit.harness ?? "harness"} memory]\n${hit.content}`;
				const truncated = content.length > recallTruncate;
				const sourceId = nativeArtifactPublicId(hit);
				return {
					id: `native-artifact:${hit.rowid}`,
					content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
					content_length: content.length,
					truncated,
					score: Math.round(Math.max(0.01, Math.min(1.1, hit.rank)) * 100) / 100,
					source: "native_memory",
					source_id: sourceId,
					session_id: sourceId,
					type: hit.sourceKind,
					tags: [hit.harness, "native-memory", hit.sourceKind].filter(Boolean).join(","),
					pinned: false,
					importance: 0.55,
					who: hit.harness ?? "",
					project: hit.project,
					created_at: hit.updatedAt,
					supplementary: true,
				};
			});
			return {
				results,
				query,
				method: "keyword",
				meta: {
					totalReturned: results.length,
					hasSupplementary: true,
					noHits: false,
				},
			};
		}
		const transcriptHits = buildTranscriptRecallHits(params, expandedQuery, new Set());
		if (transcriptHits.length > 0) {
			const transcriptSummaries = loadStructuredSummariesBySourceId(
				params,
				transcriptHits.map((hit) => hit.sessionKey),
			);
			const results = transcriptHits.slice(0, limit).map((hit): RecallResult => {
				const sessionId = sessionIdFromSourceId(hit.sessionKey);
				const assembled = buildTranscriptFallbackContent(
					hit.excerpt,
					transcriptSummaries.get(hit.sessionKey),
					recallTruncate,
				);
				return {
					id: `transcript:${hit.sessionKey}`,
					content: assembled.content,
					content_length: assembled.contentLength,
					truncated: assembled.truncated,
					score: Math.round(Math.max(0.01, Math.min(1.1, hit.rank)) * 100) / 100,
					source: "transcript",
					source_id: hit.sessionKey,
					session_id: sessionId,
					type: "transcript",
					tags: params.scope ? `memorybench,${params.scope},${sessionId},transcript` : null,
					pinned: false,
					importance: 0.55,
					who: "",
					project: hit.project,
					created_at: hit.updatedAt,
					supplementary: true,
				};
			});
			return {
				results,
				query,
				method: "keyword",
				meta: {
					totalReturned: results.length,
					hasSupplementary: true,
					noHits: false,
				},
			};
		}
		return {
			results: [],
			query,
			method: "hybrid",
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
			},
		};
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
	const projectClause = params.project ? " AND m.project = ?" : "";
	const projectArgs: unknown[] = params.project ? [params.project] : [];
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
        WHERE m.id IN (${placeholders})${scopeClause}${projectClause}${agentScope.sql}`,
				)
				.all(...topIds, ...scopeArgs, ...projectArgs, ...agentScope.args) as Array<{
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

	// Update access tracking (don't fail if this fails).
	// Uses topIds (real DB memory IDs from scored), not the final results
	// array — so the synthetic llm_summary card injected later is never
	// included here and never touches the memories table.
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
	// No pre-decrement: always fetch `limit` memories. The summary card is
	// injected after assembly and the array is capped to `limit` at that point.
	const results: RecallResult[] = scored
		.slice(0, limit)
		.filter((s) => rowMap.has(s.id))
		.map((s) => {
			const r = rowMap.get(s.id)!;
			const content = annotateCurrentness(r.content, currentness.get(r.id));
			const isTruncated = content.length > recallTruncate;
			return {
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
			};
		});

	if (results.length < limit) {
		const existingSourceIds = new Set(results.map((row) => row.source_id).filter((id): id is string => !!id));
		const nativeHits = buildNativeArtifactRecallHits(params, expandedQuery, existingSourceIds);
		for (const hit of nativeHits) {
			if (results.length >= limit) break;
			const content = `[Native ${hit.harness ?? "harness"} memory]\n${hit.content}`;
			const truncated = content.length > recallTruncate;
			const sourceId = nativeArtifactPublicId(hit);
			results.push({
				id: `native-artifact:${hit.rowid}`,
				content: truncated ? `${content.slice(0, recallTruncate)} [truncated]` : content,
				content_length: content.length,
				truncated,
				score: Math.round(Math.max(0.01, Math.min(1, hit.rank * 0.85)) * 100) / 100,
				source: "native_memory",
				source_id: sourceId,
				session_id: sourceId,
				type: hit.sourceKind,
				tags: [hit.harness, "native-memory", hit.sourceKind].filter(Boolean).join(","),
				pinned: false,
				importance: 0.55,
				who: hit.harness ?? "",
				project: hit.project,
				created_at: hit.updatedAt,
				supplementary: true,
			});
		}
	}

	// Generate LLM summary from the final recalled set (not pre-filter candidates).
	// Skip when limit < 2: can't fit a summary card without evicting the only
	// real memory, which would leave the caller with nothing to verify against.
	if (summarizeLeft > 0 && results.length > 0 && limit >= 2) {
		try {
			const summCandidates = results.slice(0, 12).map((r) => ({ id: r.id, content: r.content, score: r.score }));
			const s = await summarizeRecallWithLlm(getLlmProvider(), query, summCandidates, summarizeLeft);
			if (s) recallSummary = s;
		} catch (e) {
			logger.warn("memory", "LLM summary failed (non-fatal)", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	if (recallSummary && limit >= 2) {
		const digest = createHash("sha1").update(query).digest("hex").slice(0, 12);
		const content = `[model summary, verify against source memories] ${recallSummary}`;
		const score = results.length > 0 ? Math.max(0.01, Math.min(1, results[0].score)) : 0.5;
		if (results.length >= limit) results.length = limit - 1;
		results.unshift({
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
		});
	}

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
					const focal = resolveFocalEntities(db, agentId, {
						queryTokens,
						includePinned: false,
					});
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
		}
	}

	// --- Transcript recall fallback ---
	// When the caller asks for expansion, raw transcripts are an allowed
	// lossless backing source. Use them as a mechanical rescue channel for
	// cases where the extracted memory compressed away the exact detail.
	if (params.expand) {
		const sourceIds = new Set(
			results
				.map((result) => rowMap.get(result.id)?.source_id ?? result.source_id)
				.filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.length > 0),
		);
		const transcriptHits = buildTranscriptRecallHits(params, expandedQuery, sourceIds);
		const transcriptSummaries = loadStructuredSummariesBySourceId(
			params,
			transcriptHits.map((hit) => hit.sessionKey),
		);
		const realScores = results.filter((row) => row.source !== "transcript").map((row) => row.score);
		const maxTranscriptScore = realScores.length > 0 ? Math.max(0.01, Math.min(...realScores) - 0.01) : 0.5;
		for (const hit of transcriptHits) {
			const sessionId = sessionIdFromSourceId(hit.sessionKey);
			const id = `transcript:${hit.sessionKey}`;
			if (existingIds.has(id)) continue;
			existingIds.add(id);
			const assembled = buildTranscriptFallbackContent(
				hit.excerpt,
				transcriptSummaries.get(hit.sessionKey),
				recallTruncate,
			);
			results.push({
				id,
				content: assembled.content,
				content_length: assembled.contentLength,
				truncated: assembled.truncated,
				score: Math.round(Math.max(0.01, Math.min(maxTranscriptScore, hit.rank)) * 100) / 100,
				source: "transcript",
				source_id: hit.sessionKey,
				session_id: sessionId,
				type: "transcript",
				tags: params.scope ? `memorybench,${params.scope},${sessionId},transcript` : null,
				pinned: false,
				importance: 0.55,
				who: "",
				project: hit.project,
				created_at: hit.updatedAt,
				supplementary: true,
			});
		}
		if (transcriptHits.length > 0) {
			results.sort((a, b) => b.score - a.score);
			if (results.length > limit) results.length = limit;
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

	if (params.expand && sources) {
		for (const result of results.filter((row) => row.source !== "transcript").slice(0, Math.min(5, limit))) {
			const sourceId = rowMap.get(result.id)?.source_id ?? result.source_id;
			if (!sourceId) continue;
			const transcript = sources[sourceId];
			if (!transcript) continue;
			const excerpt = transcriptExcerpt(transcript, expandedQuery);
			if (!excerpt || result.content.includes(excerpt)) continue;
			const content = `[Transcript excerpt]\n${excerpt}\n\n${result.content}`;
			result.content = content.length > recallTruncate ? `${content.slice(0, recallTruncate)} [truncated]` : content;
			result.content_length = content.length;
			result.truncated = content.length > recallTruncate;
		}
	}

	return {
		results,
		query,
		method: vectorMap.size > 0 ? "hybrid" : "keyword",
		meta: {
			totalReturned: results.length,
			hasSupplementary: results.some((row) => row.supplementary === true),
			noHits: results.length === 0,
		},
		entities: entityContext && entityContext.length > 0 ? entityContext : undefined,
		sources,
	};
}

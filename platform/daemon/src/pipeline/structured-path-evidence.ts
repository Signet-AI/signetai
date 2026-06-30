import type { ReadDb } from "../db-accessor";
import { FTS_STOP } from "./stop-words";

const PUNCT = /[^a-z0-9\s]/g;

const ADVICE_CUES = new Set(["advice", "advise", "idea", "recommend", "recommendation", "suggestion", "tip", "way"]);

const AMOUNT_CUES = new Set(["amount", "balance", "bill", "billing", "cost", "invoice", "paid", "pay", "payment"]);
const BILLING_PATH_CUES = new Set(["amount", "balance", "billing", "invoice", "pay", "payment"]);

const INTENT_ASPECTS = new Set([
	"decision_patterns",
	"decision pattern",
	"decision patterns",
	"preferences",
	"preference",
	"plans",
	"decisions",
	"activities",
]);

const QUERY_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
	advice: ["guidance", "tips", "suggestion", "suggestions", "recommend", "recommendations", "ideas", "ways"],
	advise: ["guidance", "tips", "suggestion", "suggestions", "recommend", "recommendations", "ideas", "ways"],
	brand: ["brands", "company", "label", "maker", "retailer", "source", "store", "vendor"],
	brands: ["brand", "company", "label", "maker", "retailer", "source", "store", "vendor"],
	colleague: ["coworker", "coworkers", "team", "teammate", "teammates", "work", "workplace"],
	colleagues: ["coworker", "coworkers", "team", "teammate", "teammates", "work", "workplace"],
	connected: ["connection", "connect", "socialize", "socializing", "collaborate", "collaboration", "communication"],
	connection: ["connected", "connect", "socialize", "socializing", "collaborate", "collaboration", "communication"],
	current: ["currently", "latest", "lately", "now", "preferred", "recent", "recently"],
	currently: ["current", "latest", "lately", "now", "preferred", "recent", "recently"],
	idea: ["ideas", "suggestion", "suggestions", "tips", "guidance", "recommendation", "recommendations"],
	ideas: ["idea", "suggestion", "suggestions", "tips", "guidance", "recommendation", "recommendations"],
	music: ["audio", "band", "bands", "playlist", "playlists", "song", "songs"],
	recommend: ["recommendation", "recommendations", "suggestion", "suggestions", "advice", "tips", "ideas"],
	recommendation: ["recommend", "recommendations", "suggestion", "suggestions", "advice", "tips", "ideas"],
	recommendations: ["recommend", "recommendation", "suggestion", "suggestions", "advice", "tips", "ideas"],
	remote: ["virtual", "online", "work", "workday", "workplace"],
	service: ["app", "application", "platform", "provider", "subscription"],
	services: ["app", "application", "platform", "provider", "subscription"],
	streaming: ["listening", "music", "platform"],
	suggestion: ["suggestions", "advice", "tips", "ideas", "guidance", "recommendation", "recommendations", "ways"],
	suggestions: ["suggestion", "advice", "tips", "ideas", "guidance", "recommendation", "recommendations", "ways"],
	tip: ["tips", "advice", "suggestion", "suggestions", "guidance", "ideas"],
	tips: ["tip", "advice", "suggestion", "suggestions", "guidance", "ideas"],
	use: ["likes", "prefer", "preferred", "used", "using"],
	used: ["likes", "prefer", "preferred", "use", "using"],
	using: ["likes", "prefer", "preferred", "use", "used"],
	way: ["ways", "idea", "ideas", "suggestion", "suggestions", "advice", "tips", "guidance"],
	ways: ["way", "idea", "ideas", "suggestion", "suggestions", "advice", "tips", "guidance"],
};

interface StructuredPathRow {
	readonly memory_id: string;
	readonly entity_name: string;
	readonly aspect: string;
	readonly group_key: string | null;
	readonly claim_key: string | null;
	readonly content: string;
	readonly kind: string;
	readonly importance: number;
	readonly confidence: number | null;
}

export interface StructuredClaimCandidate {
	readonly id: string;
	readonly score: number;
	readonly entityName: string;
	readonly entityType: string;
	readonly aspect: string;
	readonly groupKey: string | null;
	readonly claimKey: string | null;
	readonly content: string;
	readonly kind: string;
	readonly importance: number;
	readonly confidence: number | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly version: number;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly proposalEvidence: string | null;
}

interface StructuredClaimRow {
	readonly id: string;
	readonly entity_name: string;
	readonly entity_type: string;
	readonly aspect: string;
	readonly group_key: string | null;
	readonly claim_key: string | null;
	readonly content: string;
	readonly kind: string;
	readonly importance: number;
	readonly confidence: number | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly version: number;
	readonly source_kind: string | null;
	readonly source_id: string | null;
	readonly source_path: string | null;
	readonly proposal_evidence: string | null;
}

function normalizeToken(raw: string): string {
	const cleaned = raw.toLowerCase().replace(PUNCT, " ").trim();
	if (!cleaned) return "";
	if (cleaned.endsWith("ies") && cleaned.length > 4) return `${cleaned.slice(0, -3)}y`;
	if (cleaned.endsWith("ing") && cleaned.length > 5) return cleaned.slice(0, -3);
	if (cleaned.endsWith("ed") && cleaned.length > 4) return cleaned.slice(0, -2);
	if (cleaned.endsWith("s") && cleaned.length > 3) return cleaned.slice(0, -1);
	return cleaned;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(PUNCT, " ")
		.split(/\s+/)
		.map(normalizeToken)
		.filter((token) => token.length >= 2 && !FTS_STOP.has(token));
}

function expandToken(token: string): Set<string> {
	const normalized = normalizeToken(token);
	const expanded = new Set<string>([normalized]);
	for (const item of QUERY_EXPANSIONS[normalized] ?? []) {
		const next = normalizeToken(item);
		if (next.length >= 2 && !FTS_STOP.has(next)) expanded.add(next);
	}
	return expanded;
}

function expandedQueryTokens(queryTokens: readonly string[]): string[] {
	const expanded = new Set<string>();
	for (const token of queryTokens) {
		for (const item of expandToken(token)) expanded.add(item);
	}
	return [...expanded];
}

interface MemoryPathAggregate {
	readonly tokens: Set<string>;
	importance: number;
	confidence: number;
	hasIntentAspect: boolean;
}

interface PathScoreRow {
	readonly key: string;
	readonly entity_name?: string;
	readonly aspect: string;
	readonly group_key: string | null;
	readonly claim_key: string | null;
	readonly content: string;
	readonly kind: string;
	readonly importance: number;
	readonly confidence: number | null;
}

function queryTokenWeight(token: string): number {
	if (token === "colleague" || token === "coworker" || token === "teammate") return 1.7;
	if (token === "connected" || token === "connection" || token === "connect") return 1.5;
	if (token === "invoice" || token === "billing" || token === "payment" || token === "balance") return 1.8;
	if (token === "remote") return 1.3;
	if (ADVICE_CUES.has(token)) return 0.55;
	return 1;
}

function scoreStructuredClaimCandidate(
	row: StructuredClaimRow,
	queryTokens: readonly string[],
	baseScore: number,
): number {
	let score = baseScore;
	const queryHasAmountIntent = queryTokens.some((token) => AMOUNT_CUES.has(token));
	if (queryHasAmountIntent) {
		const pathTokens = new Set(
			tokenize(
				[row.entity_name, row.aspect, row.group_key ?? "", row.claim_key ?? "", row.kind, row.content].join(" "),
			),
		);
		if ([...BILLING_PATH_CUES].some((token) => pathTokens.has(token))) score += 0.28;
	}
	return Math.max(0, Math.min(1.15, score));
}

function scorePathTokens(
	queryTokens: readonly string[],
	hasAdviceIntent: boolean,
	aggregate: MemoryPathAggregate,
): number {
	if (aggregate.tokens.size === 0) return 0;

	let direct = 0;
	let expanded = 0;
	let denominator = 0;
	let anchorMatched = false;
	for (const token of queryTokens) {
		const weight = queryTokenWeight(token);
		denominator += weight;
		if (aggregate.tokens.has(token)) {
			direct += weight;
			expanded += weight;
			if (weight >= 1.5) anchorMatched = true;
			continue;
		}
		const synonyms = expandToken(token);
		for (const synonym of synonyms) {
			if (aggregate.tokens.has(synonym)) {
				expanded += weight;
				if (weight >= 1.5) anchorMatched = true;
				break;
			}
		}
	}

	denominator = Math.max(1, denominator);
	const coverage = direct / denominator + ((expanded - direct) / denominator) * 0.65;
	const weight = 0.55 + aggregate.importance * 0.3 + aggregate.confidence * 0.15;
	const intentBoost = hasAdviceIntent && aggregate.hasIntentAspect && coverage >= 0.2 ? 0.08 : 0;
	const anchorBoost = anchorMatched ? 0.18 : 0;
	return Math.max(0, Math.min(1, coverage * weight + intentBoost + anchorBoost));
}

function scorePathRows(rows: readonly PathScoreRow[], queryTokens: readonly string[]): Map<string, number> {
	const aggregates = new Map<string, MemoryPathAggregate>();
	for (const row of rows) {
		let aggregate = aggregates.get(row.key);
		if (!aggregate) {
			aggregate = {
				tokens: new Set(),
				importance: 0,
				confidence: 0,
				hasIntentAspect: false,
			};
			aggregates.set(row.key, aggregate);
		}
		for (const token of tokenize(
			[row.entity_name ?? "", row.aspect, row.group_key ?? "", row.claim_key ?? "", row.kind, row.content].join(" "),
		)) {
			aggregate.tokens.add(token);
		}
		aggregate.importance = Math.max(aggregate.importance, Math.max(0, Math.min(1, row.importance)));
		aggregate.confidence = Math.max(aggregate.confidence, Math.max(0, Math.min(1, row.confidence ?? 0.8)));
		const aspect = row.aspect.toLowerCase().replace(/_/g, " ").trim();
		aggregate.hasIntentAspect = aggregate.hasIntentAspect || INTENT_ASPECTS.has(aspect);
	}

	const hasAdviceIntent = queryTokens.some((token) => ADVICE_CUES.has(token));
	const scores = new Map<string, number>();
	for (const [id, aggregate] of aggregates) {
		const score = scorePathTokens(queryTokens, hasAdviceIntent, aggregate);
		if (score > 0) scores.set(id, score);
	}
	return scores;
}

export function scoreStructuredPathEvidence(
	db: ReadDb,
	memoryIds: readonly string[],
	query: string,
	agentId: string,
): Map<string, number> {
	const queryTokens = [...new Set(tokenize(query))];
	if (memoryIds.length === 0 || queryTokens.length === 0) return new Map();

	const uniqueIds = [...new Set(memoryIds.filter((id) => typeof id === "string" && id.length > 0))];
	if (uniqueIds.length === 0) return new Map();

	const placeholders = uniqueIds.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT
				 ea.memory_id,
				 e.name AS entity_name,
				 asp.canonical_name AS aspect,
				 ea.group_key,
				 ea.claim_key,
				 ea.content,
				 ea.kind,
				 ea.importance,
				 ea.confidence
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 JOIN entities e ON e.id = asp.entity_id
			 WHERE ea.memory_id IN (${placeholders})
			   AND ea.agent_id = ?
			   AND asp.agent_id = ?
			   AND e.agent_id = ?
			   AND ea.status = 'active'`,
		)
		.all(...uniqueIds, agentId, agentId, agentId) as StructuredPathRow[];

	return scorePathRows(
		rows.map((row) => ({ ...row, key: row.memory_id })),
		queryTokens,
	);
}

function escapeLikeToken(token: string): string {
	return token.replace(/[%_\\]/g, "\\$&");
}

function proposalEvidenceHasSourcePointer(raw: string | null): boolean {
	if (!raw) return false;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return (
			Array.isArray(parsed) &&
			parsed.some((item) => {
				if (!item || typeof item !== "object") return false;
				const record = item as Record<string, unknown>;
				return ["source", "source_id", "source_path", "transcript_id", "session_key", "memory_id"].some(
					(key) => typeof record[key] === "string" && record[key].trim().length > 0,
				);
			})
		);
	} catch {
		return false;
	}
}

function claimHasSourcePointer(row: StructuredClaimRow): boolean {
	return (
		(row.source_id !== null && row.source_id.trim().length > 0) ||
		(row.source_path !== null && row.source_path.trim().length > 0) ||
		proposalEvidenceHasSourcePointer(row.proposal_evidence)
	);
}

function queryTokensForPathSearch(query: string, limit: number): { queryTokens: string[]; tokens: string[] } | null {
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0 || limit <= 0) return null;

	const tokens = expandedQueryTokens(queryTokens)
		.filter((token) => token.length >= 3)
		.slice(0, 18);
	return tokens.length > 0 ? { queryTokens, tokens } : null;
}

function pathSearchHaystack(): string {
	return `LOWER(
		COALESCE(e.name, '') || ' ' ||
		COALESCE(asp.canonical_name, '') || ' ' ||
		COALESCE(ea.group_key, '') || ' ' ||
		COALESCE(ea.claim_key, '') || ' ' ||
		COALESCE(ea.kind, '') || ' ' ||
		COALESCE(ea.content, '')
	)`;
}

export function findStructuredPathCandidates(
	db: ReadDb,
	query: string,
	agentId: string,
	options: {
		readonly limit: number;
		readonly minScore?: number;
		readonly filterSql?: string;
		readonly filterArgs?: readonly unknown[];
	} = { limit: 20 },
): Map<string, number> {
	const parsed = queryTokensForPathSearch(query, options.limit);
	if (!parsed) return new Map();

	const haystack = pathSearchHaystack();
	const like = parsed.tokens.map(() => `${haystack} LIKE ? ESCAPE '\\'`).join(" OR ");
	const filterSql = options.filterSql ?? "";
	const rows = db
		.prepare(
			`SELECT
				 ea.memory_id,
				 e.name AS entity_name,
				 asp.canonical_name AS aspect,
				 ea.group_key,
				 ea.claim_key,
				 ea.content,
				 ea.kind,
				 ea.importance,
				 ea.confidence
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 JOIN entities e ON e.id = asp.entity_id
			 JOIN memories m ON m.id = ea.memory_id
			 WHERE ea.agent_id = ?
			   AND asp.agent_id = ?
			   AND e.agent_id = ?
			   AND ea.status = 'active'
			   AND ea.memory_id IS NOT NULL
			   AND m.is_deleted = 0
			   ${filterSql}
			   AND (${like})
			 LIMIT ?`,
		)
		.all(
			agentId,
			agentId,
			agentId,
			...(options.filterArgs ?? []),
			...parsed.tokens.map((token) => `%${escapeLikeToken(token)}%`),
			Math.max(options.limit * 8, options.limit),
		) as StructuredPathRow[];

	const ids = [...new Set(rows.map((row) => row.memory_id))];
	const scores = scoreStructuredPathEvidence(db, ids, query, agentId);
	const minScore = options.minScore ?? 0;
	return new Map(
		[...scores.entries()]
			.filter(([, score]) => score >= minScore)
			.sort((a, b) => b[1] - a[1])
			.slice(0, options.limit),
	);
}

export function findStructuredClaimCandidates(
	db: ReadDb,
	query: string,
	agentId: string,
	options: { readonly limit: number; readonly minScore?: number } = { limit: 20 },
): StructuredClaimCandidate[] {
	const parsed = queryTokensForPathSearch(query, options.limit);
	if (!parsed) return [];

	const haystack = pathSearchHaystack();
	const like = parsed.tokens.map(() => `${haystack} LIKE ? ESCAPE '\\'`).join(" OR ");
	const roughScore = parsed.tokens.map(() => `CASE WHEN ${haystack} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(" + ");
	const rows = db
		.prepare(
			`SELECT
				 ea.id,
				 e.name AS entity_name,
				 e.entity_type,
				 asp.canonical_name AS aspect,
				 ea.group_key,
				 ea.claim_key,
				 ea.content,
				 ea.kind,
				 ea.importance,
				 ea.confidence,
				 ea.created_at,
				 ea.updated_at,
				 ea.version,
				 ea.source_kind,
				 ea.source_id,
				 ea.source_path,
				 ea.proposal_evidence
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 JOIN entities e ON e.id = asp.entity_id
			 WHERE ea.agent_id = ?
			   AND asp.agent_id = ?
			   AND e.agent_id = ?
			   AND ea.status = 'active'
			   AND asp.status = 'active'
			   AND e.status = 'active'
			   AND ea.memory_id IS NULL
			   AND (
			     ea.source_id IS NOT NULL OR
			     ea.source_path IS NOT NULL OR
			     (ea.proposal_evidence IS NOT NULL AND ea.proposal_evidence != '[]')
			   )
			   AND (${like})
			 ORDER BY (${roughScore}) DESC, ea.importance DESC, ea.updated_at DESC
			 LIMIT ?`,
		)
		.all(
			agentId,
			agentId,
			agentId,
			...parsed.tokens.map((token) => `%${escapeLikeToken(token)}%`),
			...parsed.tokens.map((token) => `%${escapeLikeToken(token)}%`),
			Math.max(options.limit * 32, 500),
		) as StructuredClaimRow[];

	const scores = scorePathRows(
		rows.map((row) => ({ ...row, key: row.id })),
		parsed.queryTokens,
	);
	const minScore = Math.max(options.minScore ?? 0, 0.65);
	return rows
		.flatMap((row): StructuredClaimCandidate[] => {
			if (!claimHasSourcePointer(row)) return [];
			const score = scoreStructuredClaimCandidate(row, parsed.queryTokens, scores.get(row.id) ?? 0);
			if (score < minScore) return [];
			return [
				{
					id: row.id,
					score,
					entityName: row.entity_name,
					entityType: row.entity_type,
					aspect: row.aspect,
					groupKey: row.group_key,
					claimKey: row.claim_key,
					content: row.content,
					kind: row.kind,
					importance: row.importance,
					confidence: row.confidence,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					version: row.version,
					sourceKind: row.source_kind,
					sourceId: row.source_id,
					sourcePath: row.source_path,
					proposalEvidence: row.proposal_evidence,
				},
			];
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, options.limit);
}

import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import { ownerReadAll } from "../db-owner-sql";
import { FTS_STOP } from "./stop-words";

const PUNCT = /[^a-z0-9\s]/g;

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

interface MemoryPathAggregate {
	readonly tokens: Set<string>;
	importance: number;
	confidence: number;
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

function scoreStructuredClaimCandidate(baseScore: number): number {
	return Math.max(0, Math.min(1.15, baseScore));
}

function scorePathTokens(queryTokens: readonly string[], aggregate: MemoryPathAggregate): number {
	if (aggregate.tokens.size === 0 || queryTokens.length === 0) return 0;
	const matched = queryTokens.filter((token) => aggregate.tokens.has(token)).length;
	const coverage = matched / queryTokens.length;
	const weight = 0.55 + aggregate.importance * 0.3 + aggregate.confidence * 0.15;
	return Math.max(0, Math.min(1, coverage * weight));
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
	}

	const scores = new Map<string, number>();
	for (const [id, aggregate] of aggregates) {
		const score = scorePathTokens(queryTokens, aggregate);
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
		(row.source_kind !== null && row.source_kind.trim().length > 0) ||
		proposalEvidenceHasSourcePointer(row.proposal_evidence)
	);
}

function queryTokensForPathSearch(query: string, limit: number): { queryTokens: string[]; tokens: string[] } | null {
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0 || limit <= 0) return null;

	const tokens = queryTokens.filter((token) => token.length >= 3).slice(0, 18);
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
			     NULLIF(TRIM(ea.source_kind), '') IS NOT NULL OR
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
			const score = scoreStructuredClaimCandidate(scores.get(row.id) ?? 0);
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
export async function findStructuredPathCandidatesViaOwner(
	owner: DbOwnerClient,
	query: string,
	agentId: string,
	options: {
		readonly limit: number;
		readonly minScore?: number;
		readonly filterSql?: string;
		readonly filterArgs?: readonly unknown[];
	} = { limit: 20 },
): Promise<Map<string, number>> {
	const parsed = queryTokensForPathSearch(query, options.limit);
	if (!parsed) return new Map();
	const haystack = pathSearchHaystack();
	const like = parsed.tokens.map(() => `${haystack} LIKE ? ESCAPE '\\'`).join(" OR ");
	const rows = await ownerReadAll<StructuredPathRow>(
		owner,
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
		   ${options.filterSql ?? ""}
		   AND (${like})
		 LIMIT ?`,
		[
			agentId,
			agentId,
			agentId,
			...(options.filterArgs ?? []),
			...parsed.tokens.map((token) => `%${escapeLikeToken(token)}%`),
			Math.max(options.limit * 8, options.limit),
		],
		{
			operation: "memory-search.structured-path-candidates",
			lane: "read",
			workloadClass: "foreground",
			deadlineMs: 30_000,
			estimatedWorkUnits: Math.max(options.limit * 8, options.limit),
		},
	);
	const ids = [...new Set(rows.map((row) => row.memory_id))];
	const evidenceRows =
		ids.length === 0
			? []
			: await ownerReadAll<StructuredPathRow>(
					owner,
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
					 WHERE ea.memory_id IN (${ids.map(() => "?").join(", ")})
					   AND ea.agent_id = ?
					   AND asp.agent_id = ?
					   AND e.agent_id = ?
					   AND ea.status = 'active'`,
					[...ids, agentId, agentId, agentId],
					{
						operation: "memory-search.structured-path-evidence",
						lane: "read",
						workloadClass: "foreground",
						deadlineMs: 30_000,
						estimatedWorkUnits: ids.length,
					},
				);
	const scores = scorePathRows(
		evidenceRows.map((row) => ({ ...row, key: row.memory_id })),
		parsed.queryTokens,
	);
	const minScore = options.minScore ?? 0;
	return new Map(
		[...scores.entries()]
			.filter(([, score]) => score >= minScore)
			.sort((a, b) => b[1] - a[1])
			.slice(0, options.limit),
	);
}
export async function scoreStructuredPathEvidenceViaOwner(
	owner: DbOwnerClient,
	memoryIds: readonly string[],
	query: string,
	agentId: string,
): Promise<Map<string, number>> {
	const queryTokens = [...new Set(tokenize(query))];
	const uniqueIds = [...new Set(memoryIds.filter((id) => typeof id === "string" && id.length > 0))];
	if (uniqueIds.length === 0 || queryTokens.length === 0) return new Map();
	const placeholders = uniqueIds.map(() => "?").join(", ");
	const rows = await ownerReadAll<StructuredPathRow>(
		owner,
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
		[...uniqueIds, agentId, agentId, agentId],
		{
			operation: "memory-search.structured-path-evidence",
			lane: "read",
			workloadClass: "foreground",
			deadlineMs: 30_000,
			estimatedWorkUnits: uniqueIds.length,
		},
	);
	return scorePathRows(
		rows.map((row) => ({ ...row, key: row.memory_id })),
		queryTokens,
	);
}
export async function findStructuredClaimCandidatesViaOwner(
	owner: DbOwnerClient,
	query: string,
	agentId: string,
	options: { readonly limit: number; readonly minScore?: number } = { limit: 20 },
): Promise<StructuredClaimCandidate[]> {
	const parsed = queryTokensForPathSearch(query, options.limit);
	if (!parsed) return [];
	const haystack = pathSearchHaystack();
	const like = parsed.tokens.map(() => `${haystack} LIKE ? ESCAPE '\\'`).join(" OR ");
	const roughScore = parsed.tokens.map(() => `CASE WHEN ${haystack} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(" + ");
	const rows = await ownerReadAll<StructuredClaimRow>(
		owner,
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
		     NULLIF(TRIM(ea.source_kind), '') IS NOT NULL OR
		     (ea.proposal_evidence IS NOT NULL AND ea.proposal_evidence != '[]')
		   )
		   AND (${like})
		 ORDER BY (${roughScore}) DESC, ea.importance DESC, ea.updated_at DESC
		 LIMIT ?`,
		[
			agentId,
			agentId,
			agentId,
			...parsed.tokens.map((token) => `%${escapeLikeToken(token)}%`),
			...parsed.tokens.map((token) => `%${escapeLikeToken(token)}%`),
			Math.max(options.limit * 32, 500),
		],
		{
			operation: "memory-search.structured-claim-candidates",
			lane: "read",
			workloadClass: "foreground",
			deadlineMs: 30_000,
			estimatedWorkUnits: Math.max(options.limit * 32, 500),
		},
	);
	const scores = scorePathRows(
		rows.map((row) => ({ ...row, key: row.id })),
		parsed.queryTokens,
	);
	const minScore = Math.max(options.minScore ?? 0, 0.65);
	return rows
		.flatMap((row): StructuredClaimCandidate[] => {
			if (!claimHasSourcePointer(row)) return [];
			const score = scoreStructuredClaimCandidate(scores.get(row.id) ?? 0);
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

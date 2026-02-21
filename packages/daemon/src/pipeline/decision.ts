/**
 * Shadow decision engine for Phase B.
 *
 * Evaluates extracted facts against existing memories using hybrid
 * search, then asks the LLM whether to add/update/delete/skip.
 * All decisions are proposals only — logged to memory_history but
 * never mutating memory content.
 */

import {
	DECISION_ACTIONS,
	vectorSearch,
	type DecisionAction,
	type ExtractedFact,
} from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import type { EmbeddingConfig, MemorySearchConfig } from "../memory-config";
import type { LlmProvider } from "./provider";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CandidateMemory {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly importance: number;
}

export interface DecisionConfig {
	readonly embedding: EmbeddingConfig;
	readonly search: MemorySearchConfig;
	readonly fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
	) => Promise<number[] | null>;
}

export interface FactDecisionProposal {
	readonly action: DecisionAction;
	readonly targetMemoryId?: string;
	readonly confidence: number;
	readonly reason: string;
	readonly fact: ExtractedFact;
	readonly targetContent?: string;
}

export interface FactDecisionResult {
	readonly proposals: readonly FactDecisionProposal[];
	readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Candidate retrieval (focused hybrid search, top-5)
// ---------------------------------------------------------------------------

const CANDIDATE_LIMIT = 5;

interface AllQuery<T> {
	all(...args: readonly unknown[]): T;
}

function findCandidatesBm25(
	accessor: DbAccessor,
	query: string,
	limit: number,
): Map<string, number> {
	const bm25Map = new Map<string, number>();
	try {
		accessor.withReadDb((db) => {
			const stmt = db.prepare(`
					SELECT m.id, bm25(memories_fts) AS raw_score
					FROM memories_fts
					JOIN memories m ON memories_fts.rowid = m.rowid
					WHERE memories_fts MATCH ?
					ORDER BY raw_score
					LIMIT ?
				`) as unknown as AllQuery<Array<{ id: string; raw_score: number }>>;
			const rows = stmt.all(query, limit);

			for (const row of rows) {
				bm25Map.set(row.id, 1 / (1 + Math.abs(row.raw_score)));
			}
		});
	} catch {
		// FTS unavailable — continue with vector only
	}
	return bm25Map;
}

async function findCandidatesVector(
	accessor: DbAccessor,
	query: string,
	cfg: DecisionConfig,
	limit: number,
): Promise<Map<string, number>> {
	const vectorMap = new Map<string, number>();
	try {
		const queryVec = await cfg.fetchEmbedding(query, cfg.embedding);
		if (queryVec) {
			const qf32 = new Float32Array(queryVec);
			accessor.withReadDb((db) => {
				const vectorDb = db as unknown as Parameters<typeof vectorSearch>[0];
				const results = vectorSearch(vectorDb, qf32, { limit });
				for (const r of results) {
					vectorMap.set(r.id, r.score);
				}
			});
		}
	} catch {
		// Vector search unavailable — continue with BM25 only
	}
	return vectorMap;
}

function fetchMemoryRows(
	accessor: DbAccessor,
	ids: readonly string[],
): CandidateMemory[] {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	return accessor.withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT id, content, type, importance
				 FROM memories
				 WHERE id IN (${placeholders}) AND is_deleted = 0`,
				)
				.all(...ids) as CandidateMemory[],
	);
}

async function findCandidates(
	accessor: DbAccessor,
	query: string,
	cfg: DecisionConfig,
): Promise<CandidateMemory[]> {
	const alpha = cfg.search.alpha;
	const minScore = cfg.search.min_score;

	const bm25Map = findCandidatesBm25(accessor, query, CANDIDATE_LIMIT * 2);
	const vectorMap = await findCandidatesVector(
		accessor,
		query,
		cfg,
		CANDIDATE_LIMIT * 2,
	);

	const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
	const scored: Array<{ id: string; score: number }> = [];

	for (const id of allIds) {
		const bm25 = bm25Map.get(id) ?? 0;
		const vec = vectorMap.get(id) ?? 0;
		let score: number;
		if (bm25 > 0 && vec > 0) {
			score = alpha * vec + (1 - alpha) * bm25;
		} else if (vec > 0) {
			score = vec;
		} else {
			score = bm25;
		}
		if (score >= minScore) scored.push({ id, score });
	}

	scored.sort((a, b) => b.score - a.score);
	const topIds = scored.slice(0, CANDIDATE_LIMIT).map((s) => s.id);

	return fetchMemoryRows(accessor, topIds);
}

// ---------------------------------------------------------------------------
// Decision prompt
// ---------------------------------------------------------------------------

function buildDecisionPrompt(
	fact: ExtractedFact,
	candidates: readonly CandidateMemory[],
): string {
	const candidateBlock = candidates
		.map(
			(c, i) =>
				`[${i + 1}] ID: ${c.id}\n    Type: ${c.type}\n    Content: ${c.content}`,
		)
		.join("\n\n");

	return `You are a memory management system. Given a new fact and existing memory candidates, decide the best action.

New fact (type: ${fact.type}, confidence: ${fact.confidence}):
"${fact.content}"

Existing candidates:
${candidateBlock}

Actions:
- "add": New fact has no good match, should be stored as new memory
- "update": New fact supersedes or refines an existing candidate (specify targetId)
- "delete": New fact contradicts/invalidates a candidate (specify targetId)
- "none": Fact is already covered by existing memories, skip

Return a JSON object:
{"action": "add|update|delete|none", "targetId": "candidate-id-if-applicable", "confidence": 0.0-1.0, "reason": "brief explanation"}

Return ONLY the JSON, no other text.`;
}

// ---------------------------------------------------------------------------
// Decision validation
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set<string>(DECISION_ACTIONS);

function parseDecision(
	raw: string,
	candidateIds: ReadonlySet<string>,
	warnings: string[],
): Omit<FactDecisionProposal, "fact" | "targetContent"> | null {
	const jsonStr = raw
		.trim()
		.replace(/```(?:json)?\s*([\s\S]*?)```/, "$1")
		.trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		warnings.push("Failed to parse decision JSON");
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) {
		warnings.push("Decision is not an object");
		return null;
	}

	const obj = parsed as Record<string, unknown>;

	const action = typeof obj.action === "string" ? obj.action : "";
	if (!VALID_ACTIONS.has(action)) {
		warnings.push(`Invalid action: "${action}"`);
		return null;
	}

	const targetId = typeof obj.targetId === "string" ? obj.targetId : undefined;

	// update/delete MUST reference a valid candidate
	if (action === "update" || action === "delete") {
		if (!targetId) {
			warnings.push(`${action} decision missing targetId`);
			return null;
		}
		if (!candidateIds.has(targetId)) {
			warnings.push(`Decision references non-candidate ID: "${targetId}"`);
			return null;
		}
	}

	const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
	if (!reason) {
		warnings.push("Decision missing reason");
		return null;
	}

	const rawConf = typeof obj.confidence === "number" ? obj.confidence : 0.5;
	const confidence = Math.max(0, Math.min(1, rawConf));

	return {
		action: action as DecisionAction,
		targetMemoryId: targetId,
		confidence,
		reason,
	};
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

export async function runShadowDecisions(
	facts: readonly ExtractedFact[],
	accessor: DbAccessor,
	provider: LlmProvider,
	cfg: DecisionConfig,
): Promise<FactDecisionResult> {
	const proposals: FactDecisionProposal[] = [];
	const warnings: string[] = [];

	for (const fact of facts) {
		const candidates = await findCandidates(accessor, fact.content, cfg);

		// No candidates → propose ADD
		if (candidates.length === 0) {
			proposals.push({
				action: "add",
				confidence: fact.confidence,
				reason: "No existing memories match this fact",
				fact,
			});
			continue;
		}

		const candidateIds = new Set(candidates.map((c) => c.id));
		const prompt = buildDecisionPrompt(fact, candidates);

		try {
			const output = await provider.generate(prompt);
			const proposal = parseDecision(output, candidateIds, warnings);
			if (proposal) {
				const targetContent =
					proposal.targetMemoryId === undefined
						? undefined
						: candidates.find(
								(candidate) => candidate.id === proposal.targetMemoryId,
							)?.content;
				proposals.push({
					...proposal,
					fact,
					targetContent,
				});
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			warnings.push(`Decision LLM error for fact: ${msg}`);
		}
	}

	logger.debug("pipeline", "Shadow decisions complete", {
		proposalCount: proposals.length,
		warningCount: warnings.length,
	});

	return { proposals, warnings };
}

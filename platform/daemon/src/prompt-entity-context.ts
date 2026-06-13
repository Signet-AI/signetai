import { existsSync } from "node:fs";
import { cosineSimilarity } from "@signet/core";
import { selectWithBudgetSkippingOversized } from "./context-budget";
import { type ReadDb, getDbAccessor, hasDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import { countPromptTermOverlap, extractSubstantiveWords, stripUntrustedMetadata } from "./prompt-text";

type FetchEmbedding = (text: string, cfg: EmbeddingConfig) => Promise<number[] | null>;

type PromptEntityMatch = {
	readonly entityId: string;
	readonly entityName: string;
	readonly entityType: string;
	readonly description: string | null;
	readonly matchedText: string;
	readonly matchSource: "name" | "alias";
	readonly mentions: number;
};

type PromptEntityCandidate = PromptEntityMatch & {
	readonly normalizedPhrase: string;
	readonly spanStart: number;
	readonly spanEnd: number;
	readonly score: number;
};

type PromptEntityContextLine = {
	readonly entityName: string;
	readonly aspectName: string;
	readonly groupKey: string | null;
	readonly claimKey: string | null;
	readonly kind: "attribute" | "constraint";
	readonly content: string;
	readonly confidence: number;
	readonly importance: number;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly memoryId: string | null;
	readonly version: number;
};

type PromptEntityContextResult = {
	readonly lines: readonly string[];
	readonly memoryCount: number;
	readonly engine: "entity-context" | "low-signal" | "no-entity" | "no-aspect-hit";
};

const LOW_SIGNAL_PROMPTS = new Set([
	"cool",
	"got it",
	"go ahead",
	"great",
	"k",
	"kk",
	"nice",
	"ok",
	"okay",
	"okay cool",
	"sounds good",
	"sure",
	"thanks",
	"thank you",
	"yes",
	"yes please",
	"yep",
]);

const ENTITY_CONTEXT_MAX_ENTITIES = 2;
const ENTITY_CONTEXT_MAX_ASPECTS_PER_ENTITY = 3;
const ENTITY_CONTEXT_MAX_LINES = 8;
const ENTITY_CONTEXT_MAX_ATTRIBUTE_CANDIDATES = 192;
const MIN_PROMPT_ENTITY_MATCH_CHARS = 3;

function normalizePromptEntityText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/\b([a-z0-9]+)'s\b/g, "$1")
		.replace(/\b([a-z0-9]+)s'\b/g, "$1s")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function promptEntityTerms(value: string): string[] {
	const normalized = normalizePromptEntityText(value);
	return normalized.length > 0 ? normalized.split(" ") : [];
}

const PROMPT_BARE_POSSESSIVE_DENY_TERMS = new Set([
	"agent",
	"artifact",
	"concept",
	"connector",
	"document",
	"event",
	"memory",
	"policy",
	"preference",
	"product",
	"project",
	"skill",
	"source",
	"system",
	"task",
	"tool",
	"workflow",
]);

function promptEntityTermMatches(promptTerm: string, phraseTerm: string): boolean {
	return (
		promptTerm === phraseTerm ||
		(phraseTerm.length >= 4 && !PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(phraseTerm) && promptTerm === `${phraseTerm}s`)
	);
}

function promptPhraseSpan(prompt: string, phrase: string): { readonly start: number; readonly end: number } | null {
	const promptTerms = promptEntityTerms(prompt);
	const phraseTerms = promptEntityTerms(phrase);
	if (phraseTerms.join(" ").length < MIN_PROMPT_ENTITY_MATCH_CHARS) return null;
	if (phraseTerms.length === 0 || phraseTerms.length > promptTerms.length) return null;
	for (let start = 0; start <= promptTerms.length - phraseTerms.length; start += 1) {
		if (phraseTerms.every((term, offset) => promptEntityTermMatches(promptTerms[start + offset] ?? "", term))) {
			return { start, end: start + phraseTerms.length };
		}
	}
	return null;
}

function spansOverlap(
	a: { readonly start: number; readonly end: number },
	b: { readonly start: number; readonly end: number },
): boolean {
	return a.start < b.end && b.start < a.end;
}

function isLowSignalPrompt(userMessage: string): boolean {
	const normalized = normalizePromptEntityText(stripUntrustedMetadata(userMessage));
	if (normalized.length === 0) return true;
	if (LOW_SIGNAL_PROMPTS.has(normalized)) return true;
	const terms = extractSubstantiveWords(normalized);
	return terms.length === 0;
}

function entityContextTablesAvailable(db: ReadDb): boolean {
	const rows = db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name IN ('entities', 'entity_aspects', 'entity_attributes', 'entity_aliases')`,
		)
		.all() as Array<{ name: string }>;
	const names = new Set(rows.map((row) => row.name));
	return (
		names.has("entities") &&
		names.has("entity_aspects") &&
		names.has("entity_attributes") &&
		names.has("entity_aliases")
	);
}

const PROMPT_ENTITY_CONTEXT_ALLOWED_TYPES = new Set(["person", "project"]);
const PROMPT_ROLE_ENTITY_DENY_TERMS = new Set(["assistant", "human", "user"]);
const PROMPT_GENERIC_CONTEXT_QUERY_TERMS = new Set([
	"context",
	"contexts",
	"current",
	"prompt",
	"relevant",
	"view",
	"views",
]);

function isPromptEntityContextTypeAllowed(entityType: string): boolean {
	return PROMPT_ENTITY_CONTEXT_ALLOWED_TYPES.has(entityType.toLowerCase());
}

function isPromptGenericEntityPhrase(phraseTerms: readonly string[]): boolean {
	if (phraseTerms.length !== 1) return false;
	const term = phraseTerms[0] ?? "";
	if (PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(term)) return true;
	return term.endsWith("s") && PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(term.slice(0, -1));
}

function isPromptRoleEntity(row: {
	readonly entity_name: string;
	readonly matched_text: string;
	readonly pinned: number;
}): boolean {
	if (Math.min(Math.max(0, row.pinned), 1) > 0) return false;
	const entityTerms = promptEntityTerms(row.entity_name);
	const matchedTerms = promptEntityTerms(row.matched_text);
	if (entityTerms.length !== 1 || matchedTerms.length !== 1) return false;
	return (
		PROMPT_ROLE_ENTITY_DENY_TERMS.has(entityTerms[0] ?? "") && PROMPT_ROLE_ENTITY_DENY_TERMS.has(matchedTerms[0] ?? "")
	);
}

function isPromptBroadUncategorizedAttribute(row: {
	readonly aspect_name: string;
	readonly group_key: string | null;
	readonly claim_key: string | null;
}): boolean {
	return (
		normalizePromptEntityText(row.group_key ?? "general") === "general" &&
		normalizePromptEntityText(row.claim_key ?? "uncategorized") === "uncategorized"
	);
}

function isPromptGenericContextQuery(promptTerms: ReadonlyArray<string>): boolean {
	return promptTerms.length > 0 && promptTerms.every((term) => PROMPT_GENERIC_CONTEXT_QUERY_TERMS.has(term));
}

function scorePromptEntityCandidate(row: {
	readonly match_source: "name" | "alias";
	readonly matched_text: string;
	readonly mentions: number;
	readonly pinned: number;
}): number {
	const phrase = normalizePromptEntityText(row.matched_text);
	const phraseTerms = promptEntityTerms(row.matched_text);
	return (
		phraseTerms.length * 8 +
		phrase.length * 0.35 +
		Math.log1p(Math.max(0, row.mentions)) +
		Math.min(Math.max(0, row.pinned), 1) * 8 +
		(row.match_source === "alias" ? -0.25 : 0)
	);
}

function resolvePromptEntityMatches(db: ReadDb, agentId: string, userMessage: string): PromptEntityMatch[] {
	if (!entityContextTablesAvailable(db)) return [];
	const rows = db
		.prepare(
			`SELECT
			   e.id AS entity_id,
			   e.name AS entity_name,
			   COALESCE(e.entity_type, 'unknown') AS entity_type,
			   e.description AS description,
			   COALESCE(e.canonical_name, LOWER(e.name)) AS matched_text,
			   'name' AS match_source,
			   COALESCE(e.mentions, 0) AS mentions,
			   COALESCE(e.pinned, 0) AS pinned
			 FROM entities e
			 WHERE e.agent_id = ?
			   AND COALESCE(e.status, 'active') = 'active'
			 UNION ALL
			 SELECT
			   e.id AS entity_id,
			   e.name AS entity_name,
			   COALESCE(e.entity_type, 'unknown') AS entity_type,
			   e.description AS description,
			   a.alias AS matched_text,
			   'alias' AS match_source,
			   COALESCE(e.mentions, 0) AS mentions,
			   COALESCE(e.pinned, 0) AS pinned
			 FROM entity_aliases a
			 JOIN entities e ON e.id = a.entity_id AND e.agent_id = a.agent_id
			 WHERE a.agent_id = ?
			   AND a.status = 'active'
			   AND COALESCE(e.status, 'active') = 'active'`,
		)
		.all(agentId, agentId) as Array<{
		entity_id: string;
		entity_name: string;
		entity_type: string;
		description: string | null;
		matched_text: string;
		match_source: "name" | "alias";
		mentions: number;
		pinned: number;
	}>;

	const candidatesByPhrase = new Map<string, PromptEntityCandidate[]>();
	for (const row of rows) {
		if (!isPromptEntityContextTypeAllowed(row.entity_type)) continue;
		if (isPromptRoleEntity(row)) continue;
		if (isPromptGenericEntityPhrase(promptEntityTerms(row.matched_text))) continue;
		const span = promptPhraseSpan(userMessage, row.matched_text);
		if (!span) continue;
		const normalizedPhrase = normalizePromptEntityText(row.matched_text);
		const candidate: PromptEntityCandidate = {
			entityId: row.entity_id,
			entityName: row.entity_name,
			entityType: row.entity_type,
			description: row.description,
			matchedText: row.matched_text,
			matchSource: row.match_source,
			mentions: row.mentions,
			normalizedPhrase,
			spanStart: span.start,
			spanEnd: span.end,
			score: scorePromptEntityCandidate(row),
		};
		candidatesByPhrase.set(normalizedPhrase, [...(candidatesByPhrase.get(normalizedPhrase) ?? []), candidate]);
	}

	const phraseWinners = [...candidatesByPhrase.values()]
		.map(
			(candidates) =>
				[...candidates].sort(
					(a, b) =>
						b.score - a.score ||
						b.mentions - a.mentions ||
						b.normalizedPhrase.length - a.normalizedPhrase.length ||
						a.entityName.localeCompare(b.entityName),
				)[0],
		)
		.filter((candidate): candidate is PromptEntityCandidate => !!candidate);
	const topScore = phraseWinners.reduce((max, candidate) => Math.max(max, candidate.score), 0);
	const minimumScore = Math.max(12, topScore * 0.45);
	const ranked = phraseWinners
		.filter((candidate) => candidate.score >= minimumScore)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.spanEnd - b.spanStart - (a.spanEnd - a.spanStart) ||
				b.mentions - a.mentions ||
				a.entityName.localeCompare(b.entityName),
		);
	const seen = new Set<string>();
	const selectedSpans: Array<{ readonly start: number; readonly end: number }> = [];
	const result: PromptEntityMatch[] = [];
	for (const row of ranked) {
		if (seen.has(row.entityId)) continue;
		if (selectedSpans.some((span) => spansOverlap(span, { start: row.spanStart, end: row.spanEnd }))) continue;
		seen.add(row.entityId);
		selectedSpans.push({ start: row.spanStart, end: row.spanEnd });
		result.push({
			entityId: row.entityId,
			entityName: row.entityName,
			entityType: row.entityType,
			description: row.description,
			matchedText: row.matchedText,
			matchSource: row.matchSource,
			mentions: row.mentions,
		});
		if (result.length >= ENTITY_CONTEXT_MAX_ENTITIES) break;
	}
	return result;
}

type PromptAttributeCandidate = PromptEntityContextLine & {
	readonly attributeId: string;
	readonly aspectId: string;
	readonly memoryId: string | null;
	readonly score: number;
};

function queryWithoutPromptEntities(userMessage: string, entities: ReadonlyArray<PromptEntityMatch>): string {
	const entityTerms = new Set(
		entities.flatMap((entity) => extractSubstantiveWords(`${entity.entityName} ${entity.matchedText}`)),
	);
	return extractSubstantiveWords(userMessage)
		.filter((term) => ![...entityTerms].some((entityTerm) => promptEntityTermMatches(term, entityTerm)))
		.join(" ");
}

function scoreAttributeLexically(
	row: {
		readonly aspect_name: string;
		readonly group_key: string | null;
		readonly claim_key: string | null;
		readonly content: string;
		readonly confidence: number;
		readonly importance: number;
	},
	promptTerms: ReadonlyArray<string>,
): number {
	if (promptTerms.length === 0) return 0;
	const contentOverlap = countPromptTermOverlap(row.content, promptTerms);
	const claimOverlap = countPromptTermOverlap(normalizePromptEntityText(row.claim_key ?? ""), promptTerms);
	const groupOverlap =
		claimOverlap > 0 ? countPromptTermOverlap(normalizePromptEntityText(row.group_key ?? ""), promptTerms) : 0;
	const pathOverlap = claimOverlap > 0 ? claimOverlap + groupOverlap : 0;
	if (contentOverlap === 0 && pathOverlap === 0) return 0;
	const base = pathOverlap > 0 ? 0.8 : 0.72;
	return Math.min(1, base + Math.min(row.importance, 1) * 0.18 + Math.min(row.confidence, 1) * 0.1);
}

function loadAttributeSemanticScores(
	db: ReadDb,
	agentId: string,
	rows: ReadonlyArray<{ readonly attributeId: string; readonly memoryId: string | null }>,
	queryVector: Float32Array | null,
): Map<string, number> {
	if (!queryVector) return new Map();
	const memoryIds = [...new Set(rows.map((row) => row.memoryId).filter((id): id is string => !!id))];
	if (memoryIds.length === 0) return new Map();
	const placeholders = memoryIds.map(() => "?").join(", ");
	const embeddings = db
		.prepare(
			`SELECT source_id, vector
			 FROM embeddings
			 WHERE source_type = 'memory'
			   AND source_id IN (${placeholders})
			   AND agent_id = ?
			   AND dimensions = ?
			   AND vector IS NOT NULL`,
		)
		.all(...memoryIds, agentId, queryVector.length) as Array<{ source_id: string; vector: Buffer }>;
	const scoreByMemoryId = new Map<string, number>();
	for (const embedding of embeddings) {
		const vector = new Float32Array(
			embedding.vector.buffer,
			embedding.vector.byteOffset,
			embedding.vector.byteLength / 4,
		);
		scoreByMemoryId.set(
			embedding.source_id,
			Math.max(scoreByMemoryId.get(embedding.source_id) ?? 0, cosineSimilarity(queryVector, vector)),
		);
	}
	return new Map(
		rows
			.map((row) => [row.attributeId, row.memoryId ? (scoreByMemoryId.get(row.memoryId) ?? 0) : 0] as const)
			.filter(([, score]) => score > 0),
	);
}

function loadEntityContextLines(
	db: ReadDb,
	entity: PromptEntityMatch,
	agentId: string,
	semanticQuery: string,
	minScore: number,
	queryVector: Float32Array | null,
): PromptEntityContextLine[] {
	const promptTerms = extractSubstantiveWords(semanticQuery);
	if (promptTerms.length === 0) return [];
	const candidateRows = db
		.prepare(
			`SELECT
			   ea.id AS attribute_id,
			   asp.id AS aspect_id,
			   asp.name AS aspect_name,
			   ea.kind,
			   ea.content,
			   ea.group_key,
			   ea.claim_key,
			   ea.confidence,
			   ea.importance,
			   ea.source_kind,
			   ea.source_id,
			   ea.source_path,
			   ea.memory_id,
			   COALESCE(ea.version, 1) AS version
			 FROM entity_aspects asp
			 JOIN entity_attributes ea ON ea.aspect_id = asp.id
			 WHERE asp.entity_id = ?
			   AND asp.agent_id = ?
			   AND COALESCE(asp.status, 'active') = 'active'
			   AND ea.agent_id = ?
			   AND ea.status = 'active'
			   AND ea.superseded_by IS NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM entity_attributes newer
			     WHERE newer.aspect_id = ea.aspect_id
			       AND newer.agent_id = ea.agent_id
			       AND newer.kind = ea.kind
			       AND COALESCE(newer.group_key, 'general') = COALESCE(ea.group_key, 'general')
			       AND newer.claim_key = ea.claim_key
			       AND newer.status = 'active'
			       AND newer.superseded_by IS NULL
			       AND COALESCE(newer.version, 1) > COALESCE(ea.version, 1)
			   )
			 ORDER BY ea.importance DESC, ea.updated_at DESC
			 LIMIT ?`,
		)
		.all(entity.entityId, agentId, agentId, ENTITY_CONTEXT_MAX_ATTRIBUTE_CANDIDATES) as Array<{
		attribute_id: string;
		aspect_id: string;
		aspect_name: string;
		kind: "attribute" | "constraint";
		content: string;
		group_key: string | null;
		claim_key: string | null;
		confidence: number;
		importance: number;
		source_kind: string | null;
		source_id: string | null;
		source_path: string | null;
		memory_id: string | null;
		version: number;
	}>;
	const semanticScores = loadAttributeSemanticScores(
		db,
		agentId,
		candidateRows
			.filter((row) => !isPromptBroadUncategorizedAttribute(row))
			.map((row) => ({ attributeId: row.attribute_id, memoryId: row.memory_id })),
		queryVector,
	);
	const genericContextQuery = isPromptGenericContextQuery(promptTerms);
	const candidates: PromptAttributeCandidate[] = candidateRows
		.filter((row) => !isPromptBroadUncategorizedAttribute(row))
		.map((row) => {
			const lexicalScore = scoreAttributeLexically(row, promptTerms);
			const semanticScore = semanticScores.get(row.attribute_id) ?? 0;
			return {
				attributeId: row.attribute_id,
				aspectId: row.aspect_id,
				entityName: entity.entityName,
				aspectName: row.aspect_name,
				groupKey: row.group_key,
				claimKey: row.claim_key,
				kind: row.kind,
				content: row.content,
				confidence: row.confidence,
				importance: row.importance,
				sourceKind: row.source_kind,
				sourceId: row.source_id,
				sourcePath: row.source_path,
				memoryId: row.memory_id,
				version: row.version,
				score: genericContextQuery && lexicalScore === 0 ? 0 : Math.max(semanticScore, lexicalScore),
			};
		})
		.filter((row) => row.score >= minScore)
		.sort((a, b) => b.score - a.score || b.importance - a.importance);
	const selectedAspectIds = new Set<string>();
	const selectedAttributeIds = new Set<string>();
	for (const candidate of candidates) {
		selectedAspectIds.add(candidate.aspectId);
		selectedAttributeIds.add(candidate.attributeId);
		if (selectedAspectIds.size >= ENTITY_CONTEXT_MAX_ASPECTS_PER_ENTITY) break;
	}
	if (selectedAspectIds.size === 0) return [];
	const placeholders = [...selectedAspectIds].map(() => "?").join(", ");
	const attributePlaceholders = [...selectedAttributeIds].map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT
			   asp.name AS aspect_name,
			   ea.kind,
			   ea.content,
			   ea.group_key,
			   ea.claim_key,
			   ea.confidence,
			   ea.importance,
			   ea.source_kind,
			   ea.source_id,
			   ea.source_path,
			   ea.memory_id,
			   COALESCE(ea.version, 1) AS version
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 WHERE ea.aspect_id IN (${placeholders})
			   AND ea.id IN (${attributePlaceholders})
			   AND ea.agent_id = ?
			   AND ea.status = 'active'
			   AND ea.superseded_by IS NULL
			   AND NOT EXISTS (
			     SELECT 1
			     FROM entity_attributes newer
			     WHERE newer.aspect_id = ea.aspect_id
			       AND newer.agent_id = ea.agent_id
			       AND newer.kind = ea.kind
			       AND COALESCE(newer.group_key, 'general') = COALESCE(ea.group_key, 'general')
			       AND newer.claim_key = ea.claim_key
			       AND newer.status = 'active'
			       AND newer.superseded_by IS NULL
			       AND COALESCE(newer.version, 1) > COALESCE(ea.version, 1)
			   )
			 ORDER BY
			   CASE ea.kind WHEN 'constraint' THEN 0 ELSE 1 END,
			   ea.importance DESC,
			   ea.updated_at DESC
			 LIMIT ?`,
		)
		.all(...selectedAspectIds, ...selectedAttributeIds, agentId, ENTITY_CONTEXT_MAX_LINES) as Array<{
		aspect_name: string;
		kind: "attribute" | "constraint";
		content: string;
		group_key: string | null;
		claim_key: string | null;
		confidence: number;
		importance: number;
		source_kind: string | null;
		source_id: string | null;
		source_path: string | null;
		memory_id: string | null;
		version: number;
	}>;
	return rows
		.filter((row) => !isPromptBroadUncategorizedAttribute(row))
		.map((row) => ({
			entityName: entity.entityName,
			aspectName: row.aspect_name,
			groupKey: row.group_key,
			claimKey: row.claim_key,
			kind: row.kind,
			content: row.content,
			confidence: row.confidence,
			importance: row.importance,
			sourceKind: row.source_kind,
			sourceId: row.source_id,
			sourcePath: row.source_path,
			memoryId: row.memory_id,
			version: row.version,
		}));
}

function formatEntityContextLine(line: PromptEntityContextLine): string {
	const path = [line.entityName, line.aspectName, line.groupKey ?? "general", line.claimKey ?? "uncategorized"].join(
		" / ",
	);
	const source =
		line.sourceKind && line.sourceId
			? `${line.sourceKind}:${line.sourceId}`
			: line.memoryId
				? `memory:${line.memoryId}`
				: line.sourcePath
					? line.sourcePath
					: `v${line.version}`;
	return `- [${line.kind}] ${path}: ${line.content} (${source})`;
}

export interface BuildEntityPromptContextOptions {
	readonly userMessage: string;
	readonly agentId: string;
	readonly minScore: number;
	readonly injectBudget: number;
	readonly memoryDbPath: string;
	readonly fetchEmbedding: FetchEmbedding;
	readonly embedding: EmbeddingConfig;
}

export async function buildEntityPromptContext({
	userMessage,
	agentId,
	minScore,
	injectBudget,
	memoryDbPath,
	fetchEmbedding,
	embedding,
}: BuildEntityPromptContextOptions): Promise<PromptEntityContextResult> {
	if (isLowSignalPrompt(userMessage)) return { lines: [], memoryCount: 0, engine: "low-signal" };
	if (!existsSync(memoryDbPath)) return { lines: [], memoryCount: 0, engine: "no-entity" };
	if (!hasDbAccessor()) return { lines: [], memoryCount: 0, engine: "no-entity" };
	const matches = getDbAccessor().withReadDb((db) => resolvePromptEntityMatches(db, agentId, userMessage));
	if (matches.length === 0) return { lines: [], memoryCount: 0, engine: "no-entity" };

	const vectorsByEntity = new Map<
		string,
		{ readonly semanticQuery: string; readonly queryVector: Float32Array | null }
	>();
	const sharedSemanticQuery = queryWithoutPromptEntities(userMessage, matches);
	for (const entity of matches) {
		const semanticQuery = sharedSemanticQuery;
		if (!semanticQuery) continue;
		let queryVector: Float32Array | null = null;
		try {
			const vector = await fetchEmbedding(semanticQuery, embedding);
			if (vector) queryVector = new Float32Array(vector);
		} catch (error) {
			logger.warn("hooks", "Entity attribute semantic scoring failed; using lexical attribute scoring", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		vectorsByEntity.set(entity.entityId, { semanticQuery, queryVector });
	}
	if (vectorsByEntity.size === 0) return { lines: [], memoryCount: 0, engine: "no-aspect-hit" };
	return getDbAccessor().withReadDb((db) => {
		const lines = matches.flatMap((entity) =>
			loadEntityContextLines(
				db,
				entity,
				agentId,
				vectorsByEntity.get(entity.entityId)?.semanticQuery ?? "",
				minScore,
				vectorsByEntity.get(entity.entityId)?.queryVector ?? null,
			),
		);
		if (lines.length === 0) return { lines: [], memoryCount: 0, engine: "no-aspect-hit" };
		const selected = selectWithBudgetSkippingOversized(
			lines.map((line) => ({ content: formatEntityContextLine(line) })),
			injectBudget,
		).slice(0, ENTITY_CONTEXT_MAX_LINES);
		return {
			lines: selected.map((line) => line.content),
			memoryCount: selected.length,
			engine: selected.length > 0 ? "entity-context" : "no-aspect-hit",
		};
	});
}

export function buildEntityContextInject(
	metadataHeader: string,
	lines: ReadonlyArray<string>,
	pluginContext = "",
): string {
	const parts = [metadataHeader.trimEnd(), "", "## Relevant Entity Context", ""];
	if (pluginContext.trim().length > 0) {
		parts.push(pluginContext.trimEnd());
		parts.push("");
	}
	parts.push(...lines);
	return `${parts.join("\n").trimEnd()}\n`;
}

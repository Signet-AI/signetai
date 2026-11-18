import { existsSync } from "node:fs";
import { getDbOwner } from "./db-owner-runtime";
import type { DbOwnerClient } from "./db-owner-client";
import { cancellableOwner, ownerReadAll } from "./db-owner-sql";

export type PromptEntityMatch = {
	readonly entityId: string;
	readonly entityName: string;
	readonly entityType: string;
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

type PromptEntityRow = {
	readonly entity_id: string;
	readonly entity_name: string;
	readonly entity_type: string;
	readonly matched_text: string;
	readonly match_source: "name" | "alias";
	readonly mentions: number;
	readonly pinned: number;
};

const PROMPT_ENTITY_MAX_MATCHES = 2;
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
export function promptPhraseSpan(
	promptTerms: readonly string[],
	phrase: string,
): { readonly start: number; readonly end: number } | null {
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

const PROMPT_ROLE_ENTITY_DENY_TERMS = new Set(["assistant", "human", "user"]);

function isPromptGenericEntityPhrase(phraseTerms: readonly string[]): boolean {
	if (phraseTerms.length !== 1) return false;
	const term = phraseTerms[0] ?? "";
	if (PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(term)) return true;
	return term.endsWith("s") && PROMPT_BARE_POSSESSIVE_DENY_TERMS.has(term.slice(0, -1));
}

function isPromptRoleEntity(row: PromptEntityRow): boolean {
	if (Math.min(Math.max(0, row.pinned), 1) > 0) return false;
	const entityTerms = promptEntityTerms(row.entity_name);
	const matchedTerms = promptEntityTerms(row.matched_text);
	if (entityTerms.length !== 1 || matchedTerms.length !== 1) return false;
	return (
		PROMPT_ROLE_ENTITY_DENY_TERMS.has(entityTerms[0] ?? "") && PROMPT_ROLE_ENTITY_DENY_TERMS.has(matchedTerms[0] ?? "")
	);
}

function scorePromptEntityCandidate(row: PromptEntityRow): number {
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

function selectPromptEntityMatches(rows: readonly PromptEntityRow[], userMessage: string): PromptEntityMatch[] {
	const candidatesByPhrase = new Map<string, PromptEntityCandidate[]>();
	const promptTerms = promptEntityTerms(userMessage);
	for (const row of rows) {
		if (isPromptRoleEntity(row)) continue;
		if (isPromptGenericEntityPhrase(promptEntityTerms(row.matched_text))) continue;
		const span = promptPhraseSpan(promptTerms, row.matched_text);
		if (!span) continue;
		const normalizedPhrase = normalizePromptEntityText(row.matched_text);
		const candidate: PromptEntityCandidate = {
			entityId: row.entity_id,
			entityName: row.entity_name,
			entityType: row.entity_type,
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
			matchedText: row.matchedText,
			matchSource: row.matchSource,
			mentions: row.mentions,
		});
		if (result.length >= PROMPT_ENTITY_MAX_MATCHES) break;
	}
	return result;
}

const PROMPT_ENTITY_PAGE_ROWS = 250;
const PROMPT_ENTITY_MAX_TEXT_BYTES = 256;

type PromptEntityPageRow<Cursor> = PromptEntityRow & { readonly cursor: Cursor };

const PROMPT_ENTITY_ELIGIBLE = `COALESCE(e.status, 'active') = 'active'
		   AND LOWER(e.entity_type) IN ('person', 'project')
		   AND LENGTH(CAST(e.name AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}`;

const PROMPT_ENTITY_NAMES = `SELECT
		   e.rowid AS cursor,
		   e.id AS entity_id,
		   e.name AS entity_name,
		   COALESCE(e.entity_type, 'unknown') AS entity_type,
		   COALESCE(e.canonical_name, LOWER(e.name)) AS matched_text,
		   'name' AS match_source,
		   COALESCE(e.mentions, 0) AS mentions,
		   COALESCE(e.pinned, 0) AS pinned
		 FROM entities e
		 WHERE e.agent_id = ?
		   AND e.rowid > ?
		   AND ${PROMPT_ENTITY_ELIGIBLE}
		   AND LENGTH(CAST(COALESCE(e.canonical_name, LOWER(e.name)) AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		 ORDER BY e.rowid
		 LIMIT ?`;

const PROMPT_ENTITY_ALIASES = `SELECT
		   a.canonical_alias AS cursor,
		   e.id AS entity_id,
		   e.name AS entity_name,
		   COALESCE(e.entity_type, 'unknown') AS entity_type,
		   a.alias AS matched_text,
		   'alias' AS match_source,
		   COALESCE(e.mentions, 0) AS mentions,
		   COALESCE(e.pinned, 0) AS pinned
		 FROM entity_aliases a INDEXED BY idx_entity_aliases_active_unique
		 JOIN entities e ON e.id = a.entity_id AND e.agent_id = a.agent_id
		 WHERE a.agent_id = ?
		   AND a.status = 'active'
		   AND a.canonical_alias > ?
		   AND LENGTH(CAST(a.canonical_alias AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		   AND LENGTH(CAST(a.alias AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		   AND ${PROMPT_ENTITY_ELIGIBLE}
		 ORDER BY a.canonical_alias
		 LIMIT ?`;

async function readPromptEntityPages<Cursor extends number | string>(
	owner: DbOwnerClient,
	sql: string,
	operation: string,
	agentId: string,
	initial: Cursor,
	visit: (row: PromptEntityRow) => void,
): Promise<void> {
	let after = initial;
	while (true) {
		const page = await ownerReadAll<PromptEntityPageRow<Cursor>>(
			owner,
			sql,
			[agentId, after, PROMPT_ENTITY_PAGE_ROWS],
			{
				operation,
				deadlineMs: 5_000,
				estimatedWorkUnits: PROMPT_ENTITY_PAGE_ROWS,
			},
		);
		for (const row of page) visit(row);
		const last = page.at(-1);
		if (!last || page.length < PROMPT_ENTITY_PAGE_ROWS) return;
		after = last.cursor;
	}
}

export async function matchPromptEntities(
	memoryDbPath: string,
	agentId: string,
	userMessage: string,
	signal?: AbortSignal,
): Promise<readonly PromptEntityMatch[]> {
	if (!existsSync(memoryDbPath)) return [];
	const owner = cancellableOwner(await getDbOwner(memoryDbPath), signal);
	const tables = await ownerReadAll<{ readonly name: string }>(
		owner,
		`SELECT name FROM sqlite_master
		 WHERE type = 'table'
		   AND name IN ('entities', 'entity_aliases')`,
		[],
		{ operation: "user-prompt-submit.entity-tables", deadlineMs: 5_000, estimatedWorkUnits: 1 },
	);
	if (tables.length !== 2) return [];
	const promptTerms = promptEntityTerms(userMessage);
	const candidates: PromptEntityRow[] = [];
	const visit = (row: PromptEntityRow): void => {
		if (promptPhraseSpan(promptTerms, row.matched_text)) candidates.push(row);
	};
	await readPromptEntityPages(owner, PROMPT_ENTITY_NAMES, "user-prompt-submit.entity-names", agentId, 0, visit);
	await readPromptEntityPages(owner, PROMPT_ENTITY_ALIASES, "user-prompt-submit.entity-aliases", agentId, "", visit);
	return selectPromptEntityMatches(candidates, userMessage);
}

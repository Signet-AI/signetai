import { existsSync } from "node:fs";
import { getDbOwner } from "./db-owner-runtime";
import { cancellableOwner, ownerReadAll, ownerReadOne } from "./db-owner-sql";
import { logger } from "./logger";

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

const PROMPT_ENTITY_PAGE_ROWS = 1000;

type PromptEntityPageRow = {
	readonly cursor: number;
	readonly entity_id: string;
	readonly entity_name: string;
	readonly entity_type: string;
	readonly name_text: string;
	readonly aliases: string;
	readonly mentions: number;
	readonly pinned: number;
};

const PROMPT_ENTITY_FILTER = `FROM entities e
		 WHERE e.agent_id = ?
		   AND e.rowid > ?
		   AND COALESCE(e.status, 'active') = 'active'
		   AND LOWER(e.entity_type) IN ('person', 'project')
		 ORDER BY e.rowid`;

const PROMPT_ENTITY_PAGE = `SELECT
		   e.rowid AS cursor,
		   e.id AS entity_id,
		   e.name AS entity_name,
		   COALESCE(e.entity_type, 'unknown') AS entity_type,
		   COALESCE(e.canonical_name, LOWER(e.name)) AS name_text,
		   (SELECT json_group_array(a.alias)
		      FROM entity_aliases a
		     WHERE a.agent_id = e.agent_id
		       AND a.entity_id = e.id
		       AND a.status = 'active') AS aliases,
		   COALESCE(e.mentions, 0) AS mentions,
		   COALESCE(e.pinned, 0) AS pinned
		 ${PROMPT_ENTITY_FILTER}
		 LIMIT ?`;

const PROMPT_ENTITY_NEXT = `SELECT e.rowid AS cursor
		 ${PROMPT_ENTITY_FILTER}
		 LIMIT 1`;

function promptEntityRows(row: PromptEntityPageRow): PromptEntityRow[] {
	const parsed: unknown = JSON.parse(row.aliases);
	const aliases = Array.isArray(parsed) ? parsed.filter((alias): alias is string => typeof alias === "string") : [];
	return [
		{ ...row, matched_text: row.name_text, match_source: "name" },
		...aliases.map((alias) => ({ ...row, matched_text: alias, match_source: "alias" as const })),
	];
}

function resultTooLarge(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "DB_OWNER_RESULT_TOO_LARGE";
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
	let after = 0;
	let rows = PROMPT_ENTITY_PAGE_ROWS;
	while (true) {
		const page = await ownerReadAll<PromptEntityPageRow>(owner, PROMPT_ENTITY_PAGE, [agentId, after, rows], {
			operation: "user-prompt-submit.entities",
			deadlineMs: 5_000,
			estimatedWorkUnits: rows,
		}).catch((error: unknown) => {
			if (resultTooLarge(error)) return null;
			throw error;
		});
		if (page === null && rows > 1) {
			rows = Math.ceil(rows / 2);
			continue;
		}
		if (page === null) {
			const skipped = await ownerReadOne<{ readonly cursor: number }>(owner, PROMPT_ENTITY_NEXT, [agentId, after], {
				operation: "user-prompt-submit.entities.skip",
				deadlineMs: 5_000,
				estimatedWorkUnits: 1,
			});
			if (!skipped) break;
			logger.warn("hooks", "Skipped a prompt entity row larger than the DB owner result limit", { agentId });
			after = skipped.cursor;
			rows = PROMPT_ENTITY_PAGE_ROWS;
			continue;
		}
		for (const row of page) {
			for (const candidate of promptEntityRows(row)) {
				if (promptPhraseSpan(promptTerms, candidate.matched_text)) candidates.push(candidate);
			}
		}
		const last = page.at(-1);
		if (!last || page.length < rows) break;
		after = last.cursor;
		rows = Math.min(PROMPT_ENTITY_PAGE_ROWS, rows * 2);
	}
	return selectPromptEntityMatches(candidates, userMessage);
}

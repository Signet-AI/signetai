/**
 * Conservative inline entity mention linking for the remember endpoint.
 *
 * The default remember path is intentionally mechanical: it may attach a
 * memory to entities that already exist in the graph, but it must not invent
 * entities, aspects, attributes, or dependencies from raw text. Semantic graph
 * authorship belongs to structured remember payloads, explicit user/agent
 * intent, or reviewed repair/normalization passes.
 */

import type { WriteDb } from "./db-accessor";

// ---------------------------------------------------------------------------
// Decision pattern detection
// ---------------------------------------------------------------------------

const DECISION_PATTERNS: readonly RegExp[] = [
	/\b(?:chose|chosen)\s+(?:to\s+)?(?:use\s+)?(?:over|instead)/i,
	/\bdecided\s+(?:to\s+|on\s+|against\s+)/i,
	/\bswitched\s+(?:from|to)\b/i,
	/\bmigrated?\s+(?:from|to|away)\b/i,
	/\bpicked\s+.+\s+over\b/i,
	/\bwent\s+with\b/i,
	/\bsticking\s+with\b/i,
	/\bcommitted\s+to\b/i,
	/\bsettled\s+on\b/i,
	/\bwill\s+(?:use|go\s+with|stick\s+with)\b/i,
	/\bprefer(?:s|red)?\s+.+\s+(?:over|instead|rather)\b/i,
	/\badopted\b/i,
	/\barchitecture\s+decision\b/i,
	/\bdesign\s+decision\b/i,
];

/** Check whether content text contains decision-indicating language. */
export function isDecisionContent(content: string): boolean {
	return DECISION_PATTERNS.some((re) => re.test(content));
}

// ---------------------------------------------------------------------------
// Name extraction
// ---------------------------------------------------------------------------

// Common words that appear capitalized but aren't entity names
const SKIP_WORDS = new Set([
	"the",
	"this",
	"that",
	"these",
	"those",
	"there",
	"then",
	"what",
	"when",
	"where",
	"which",
	"while",
	"who",
	"whom",
	"how",
	"here",
	"have",
	"has",
	"had",
	"his",
	"her",
	"its",
	"our",
	"your",
	"their",
	"some",
	"any",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"many",
	"much",
	"other",
	"another",
	"such",
	"like",
	"just",
	"also",
	"only",
	"very",
	"really",
	"quite",
	"rather",
	"still",
	"already",
	"even",
	"never",
	"always",
	"often",
	"sometimes",
	"usually",
	"about",
	"after",
	"before",
	"between",
	"during",
	"since",
	"until",
	"into",
	"onto",
	"from",
	"with",
	"without",
	"through",
	"across",
	"along",
	"around",
	"behind",
	"below",
	"above",
	"under",
	"over",
	"near",
	"next",
	"last",
	"first",
	"second",
	"third",
	"new",
	"old",
	"good",
	"great",
	"best",
	"well",
	"long",
	"high",
	"low",
	"big",
	"small",
	"large",
	"little",
	"much",
	"own",
	"same",
	"different",
	"important",
	"sure",
	"true",
	"right",
	"left",
	"yes",
	"not",
	"but",
	"and",
	"for",
	"nor",
	"yet",
	"can",
	"may",
	"will",
	"shall",
	"should",
	"would",
	"could",
	"might",
	"must",
	"does",
	"did",
	"been",
	"being",
	"are",
	"was",
	"were",
	"note",
	"also",
	"however",
	"therefore",
	"thus",
	"moreover",
	"furthermore",
	"additionally",
	"meanwhile",
	"recently",
	"currently",
	"previously",
	"originally",
	"apparently",
	"specifically",
	"essentially",
	"generally",
	"typically",
	"particularly",
	"especially",
	"actually",
	"unfortunately",
	"fortunately",
	"certainly",
	"obviously",
	"basically",
	"exactly",
	"simply",
	"finally",
	"initially",
	// Markdown / structural tokens
	"key",
	"facts",
	"preferences",
	"events",
	"relationships",
]);

/**
 * Extract candidate proper nouns from text. Finds capitalized words
 * and multi-word names (consecutive capitalized tokens). Filters out
 * sentence-initial capitals and common false positives.
 */
export function extractCandidateNames(text: string): string[] {
	const names: string[] = [];
	const sentences = text.split(/[.!?\n]+/).filter(Boolean);

	for (const sentence of sentences) {
		const words = sentence.trim().split(/\s+/);
		if (words.length === 0) continue;

		let run: string[] = [];

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			const clean = word.replace(/[,;:'"()[\]{}]+$/g, "").replace(/^['"([\]{}]+/, "");
			if (!clean) continue;

			const isCapitalized = /^[A-Z][a-z]/.test(clean);
			const isAllCaps = /^[A-Z]{2,}$/.test(clean) && clean.length <= 6;

			if ((isCapitalized || isAllCaps) && !SKIP_WORDS.has(clean.toLowerCase())) {
				// Sentence-initial capitals that pass SKIP_WORDS are proper
				// nouns (Caroline, Melanie, etc.) — include them.
				run.push(clean);
			} else {
				if (run.length > 0) {
					const name = run.join(" ");
					if (name.length >= 3) names.push(name);
					run = [];
				}
			}
		}

		if (run.length > 0) {
			const name = run.join(" ");
			if (name.length >= 3) names.push(name);
		}
	}

	return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Existing entity resolution
// ---------------------------------------------------------------------------

function resolveKnownEntity(db: WriteDb, name: string, agentId: string, now: string): string {
	const canonical = name.trim().toLowerCase().replace(/\s+/g, " ");
	if (canonical.length < 3) return "";

	const existing = db
		.prepare(
			`SELECT id FROM entities
			 WHERE (canonical_name = ? OR name = ?) AND agent_id = ?
			 LIMIT 1`,
		)
		.get(canonical, name, agentId) as { id: string } | undefined;

	if (existing) {
		db.prepare("UPDATE entities SET mentions = mentions + 1, updated_at = ? WHERE id = ?").run(now, existing.id);
		return existing.id;
	}

	return "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LinkResult {
	readonly linked: number;
	readonly entityIds: string[];
	readonly aspects: number;
	readonly attributes: number;
}

/**
 * Link a memory to already-known entities found in its content.
 *
 * This is deliberately mention-only. It never creates graph structure from
 * raw text, because doing so turns incidental casing and LLM-ish heuristics
 * into semantic claims. Structured remember is the graph write surface.
 *
 * Must run inside a withWriteTx closure.
 */
export function linkMemoryToEntities(db: WriteDb, memoryId: string, content: string, agentId: string): LinkResult {
	const names = extractCandidateNames(content);
	if (names.length === 0) return { linked: 0, entityIds: [], aspects: 0, attributes: 0 };

	const now = new Date().toISOString();
	let linked = 0;
	const entityIds: string[] = [];

	for (const name of names) {
		const entityId = resolveKnownEntity(db, name, agentId, now);
		if (!entityId) continue;
		entityIds.push(entityId);

		const ins = db
			.prepare(
				`INSERT OR IGNORE INTO memory_entity_mentions
			 (memory_id, entity_id, mention_text, confidence, created_at)
			 VALUES (?, ?, ?, 0.8, ?)`,
			)
			.run(memoryId, entityId, name, now);
		if (ins.changes > 0) linked++;
	}

	return { linked, entityIds, aspects: 0, attributes: 0 };
}

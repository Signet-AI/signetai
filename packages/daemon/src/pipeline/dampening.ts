/**
 * Post-fusion dampening pipeline (DP-16).
 *
 * Three corrections applied AFTER fusion scoring but BEFORE the final
 * sort/return in hybridRecall(). Addresses score bunching where the
 * right answer and irrelevant results land at similar scores.
 *
 * Stages:
 *  1. Gravity — penalize high-cosine, zero-term-overlap "hallucinations"
 *  2. Hub — penalize results dominated by high-degree hub entities
 *  3. Resolution — boost actionable/specific memories (constraints, decisions)
 *
 * Inspired by Ori-Mnemos dampening patterns.
 */

import { FTS_STOP } from "./stop-words";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DampeningConfig {
	readonly gravityEnabled: boolean;
	readonly hubEnabled: boolean;
	readonly resolutionEnabled: boolean;
	readonly hubPercentile: number; // default 0.9 (P90)
	readonly hubPenalty: number; // default 0.7
	readonly gravityPenalty: number; // default 0.5
	readonly resolutionBoost: number; // default 1.2
}

export const DEFAULT_DAMPENING: DampeningConfig = {
	gravityEnabled: true,
	hubEnabled: true,
	resolutionEnabled: true,
	hubPercentile: 0.9,
	hubPenalty: 0.7,
	gravityPenalty: 0.5,
	resolutionBoost: 1.2,
};

/** Scored result with content/type hydrated for dampening analysis. */
export interface ScoredRow {
	readonly id: string;
	score: number;
	readonly source: string;
	readonly content: string;
	readonly type: string;
}

// ---------------------------------------------------------------------------
// Tokenizer (shared between gravity check and caller)
// ---------------------------------------------------------------------------

const PUNCT = /[^a-z0-9\s]/g;

/** Lowercase, strip punctuation, drop stop words and short tokens. */
function tokenize(text: string): ReadonlySet<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().replace(PUNCT, " ").split(/\s+/)) {
		if (raw.length < 2) continue;
		if (FTS_STOP.has(raw)) continue;
		tokens.add(raw);
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Stage 1: Gravity dampening
// ---------------------------------------------------------------------------

const VECTOR_SOURCES = new Set(["vector", "hybrid", "traversal", "ka_traversal", "sec", "structured"]);

/**
 * Penalize results that arrived via semantic similarity but share zero
 * query-term overlap with the actual content. These are "semantic
 * hallucinations" — the embedding model thinks they're related but the
 * surface words don't overlap at all.
 */
function gravity(rows: readonly ScoredRow[], query: ReadonlySet<string>, penalty: number): void {
	for (const row of rows) {
		// Only penalize results that came through a vector/semantic path
		if (!VECTOR_SOURCES.has(row.source)) continue;
		// Only target results with meaningful cosine contribution (>0.3)
		if (row.score <= 0.3) continue;

		const content = tokenize(row.content);
		let overlap = false;
		for (const qt of query) {
			if (content.has(qt)) {
				overlap = true;
				break;
			}
		}
		if (!overlap) {
			row.score *= penalty;
		}
	}
}

// ---------------------------------------------------------------------------
// Stage 2: Hub dampening
// ---------------------------------------------------------------------------

/**
 * Compute the P-threshold degree from entity mention counts.
 * Entities above this count are considered hubs.
 */
function hubThreshold(degrees: ReadonlyMap<string, number>, percentile: number): number {
	const counts = [...degrees.values()].sort((a, b) => a - b);
	if (counts.length === 0) return Number.POSITIVE_INFINITY;
	const idx = Math.floor(counts.length * percentile);
	return counts[Math.min(idx, counts.length - 1)];
}

/**
 * Penalize results whose linked entities are ALL high-degree hubs.
 * If a memory only connects to popular entities (top percentile by
 * mention count), it's likely noise riding on common references.
 */
function hub(
	rows: readonly ScoredRow[],
	entities: ReadonlyMap<string, ReadonlySet<string>>,
	degrees: ReadonlyMap<string, number>,
	penalty: number,
	percentile: number,
): void {
	const threshold = hubThreshold(degrees, percentile);
	if (threshold === Number.POSITIVE_INFINITY) return;

	for (const row of rows) {
		const linked = entities.get(row.id);
		if (!linked || linked.size === 0) continue;

		let allHubs = true;
		for (const eid of linked) {
			const deg = degrees.get(eid) ?? 0;
			if (deg < threshold) {
				allHubs = false;
				break;
			}
		}
		if (allHubs) {
			row.score *= penalty;
		}
	}
}

// ---------------------------------------------------------------------------
// Stage 3: Resolution boost
// ---------------------------------------------------------------------------

const BOOSTED_TYPES = new Set(["constraint", "decision"]);
const PREFERENCE_QUERY_CUES = new Set([
	"advice",
	"advise",
	"idea",
	"ideas",
	"prefer",
	"preference",
	"recommend",
	"recommendation",
	"recommendations",
	"suggestion",
	"suggestions",
	"tip",
	"tips",
]);
const PREFERENCE_SECTION = /(^|\n)##\s+Preferences\b/i;
const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/;
const MONTH_PATTERN = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/**
 * Boost actionable/specific memories. Memories with concrete types
 * (constraint, decision) or temporal anchors (dates, month names) get
 * a multiplier. Short, vague content gets no boost.
 */
function resolution(rows: readonly ScoredRow[], boost: number, query: ReadonlySet<string>): void {
	const preferenceIntent = [...query].some((token) => PREFERENCE_QUERY_CUES.has(token));
	for (const row of rows) {
		if (BOOSTED_TYPES.has(row.type)) {
			row.score *= boost;
			continue;
		}
		if (preferenceIntent && row.type === "preference" && PREFERENCE_SECTION.test(row.content)) {
			row.score *= 1.6;
			continue;
		}
		// Skip short, vague content — nothing to boost
		if (row.content.length < 50) continue;

		// Temporal anchors get a lighter boost
		if (DATE_PATTERN.test(row.content) || MONTH_PATTERN.test(row.content)) {
			row.score *= 1 + (boost - 1) * 0.5;
		}
	}
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Apply post-fusion dampening to scored results.
 *
 * @param rows      - Scored results with content/type hydrated
 * @param query     - Raw query string
 * @param config    - Dampening configuration
 * @param entities  - Map of memory_id -> set of entity_ids linked to it
 * @param degrees   - Map of entity_id -> total mention count
 * @returns Re-sorted results with dampened/boosted scores
 */
export function applyDampening(
	rows: readonly ScoredRow[],
	query: string,
	config: DampeningConfig = DEFAULT_DAMPENING,
	entities?: ReadonlyMap<string, ReadonlySet<string>>,
	degrees?: ReadonlyMap<string, number>,
): ScoredRow[] {
	if (rows.length === 0) return [];

	// Mutable copy — dampening mutates scores in place then re-sorts
	const out: ScoredRow[] = rows.map((r) => ({ ...r }));
	const tokens = tokenize(query);

	if (config.gravityEnabled && tokens.size > 0) {
		gravity(out, tokens, config.gravityPenalty);
	}

	if (config.hubEnabled && entities && degrees && degrees.size > 0) {
		hub(out, entities, degrees, config.hubPenalty, config.hubPercentile);
	}

	if (config.resolutionEnabled) {
		resolution(out, config.resolutionBoost, tokens);
	}

	out.sort((a, b) => b.score - a.score);
	return out;
}

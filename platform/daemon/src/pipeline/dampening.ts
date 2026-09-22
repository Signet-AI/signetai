import { FTS_STOP } from "./stop-words";

export interface DampeningConfig {
	readonly gravityEnabled: boolean;
	readonly hubEnabled: boolean;
	readonly resolutionEnabled: boolean;
	readonly hubPercentile: number;
	readonly hubPenalty: number;
	readonly gravityPenalty: number;
	readonly resolutionBoost: number;
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
export interface ScoredRow {
	readonly id: string;
	score: number;
	readonly source: string;
	readonly content: string;
	readonly type: string;
}

const PUNCT = /[^a-z0-9\s]/g;
function tokenize(text: string): ReadonlySet<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().replace(PUNCT, " ").split(/\s+/)) {
		if (raw.length < 2) continue;
		if (FTS_STOP.has(raw)) continue;
		tokens.add(raw);
	}
	return tokens;
}

const VECTOR_SOURCES = new Set(["vector", "hybrid", "traversal", "ka_traversal", "sec", "structured"]);
function gravity(rows: readonly ScoredRow[], query: ReadonlySet<string>, penalty: number): void {
	for (const row of rows) {
		if (!VECTOR_SOURCES.has(row.source)) continue;
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
function hubThreshold(degrees: ReadonlyMap<string, number>, percentile: number): number {
	const counts = [...degrees.values()].sort((a, b) => a - b);
	if (counts.length === 0) return Number.POSITIVE_INFINITY;
	const idx = Math.floor(counts.length * percentile);
	return counts[Math.min(idx, counts.length - 1)];
}
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
		if (row.content.length < 50) continue;
		if (DATE_PATTERN.test(row.content) || MONTH_PATTERN.test(row.content)) {
			row.score *= 1 + (boost - 1) * 0.5;
		}
	}
}
export function applyDampening(
	rows: readonly ScoredRow[],
	query: string,
	config: DampeningConfig = DEFAULT_DAMPENING,
	entities?: ReadonlyMap<string, ReadonlySet<string>>,
	degrees?: ReadonlyMap<string, number>,
): ScoredRow[] {
	if (rows.length === 0) return [];
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

/**
 * Shared antonym pairs for contradiction detection.
 *
 * Used by both the pipeline worker (prospective contradiction risk)
 * and the supersession module (retroactive attribute contradiction).
 */

export const NEGATION_TOKENS = new Set([
	"not",
	"no",
	"never",
	"cannot",
	"cant",
	"doesnt",
	"dont",
	"isnt",
	"wasnt",
	"wont",
	"without",
]);

/**
 * Narrow set of boolean/toggle antonyms for prospective contradiction risk
 * scoring on UPDATE/DELETE proposals. Kept separate from the full set to
 * avoid widening the false-positive surface of existing prospective detection.
 */
export const PROSPECTIVE_ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["enabled", "disabled"],
	["allow", "deny"],
	["accept", "reject"],
	["always", "never"],
	["on", "off"],
	["true", "false"],
];

export const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
	// boolean / toggle
	["enabled", "disabled"],
	["allow", "deny"],
	["accept", "reject"],
	["always", "never"],
	["on", "off"],
	["true", "false"],
	["yes", "no"],
	// relationship
	["together", "apart"],
	["dating", "single"],
	["married", "divorced"],
	["friends", "strangers"],
	["close", "distant"],
	// preference
	["love", "hate"],
	["like", "dislike"],
	["prefer", "avoid"],
	["enjoy", "dread"],
	["want", "refuse"],
	// state
	["start", "stop"],
	["begin", "end"],
	["open", "close"],
	["join", "leave"],
	["arrive", "depart"],
	["buy", "sell"],
	["alive", "dead"],
	["active", "inactive"],
	// value / direction
	["positive", "negative"],
	["increase", "decrease"],
	["before", "after"],
];

/** Bidirectional set for O(1) lookup in either direction. */
export const ANTONYM_SET: ReadonlySet<string> = new Set(
	ANTONYM_PAIRS.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]),
);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length >= 2);
}

export function hasNegation(tokens: readonly string[]): boolean {
	return tokens.some((token) => NEGATION_TOKENS.has(token));
}

export function overlapCount(
	left: readonly string[],
	right: readonly string[],
): number {
	const rightSet = new Set(right);
	let overlap = 0;
	for (const token of left) {
		if (rightSet.has(token)) overlap++;
	}
	return overlap;
}

export function hasAntonymConflict(
	leftTokens: ReadonlySet<string>,
	rightTokens: ReadonlySet<string>,
	pairs: ReadonlyArray<readonly [string, string]> = ANTONYM_PAIRS,
): boolean {
	for (const [a, b] of pairs) {
		const leftHasA = leftTokens.has(a);
		const leftHasB = leftTokens.has(b);
		const rightHasA = rightTokens.has(a);
		const rightHasB = rightTokens.has(b);

		const leftExclusive = leftHasA !== leftHasB;
		const rightExclusive = rightHasA !== rightHasB;
		const opposite = (leftHasA && rightHasB) || (leftHasB && rightHasA);

		if (leftExclusive && rightExclusive && opposite) {
			return true;
		}
	}
	return false;
}

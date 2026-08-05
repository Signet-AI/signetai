import { countTokens, estimateTokens, truncateToTokens } from "./pipeline/tokenizer";

/** Truncate rows to fit a character budget, preserving the input type. */
export function selectWithBudget<T extends { content: string }>(rows: ReadonlyArray<T>, charBudget: number): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.content.length > charBudget) break;
		selected.push(row);
		used += row.content.length;
	}
	return selected;
}

/** Truncate rows to a character budget, skipping oversized rows instead of stopping at the first one. */
export function selectWithBudgetSkippingOversized<T extends { content: string }>(
	rows: ReadonlyArray<T>,
	charBudget: number,
): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		if (used + row.content.length > charBudget) continue;
		selected.push(row);
		used += row.content.length;
	}
	return selected;
}

/** Truncate rows to fit a token budget using BPE token counts. */
export function selectWithTokenBudget<T extends { content: string }>(rows: ReadonlyArray<T>, tokenBudget: number): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		const cost = countTokens(row.content);
		if (used + cost > tokenBudget) break;
		selected.push(row);
		used += cost;
	}
	return selected;
}

/**
 * Truncate rows to a token budget using the cheap character estimate instead
 * of exact BPE encodes. Same greedy contract as `selectWithTokenBudget`, but
 * never blocks the caller on tokenizer work — safe for hot paths such as
 * session-start recall, where per-row exact counts can cost tens of encodes.
 */
export function selectWithEstimatedTokenBudget<T extends { content: string }>(
	rows: ReadonlyArray<T>,
	tokenBudget: number,
): T[] {
	const selected: T[] = [];
	let used = 0;
	for (const row of rows) {
		const cost = estimateTokens(row.content);
		if (used + cost > tokenBudget) break;
		selected.push(row);
		used += cost;
	}
	return selected;
}

const TRUNCATED_MARKER = "\n[context truncated]";
const TRUNCATED_MARKER_TOKENS = countTokens(TRUNCATED_MARKER);

/**
 * Truncate `inject` to fit within `mainBudget` tokens.
 * Returns an empty string when budget is zero (reserved sections exhausted it).
 * Appends a truncation marker when budget permits; omits it when the budget is
 * too small to fit the marker itself (avoids overflow in that range).
 */
export function applyTokenBudget(inject: string, mainBudget: number): string {
	if (mainBudget <= 0) return "";
	// Cheap fit check: the worst case is one token per character, so an
	// inject shorter than the budget (in chars) is guaranteed to fit without
	// paying for a full BPE encode of the assembled context.
	if (inject.length <= mainBudget) return inject;
	if (countTokens(inject) <= mainBudget) return inject;
	// Budget too tight to fit content + marker — truncate without marker.
	if (mainBudget <= TRUNCATED_MARKER_TOKENS) return truncateToTokens(inject, mainBudget);
	return truncateToTokens(inject, mainBudget - TRUNCATED_MARKER_TOKENS) + TRUNCATED_MARKER;
}

import { countTokens, estimateTokens, truncateToTokens } from "./pipeline/tokenizer";
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

const MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT = 3;
const TRUNCATED_MARKER = "\n[context truncated]";
const TRUNCATED_MARKER_TOKENS = countTokens(TRUNCATED_MARKER);
export function applyTokenBudget(inject: string, mainBudget: number): string {
	if (mainBudget <= 0) return "";
	if (inject.length <= Math.floor(mainBudget / MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT)) return inject;
	if (countTokens(inject) <= mainBudget) return inject;
	if (mainBudget <= TRUNCATED_MARKER_TOKENS) return truncateToTokens(inject, mainBudget);
	return truncateToTokens(inject, mainBudget - TRUNCATED_MARKER_TOKENS) + TRUNCATED_MARKER;
}

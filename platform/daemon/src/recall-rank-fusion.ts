export const RECIPROCAL_RANK_K = 60;

export function rankPositions(scores: ReadonlyMap<string, number>, minScore: number): Map<string, number> {
	const kept = [...scores.entries()].filter(([, score]) => score > 0 && score >= minScore);
	kept.sort((left, right) => right[1] - left[1]);
	return new Map(kept.map(([id], index) => [id, index + 1]));
}

export function reciprocalRankScore(
	positions: ReadonlyArray<number | undefined>,
	k: number = RECIPROCAL_RANK_K,
): number {
	if (positions.length === 0) return 0;
	let sum = 0;
	for (const position of positions) {
		if (position !== undefined) sum += 1 / (k + position);
	}
	return (sum * (k + 1)) / positions.length;
}

export function selectPrimaryCandidates<T extends { readonly id: string }>(
	fused: readonly T[],
	budget: number,
	flatIds: ReadonlySet<string>,
	minFlat: number,
	reservedIds: ReadonlySet<string>,
): T[] {
	const selected = fused.filter((row) => reservedIds.has(row.id)).slice(0, budget);
	const kept = new Set(selected.map((row) => row.id));
	const flatTarget = Math.min(minFlat, flatIds.size);
	let flatCount = selected.filter((row) => flatIds.has(row.id)).length;
	for (const row of fused) {
		if (selected.length >= budget) break;
		if (kept.has(row.id)) continue;
		const isFlat = flatIds.has(row.id);
		const neededFlat = Math.max(0, flatTarget - flatCount);
		if (!isFlat && neededFlat >= budget - selected.length) continue;
		selected.push(row);
		if (isFlat) flatCount++;
	}
	return selected;
}

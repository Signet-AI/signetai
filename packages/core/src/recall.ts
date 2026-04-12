interface RecallScoreFilterRow {
	readonly score?: number;
	readonly supplementary?: boolean;
}

export interface RecallPartitionableRow {
	readonly supplementary?: boolean;
}

interface RecallScoreFilterPayload {
	readonly results?: ReadonlyArray<RecallScoreFilterRow>;
}

export function partitionRecallRows<T extends RecallPartitionableRow>(
	rows: ReadonlyArray<T>,
): {
	readonly primary: T[];
	readonly supporting: T[];
} {
	return {
		primary: rows.filter((row) => row.supplementary !== true),
		supporting: rows.filter((row) => row.supplementary === true),
	};
}

export function applyRecallScoreThreshold(raw: unknown, minScore?: number): unknown {
	if (
		typeof minScore !== "number" ||
		!Number.isFinite(minScore) ||
		typeof raw !== "object" ||
		raw === null ||
		Array.isArray(raw)
	) {
		return raw;
	}

	const payload = raw as RecallScoreFilterPayload;
	const rows = Array.isArray(payload.results) ? payload.results : [];
	// Keep unscored rows such as supplementary summaries in-band. Callers use
	// score thresholds to trim ranked matches, not to strip contextual cards
	// that do not participate in numeric ranking.
	const filtered = rows.filter((row) => typeof row.score !== "number" || row.score >= minScore);

	return {
		...payload,
		results: filtered,
		meta: {
			totalReturned: filtered.length,
			hasSupplementary: filtered.some((row) => row.supplementary === true),
			noHits: filtered.length === 0,
		},
	};
}

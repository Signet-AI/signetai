export type CrossEncoderScoreFn = (
	query: string,
	documents: readonly string[],
	deadlineAt?: number,
) => Promise<number[]>;

export type CrossEncoderMemoScore = (
	query: string,
	documents: readonly string[],
	extraDocuments?: readonly string[],
	deadlineAt?: number,
) => Promise<number[]>;

export function createCrossEncoderScoreMemo(deps: {
	readonly score: CrossEncoderScoreFn;
	readonly activeDevice: () => string | null;
	readonly requestedDevice: string;
}): CrossEncoderMemoScore {
	const scores = new Map<string, number>();
	let memoQuery: string | null = null;
	let memoDevice: string | null = null;
	return async (query, documents, extraDocuments = [], deadlineAt) => {
		if ((memoQuery ?? query) !== query) return await deps.score(query, documents, deadlineAt);
		const knownDevice = memoDevice ?? deps.activeDevice() ?? deps.requestedDevice;
		const piggyback = deps.requestedDevice === "cuda" && knownDevice === "cuda" ? extraDocuments : [];
		const batch = [...new Set([...documents, ...piggyback])].filter((document) => !scores.has(document));
		if (batch.length > 0) {
			const batchScores = await deps.score(query, batch, deadlineAt);
			const device = deps.activeDevice();
			if (memoDevice !== null && device !== memoDevice) {
				scores.clear();
				memoDevice = null;
				return await deps.score(query, documents, deadlineAt);
			}
			memoDevice = device;
			memoQuery = query;
			batch.forEach((document, index) => {
				const score = batchScores[index];
				if (typeof score === "number" && Number.isFinite(score)) scores.set(document, score);
			});
		}
		return documents.map((document) => scores.get(document) ?? Number.NEGATIVE_INFINITY);
	};
}

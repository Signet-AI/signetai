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
	const checkedScore: CrossEncoderScoreFn = async (query, documents, deadlineAt) => {
		const result = await deps.score(query, documents, deadlineAt);
		if (result.length !== documents.length || Array.from(result).some((score) => !Number.isFinite(score))) {
			throw new Error("Cross-encoder returned non-finite or missing scores");
		}
		return result;
	};
	return async (query, documents, extraDocuments = [], deadlineAt) => {
		if ((memoQuery ?? query) !== query) return await checkedScore(query, documents, deadlineAt);
		const knownDevice = memoDevice ?? deps.activeDevice() ?? deps.requestedDevice;
		const piggyback = deps.requestedDevice === "cuda" && knownDevice === "cuda" ? extraDocuments : [];
		const batch = [...new Set([...documents, ...piggyback])].filter((document) => !scores.has(document));
		if (batch.length > 0) {
			const batchScores = await checkedScore(query, batch, deadlineAt);
			const device = deps.activeDevice();
			if (memoDevice !== null && device !== memoDevice) {
				scores.clear();
				memoDevice = null;
				return await checkedScore(query, documents, deadlineAt);
			}
			memoDevice = device;
			memoQuery = query;
			batch.forEach((document, index) => {
				scores.set(document, batchScores[index]);
			});
		}
		return documents.map((document) => {
			const score = scores.get(document);
			if (score === undefined) throw new Error("Cross-encoder returned non-finite or missing scores");
			return score;
		});
	};
}

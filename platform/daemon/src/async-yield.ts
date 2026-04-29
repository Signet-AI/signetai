export function yieldEvery(batchSize: number): () => Promise<void> {
	const every = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 1;
	let count = 0;
	return () => {
		count++;
		if (count >= every) {
			count = 0;
			return new Promise<void>((resolve) => setImmediate(resolve));
		}
		return Promise.resolve();
	};
}

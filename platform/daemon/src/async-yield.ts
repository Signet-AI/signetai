export function yieldEvery(batchSize: number): () => Promise<void> {
	let count = 0;
	return () => {
		count++;
		if (count >= batchSize) {
			count = 0;
			return new Promise<void>((resolve) => setImmediate(resolve));
		}
		return Promise.resolve();
	};
}

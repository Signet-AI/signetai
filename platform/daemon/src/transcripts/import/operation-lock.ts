const lockTails = new Map<string, Promise<void>>();
export async function withTranscriptImportOperationLock<Result>(
	key: string,
	operation: () => Promise<Result>,
): Promise<Result> {
	const previous = lockTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	lockTails.set(key, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (lockTails.get(key) === current) lockTails.delete(key);
	}
}

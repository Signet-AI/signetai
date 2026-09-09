export async function startDeferredRuntimeAfterDreaming<T>(
	admitDreaming: () => void,
	startDeferredRuntime: () => Promise<T>,
): Promise<T> {
	admitDreaming();
	return startDeferredRuntime();
}

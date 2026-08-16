export interface DeferredRuntimeGate {
	readonly waitForIntegrity: () => Promise<void>;
	readonly completeIntegrity: () => void;
}

/**
 * Keep post-ready pipeline startup behind the deferred integrity work. Both
 * timers can mature together, but the DB owner must only see one maintenance
 * workload at a time.
 */
export function createDeferredRuntimeGate(): DeferredRuntimeGate {
	let resolveIntegrity: () => void = () => {};
	const integrityComplete = new Promise<void>((resolve) => {
		resolveIntegrity = resolve;
	});
	return {
		waitForIntegrity: async (): Promise<void> => await integrityComplete,
		completeIntegrity: (): void => {
			resolveIntegrity();
		},
	};
}

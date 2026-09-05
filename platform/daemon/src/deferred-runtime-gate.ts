export interface DeferredRuntimeGate {
	readonly waitForIntegrity: () => Promise<void>;
	readonly completeIntegrity: () => void;
}

export interface DeferredRuntimeScheduleOptions {
	readonly gate: DeferredRuntimeGate;
	readonly delayMs?: number;
	readonly schedule: (callback: () => void, delayMs: number) => unknown;
	readonly startIntegrity: () => Promise<void>;
	readonly startPipeline: () => Promise<void>;
	readonly onPipelineError: (error: unknown) => void;
	readonly onMaintenanceError?: (error: unknown) => void;
}

export interface DeferredRuntimeSchedulerOptions {
	readonly gate: DeferredRuntimeGate;
	readonly delayMs?: number;
	readonly schedule: (callback: () => void, delayMs: number) => unknown;
	readonly onPipelineError: (error: unknown) => void;
	readonly onMaintenanceError: (error: unknown) => void;
	/** Handle an integrity callback rejection before releasing the runtime gate. */
	readonly onIntegrityFailure?: (error: unknown) => void;
	/** Set false when the integrity callback will release the gate itself. */
	readonly completeIntegrityOnCallback?: boolean;
}

export interface DeferredRuntimeScheduler {
	readonly scheduleIntegrity: (callback: () => Promise<void>) => void;
	readonly schedulePipeline: (callback: () => Promise<void>) => void;
	readonly scheduleMaintenance: (callback: () => Promise<void>) => void;
}

/**
 * Release ordinary startup from the background integrity gate. A retained
 * migration backup still needs verification before any mutating runtime work.
 */
export function releaseDeferredRuntimeGateIfSafe(
	gate: DeferredRuntimeGate,
	options: { readonly migrationBackupPending: boolean; readonly writesBlocked: boolean },
): boolean {
	if (options.migrationBackupPending || options.writesBlocked) return false;
	gate.completeIntegrity();
	return true;
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

/** Create the production scheduler used by both same-delay callbacks. */
export function createDeferredRuntimeScheduler(options: DeferredRuntimeSchedulerOptions): DeferredRuntimeScheduler {
	const delayMs = options.delayMs ?? 30_000;
	const completeIntegrityOnCallback = options.completeIntegrityOnCallback ?? true;
	const handleIntegrityFailure = (error: unknown): void => {
		try {
			(options.onIntegrityFailure ?? options.onMaintenanceError)(error);
		} finally {
			// A rejected callback must never strand pipeline startup behind a gate
			// whose producer has already failed.
			options.gate.completeIntegrity();
		}
	};
	return {
		scheduleIntegrity: (callback): void => {
			options.schedule(() => {
				void callback()
					.then(() => {
						if (completeIntegrityOnCallback) options.gate.completeIntegrity();
					})
					.catch(handleIntegrityFailure);
			}, delayMs);
		},
		schedulePipeline: (callback): void => {
			options.schedule(() => {
				void options.gate.waitForIntegrity().then(callback).catch(options.onPipelineError);
			}, delayMs);
		},
		scheduleMaintenance: (callback): void => {
			options.schedule(() => {
				void options.gate.waitForIntegrity().then(callback).catch(options.onMaintenanceError);
			}, delayMs);
		},
	};
}

/** Schedule both deferred callbacks while serializing pipeline startup. */
export function scheduleDeferredRuntimeWork(options: DeferredRuntimeScheduleOptions): void {
	const scheduler = createDeferredRuntimeScheduler({
		...options,
		onMaintenanceError: options.onMaintenanceError ?? options.onPipelineError,
	});
	scheduler.scheduleIntegrity(options.startIntegrity);
	scheduler.schedulePipeline(options.startPipeline);
}

export interface DeferredRuntimeGate {
	readonly waitForIntegrity: () => Promise<void>;
	readonly completeIntegrity: () => void;
	readonly waitForVerifiedIntegrity: () => Promise<boolean>;
	readonly completeVerifiedIntegrity: (healthy: boolean) => void;
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
	readonly onIntegrityFailure?: (error: unknown) => void;
	readonly completeIntegrityOnCallback?: boolean;
}

export interface DeferredRuntimeScheduler {
	readonly scheduleIntegrity: (callback: () => Promise<void>) => void;
	readonly schedulePipeline: (callback: () => Promise<void>) => void;
	readonly scheduleMaintenance: (callback: () => Promise<void>) => void;
}
export function releaseDeferredRuntimeGateIfSafe(
	gate: DeferredRuntimeGate,
	options: { readonly migrationBackupPending: boolean; readonly writesBlocked: boolean },
): boolean {
	if (options.migrationBackupPending || options.writesBlocked) return false;
	gate.completeIntegrity();
	return true;
}
export function createDeferredRuntimeGate(): DeferredRuntimeGate {
	let resolveIntegrity: () => void = () => {};
	const integrityComplete = new Promise<void>((resolve) => {
		resolveIntegrity = resolve;
	});
	let resolveVerifiedIntegrity: (healthy: boolean) => void = () => {};
	const verifiedIntegrity = new Promise<boolean>((resolve) => {
		resolveVerifiedIntegrity = resolve;
	});
	let verifiedIntegrityCompleted = false;
	return {
		waitForIntegrity: async (): Promise<void> => await integrityComplete,
		completeIntegrity: (): void => {
			resolveIntegrity();
		},
		waitForVerifiedIntegrity: async (): Promise<boolean> => await verifiedIntegrity,
		completeVerifiedIntegrity: (healthy): void => {
			if (verifiedIntegrityCompleted) return;
			verifiedIntegrityCompleted = true;
			resolveVerifiedIntegrity(healthy);
		},
	};
}
export function createDeferredRuntimeScheduler(options: DeferredRuntimeSchedulerOptions): DeferredRuntimeScheduler {
	const delayMs = options.delayMs ?? 30_000;
	const completeIntegrityOnCallback = options.completeIntegrityOnCallback ?? true;
	const handleIntegrityFailure = (error: unknown): void => {
		try {
			(options.onIntegrityFailure ?? options.onMaintenanceError)(error);
		} finally {
			options.gate.completeVerifiedIntegrity(false);
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
export function scheduleDeferredRuntimeWork(options: DeferredRuntimeScheduleOptions): void {
	const scheduler = createDeferredRuntimeScheduler({
		...options,
		onMaintenanceError: options.onMaintenanceError ?? options.onPipelineError,
	});
	scheduler.scheduleIntegrity(options.startIntegrity);
	scheduler.schedulePipeline(options.startPipeline);
}

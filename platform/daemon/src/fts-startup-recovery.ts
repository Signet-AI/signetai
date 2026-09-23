import type { FtsBackfillOptions, FtsBackfillResult } from "./db-owner-maintenance";

export interface FtsStartupRecoveryOptions {
	readonly backfill: (options?: FtsBackfillOptions) => Promise<FtsBackfillResult>;
	readonly backfillOptions?: FtsBackfillOptions;
	readonly scheduleContinuation: (callback: () => void, delayMs: number) => void;
	readonly onPass?: (result: FtsBackfillResult) => void;
}

const FTS_STARTUP_CONTINUATION_DELAY_MS = 1_000;

function scheduleBackfillPass(options: FtsStartupRecoveryOptions): Promise<FtsBackfillResult> {
	return new Promise<FtsBackfillResult>((resolve, reject) => {
		options.scheduleContinuation(() => {
			void options.backfill(options.backfillOptions).then(resolve, reject);
		}, FTS_STARTUP_CONTINUATION_DELAY_MS);
	});
}

export async function completeFtsStartupRecovery(options: FtsStartupRecoveryOptions): Promise<FtsBackfillResult> {
	let result = await options.backfill(options.backfillOptions);
	options.onPass?.(result);

	while (result.status === "running") {
		result = await scheduleBackfillPass(options);
		options.onPass?.(result);
	}

	return result;
}

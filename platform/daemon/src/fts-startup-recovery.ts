/**
 * Resume bounded FTS owner work without keeping startup or the event loop busy.
 *
 * Each pass is capped by the owner maintenance implementation. Continuations
 * are scheduled as separate callbacks so other deferred work can run between
 * passes while the persistent checkpoint remains the source of truth.
 */

import type { FtsBackfillOptions, FtsBackfillResult } from "./db-owner-maintenance";

export interface FtsStartupRecoveryOptions {
	readonly backfill: (options?: FtsBackfillOptions) => Promise<FtsBackfillResult>;
	readonly backfillOptions?: FtsBackfillOptions;
	readonly scheduleContinuation: (callback: () => void) => void;
	readonly onPass?: (result: FtsBackfillResult) => void;
}

function scheduleBackfillPass(options: FtsStartupRecoveryOptions): Promise<FtsBackfillResult> {
	return new Promise<FtsBackfillResult>((resolve, reject) => {
		options.scheduleContinuation(() => {
			void options.backfill(options.backfillOptions).then(resolve, reject);
		});
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

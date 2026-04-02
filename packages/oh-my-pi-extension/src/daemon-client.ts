import { createDaemonClient as createBaseDaemonClient, type DaemonClient, type DaemonFetchFailure, type DaemonFetchResult } from "@signet/extension-base";
import { READ_TIMEOUT, RUNTIME_PATH } from "./types.js";

export type { DaemonClient, DaemonFetchFailure, DaemonFetchResult };

export function createDaemonClient(daemonUrl: string): DaemonClient {
	return createBaseDaemonClient(daemonUrl, {
		logPrefix: "signet-oh-my-pi",
		actorName: "oh-my-pi-extension",
		runtimePath: RUNTIME_PATH,
		defaultTimeout: READ_TIMEOUT,
	});
}

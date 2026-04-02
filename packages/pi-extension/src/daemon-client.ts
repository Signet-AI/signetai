import { createDaemonClient as createBaseDaemonClient, type DaemonClient } from "@signet/extension-base";
import { READ_TIMEOUT, RUNTIME_PATH } from "./types.js";

export type { DaemonClient };

export function createDaemonClient(daemonUrl: string): DaemonClient {
	return createBaseDaemonClient(daemonUrl, {
		logPrefix: "signet-pi",
		actorName: "pi-extension",
		runtimePath: RUNTIME_PATH,
		defaultTimeout: READ_TIMEOUT,
	});
}

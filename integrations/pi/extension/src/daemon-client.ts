import {
	type DaemonClient,
	type DaemonRequestClient,
	type DaemonStatusClient,
	createDaemonClient as createBaseDaemonClient,
} from "@signet/pi-extension-base";
import { READ_TIMEOUT, RUNTIME_PATH } from "./types.js";

export type { DaemonClient, DaemonRequestClient, DaemonStatusClient };

export function createDaemonClient(daemonUrl: string): DaemonStatusClient & DaemonRequestClient {
	return createBaseDaemonClient(daemonUrl, {
		logPrefix: "signet-pi",
		actorName: "pi-extension",
		runtimePath: RUNTIME_PATH,
		defaultTimeout: READ_TIMEOUT,
		logFailures: false,
	});
}

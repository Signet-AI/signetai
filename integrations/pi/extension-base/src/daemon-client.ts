import {
	createDaemonFetcher,
	createDaemonPluginHeaders,
	type DaemonFetchResult,
} from "@signet/connector-base/daemon-client";

export type { DaemonFetchFailure, DaemonFetchResult } from "@signet/connector-base/daemon-client";

export interface DaemonClientConfig {
	readonly logPrefix: string;
	readonly actorName: string;
	readonly runtimePath: string;
	readonly defaultTimeout: number;
	readonly logFailures?: boolean;
}

export interface DaemonClient {
	post<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	postResult<T>(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<T>>;
}

export interface DaemonStatusClient extends DaemonClient {
	postStatus(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<void>>;
}

export function createDaemonClient(daemonUrl: string, config: DaemonClientConfig): DaemonStatusClient {
	const fetchResult = createDaemonFetcher({
		headers: () => createDaemonPluginHeaders(config.actorName, config.runtimePath),
		logPrefix: config.logPrefix,
		logFailures: config.logFailures,
	});
	const postResult = <T>(path: string, body: unknown, timeout = config.defaultTimeout): Promise<DaemonFetchResult<T>> =>
		fetchResult<T>(daemonUrl, path, { method: "POST", body, timeout });

	return {
		async post<T>(path: string, body: unknown, timeout = config.defaultTimeout): Promise<T | null> {
			const result = await postResult<T>(path, body, timeout);
			return result.ok ? result.data : null;
		},
		postResult,
		postStatus(path, body, timeout = config.defaultTimeout): Promise<DaemonFetchResult<void>> {
			return fetchResult<void>(daemonUrl, path, { method: "POST", body, timeout, parseJson: false });
		},
	};
}

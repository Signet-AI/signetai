import {
	createDaemonFetcher,
	createDaemonPluginHeaders,
	type DaemonFetchResult,
} from "@signet/connector-base/daemon-client";
import { READ_TIMEOUT, RUNTIME_PATH, WRITE_TIMEOUT } from "./types.js";

export type { DaemonFetchFailure, DaemonFetchResult } from "@signet/connector-base/daemon-client";

const pluginHeaders = (): Record<string, string> => createDaemonPluginHeaders("opencode-plugin", RUNTIME_PATH);

const fetchResult = createDaemonFetcher({ headers: pluginHeaders, logPrefix: "signet" });
const healthFetch = createDaemonFetcher({
	headers: pluginHeaders,
	logPrefix: "signet",
	defaultTimeout: 1000,
	logFailures: false,
});

async function daemonFetch<T>(
	daemonUrl: string,
	path: string,
	options: { readonly method?: string; readonly body?: unknown; readonly timeout?: number } = {},
): Promise<T | null> {
	const result = await fetchResult<T>(daemonUrl, path, { method: "GET", ...options });
	return result.ok ? result.data : null;
}

export async function isDaemonRunning(daemonUrl: string): Promise<boolean> {
	return (await healthFetch<void>(daemonUrl, "/health", { parseJson: false })).ok;
}

export interface DaemonClient {
	get<T>(path: string, timeout?: number): Promise<T | null>;
	post<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	postResult<T>(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<T>>;
	patch<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	del<T>(path: string, timeout?: number): Promise<T | null>;
}

export function createDaemonClient(daemonUrl: string): DaemonClient {
	return {
		get<T>(path: string, timeout = READ_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, { timeout });
		},
		post<T>(path: string, body: unknown, timeout = WRITE_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, { method: "POST", body, timeout });
		},
		postResult<T>(path: string, body: unknown, timeout = WRITE_TIMEOUT): Promise<DaemonFetchResult<T>> {
			return fetchResult<T>(daemonUrl, path, { method: "POST", body, timeout });
		},
		patch<T>(path: string, body: unknown, timeout = WRITE_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, { method: "PATCH", body, timeout });
		},
		del<T>(path: string, timeout = WRITE_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, { method: "DELETE", timeout });
		},
	};
}

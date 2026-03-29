import { READ_TIMEOUT, RUNTIME_PATH } from "./types.js";

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
	  };

function harnessHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-signet-runtime-path": RUNTIME_PATH,
		"x-signet-actor": "oh-my-pi-extension",
		"x-signet-actor-type": "harness",
	};
}

function isTimeoutError(error: unknown): error is DOMException {
	return error instanceof DOMException && error.name === "TimeoutError";
}

async function daemonFetch<T>(
	daemonUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<T | null> {
	const result = await daemonFetchResult<T>(daemonUrl, path, options);
	if (!result.ok) return null;
	return result.data;
}

async function daemonFetchResult<T>(
	daemonUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<DaemonFetchResult<T>> {
	const { method = "POST", body, timeout = READ_TIMEOUT } = options;

	try {
		const init: RequestInit = {
			method,
			headers: harnessHeaders(),
			signal: AbortSignal.timeout(timeout),
		};

		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const response = await fetch(`${daemonUrl}${path}`, init);
		if (!response.ok) {
			console.warn(`[signet-oh-my-pi] ${method} ${path} failed: ${response.status}`);
			return { ok: false, reason: "http", status: response.status };
		}

		try {
			const data = (await response.json()) as T;
			return { ok: true, data };
		} catch {
			console.warn(`[signet-oh-my-pi] ${method} ${path} returned invalid JSON`);
			return { ok: false, reason: "invalid-json", status: response.status };
		}
	} catch (error) {
		if (isTimeoutError(error)) {
			console.warn(`[signet-oh-my-pi] ${method} ${path} timed out after ${timeout}ms`);
			return { ok: false, reason: "timeout" };
		}

		console.warn(`[signet-oh-my-pi] ${method} ${path} error:`, error);
		return { ok: false, reason: "offline" };
	}
}

export interface DaemonClient {
	post<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	postResult<T>(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<T>>;
}

export function createDaemonClient(daemonUrl: string): DaemonClient {
	return {
		post<T>(path: string, body: unknown, timeout = READ_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, {
				method: "POST",
				body,
				timeout,
			});
		},
		postResult<T>(path: string, body: unknown, timeout = READ_TIMEOUT): Promise<DaemonFetchResult<T>> {
			return daemonFetchResult<T>(daemonUrl, path, {
				method: "POST",
				body,
				timeout,
			});
		},
	};
}

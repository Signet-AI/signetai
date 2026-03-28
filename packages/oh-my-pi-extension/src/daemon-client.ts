import { READ_TIMEOUT, RUNTIME_PATH } from "./types.js";

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
			return null;
		}

		return (await response.json()) as T;
	} catch (error) {
		if (isTimeoutError(error)) {
			console.warn(`[signet-oh-my-pi] ${method} ${path} timed out after ${timeout}ms`);
			return null;
		}

		console.warn(`[signet-oh-my-pi] ${method} ${path} error:`, error);
		return null;
	}
}

export interface DaemonClient {
	post<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
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
	};
}

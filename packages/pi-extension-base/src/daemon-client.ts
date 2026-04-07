export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
	  };

export interface DaemonClientConfig {
	readonly logPrefix: string;
	readonly actorName: string;
	readonly runtimePath: string;
	readonly defaultTimeout: number;
}

function buildHeaders(config: DaemonClientConfig): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-signet-runtime-path": config.runtimePath,
		"x-signet-actor": config.actorName,
		"x-signet-actor-type": "harness",
	};
}

function isTimeoutError(error: unknown): error is DOMException {
	return error instanceof DOMException && error.name === "TimeoutError";
}

async function daemonFetchResult<T>(
	daemonUrl: string,
	path: string,
	config: DaemonClientConfig,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<DaemonFetchResult<T>> {
	const { method = "POST", body, timeout = config.defaultTimeout } = options;

	try {
		const init: RequestInit = {
			method,
			headers: buildHeaders(config),
			signal: AbortSignal.timeout(timeout),
		};

		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const response = await fetch(`${daemonUrl}${path}`, init);
		if (!response.ok) {
			console.warn(`[${config.logPrefix}] ${method} ${path} failed: ${response.status}`);
			return { ok: false, reason: "http", status: response.status };
		}

		try {
			const data = (await response.json()) as T;
			return { ok: true, data };
		} catch {
			console.warn(`[${config.logPrefix}] ${method} ${path} returned invalid JSON`);
			return { ok: false, reason: "invalid-json", status: response.status };
		}
	} catch (error) {
		if (isTimeoutError(error)) {
			console.warn(`[${config.logPrefix}] ${method} ${path} timed out after ${timeout}ms`);
			return { ok: false, reason: "timeout" };
		}

		console.warn(`[${config.logPrefix}] ${method} ${path} error:`, error);
		return { ok: false, reason: "offline" };
	}
}

export interface DaemonClient {
	post<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	postResult<T>(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<T>>;
}

export function createDaemonClient(daemonUrl: string, config: DaemonClientConfig): DaemonClient {
	return {
		async post<T>(path: string, body: unknown, timeout = config.defaultTimeout): Promise<T | null> {
			const result = await daemonFetchResult<T>(daemonUrl, path, config, {
				method: "POST",
				body,
				timeout,
			});
			if (!result.ok) return null;
			return result.data;
		},
		postResult<T>(path: string, body: unknown, timeout = config.defaultTimeout): Promise<DaemonFetchResult<T>> {
			return daemonFetchResult<T>(daemonUrl, path, config, {
				method: "POST",
				body,
				timeout,
			});
		},
	};
}

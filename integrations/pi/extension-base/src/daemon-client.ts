import { SignetApiError, SignetUnauthorizedError, SignetTimeoutError, SignetResponseError } from "@signet/sdk";
import { resolveTarget, NodeTransport } from "@signet/sdk/node";

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json" | "body-read";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
			readonly detail?: string;
	  };

export interface DaemonClientConfig {
	readonly logPrefix: string;
	readonly actorName: string;
	readonly runtimePath: string;
	readonly defaultTimeout: number;
	readonly logFailures?: boolean;
}

async function daemonFetchResult<T>(
	transport: () => Promise<NodeTransport>,
	path: string,
	config: DaemonClientConfig,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
		readonly parseJson?: boolean;
		readonly signal?: AbortSignal;
	} = {},
): Promise<DaemonFetchResult<T>> {
	try {
		const data = await (await transport()).request<T>(options.method ?? "POST", path, {
			body: options.body,
			timeoutMs: options.timeout ?? config.defaultTimeout,
			signal: options.signal,
		});
		if (options.parseJson !== false && (data === undefined || typeof data === "string")) {
			if (config.logFailures !== false)
				console.warn(
					`[${config.logPrefix}] ${path} returned invalid JSON (${typeof data === "string" ? `${data.length} chars` : "0 chars, empty body"})`,
				);
			return { ok: false, reason: "invalid-json", status: 200 };
		}
		return { ok: true, data };
	} catch (error) {
		if (error instanceof SignetUnauthorizedError) console.warn("Signet session expired, run `signet login`");
		else if (error instanceof SignetTimeoutError && config.logFailures !== false)
			console.warn(
				`[${config.logPrefix}] ${options.method ?? "POST"} ${path} timed out after ${options.timeout ?? config.defaultTimeout}ms`,
			);
		if (error instanceof SignetApiError) {
			const detail =
				typeof error.body === "object" &&
				error.body !== null &&
				"error" in error.body &&
				typeof error.body.error === "string"
					? error.body.error.slice(0, 300)
					: undefined;
			return { ok: false, reason: "http", status: error.status, ...(detail ? { detail } : {}) };
		}
		return {
			ok: false,
			reason:
				error instanceof SignetTimeoutError
					? "timeout"
					: error instanceof SignetResponseError
						? "body-read"
						: "offline",
		};
	}
}

export interface DaemonClient {
	post<T>(path: string, body: unknown, timeout?: number, signal?: AbortSignal): Promise<T | null>;
	postResult<T>(path: string, body: unknown, timeout?: number, signal?: AbortSignal): Promise<DaemonFetchResult<T>>;
}

export interface DaemonStatusClient extends DaemonClient {
	postStatus(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<void>>;
}

export interface DaemonRequestClient {
	getStatus(path: string, timeout?: number, signal?: AbortSignal): Promise<DaemonFetchResult<void>>;
	getResult<T>(path: string, timeout?: number, signal?: AbortSignal): Promise<DaemonFetchResult<T>>;
	patchResult<T>(path: string, body: unknown, timeout?: number, signal?: AbortSignal): Promise<DaemonFetchResult<T>>;
}

export function createDaemonClient(
	daemonUrl: string,
	config: DaemonClientConfig,
): DaemonStatusClient & DaemonRequestClient {
	const env = { ...process.env };
	let pending: Promise<NodeTransport> | undefined;
	const transport = () => {
		pending ??= resolveTarget({
			harness: config.actorName.startsWith("oh-my-pi") ? "oh-my-pi" : "pi",
			configUrl: daemonUrl,
			env,
		}).then(
			(target) =>
				new NodeTransport(target, {
					env,
					headers: { "x-signet-runtime-path": config.runtimePath },
					deliveryPaths: ["/api/hooks/stop"],
				}),
		);
		return pending;
	};
	return {
		async getStatus(
			path: string,
			timeout = config.defaultTimeout,
			signal?: AbortSignal,
		): Promise<DaemonFetchResult<void>> {
			const result = await daemonFetchResult<unknown>(transport, path, config, {
				method: "GET",
				timeout,
				signal,
				parseJson: false,
			});
			return result.ok ? { ok: true, data: undefined } : result;
		},
		getResult<T>(path: string, timeout = config.defaultTimeout, signal?: AbortSignal): Promise<DaemonFetchResult<T>> {
			return daemonFetchResult<T>(transport, path, config, { method: "GET", timeout, signal });
		},
		patchResult<T>(
			path: string,
			body: unknown,
			timeout = config.defaultTimeout,
			signal?: AbortSignal,
		): Promise<DaemonFetchResult<T>> {
			return daemonFetchResult<T>(transport, path, config, { method: "PATCH", body, timeout, signal });
		},
		async post<T>(
			path: string,
			body: unknown,
			timeout = config.defaultTimeout,
			signal?: AbortSignal,
		): Promise<T | null> {
			const result = await daemonFetchResult<T>(transport, path, config, {
				method: "POST",
				body,
				timeout,
				signal,
			});
			if (!result.ok) return null;
			return result.data;
		},
		postResult<T>(
			path: string,
			body: unknown,
			timeout = config.defaultTimeout,
			signal?: AbortSignal,
		): Promise<DaemonFetchResult<T>> {
			return daemonFetchResult<T>(transport, path, config, {
				method: "POST",
				body,
				timeout,
				signal,
			});
		},
		postStatus(path: string, body: unknown, timeout = config.defaultTimeout): Promise<DaemonFetchResult<void>> {
			return daemonFetchResult<void>(transport, path, config, {
				method: "POST",
				body,
				timeout,
				parseJson: false,
			});
		},
	};
}

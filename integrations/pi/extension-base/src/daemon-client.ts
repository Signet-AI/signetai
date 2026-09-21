import { readTrimmedRuntimeEnv } from "./helpers.js";

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json" | "body-read";

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
	/** Whether request failures should be written to the host console. */
	readonly logFailures?: boolean;
}

function readAuthToken(): string | undefined {
	return readTrimmedRuntimeEnv("SIGNET_API_KEY") ?? readTrimmedRuntimeEnv("SIGNET_TOKEN");
}

function buildHeaders(config: DaemonClientConfig): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-signet-runtime-path": config.runtimePath,
		"x-signet-actor": config.actorName,
		"x-signet-actor-type": "harness",
	};
	const token = readAuthToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

function errorName(err: unknown): string {
	if (typeof err !== "object" || err === null) return "";
	const name = Reflect.get(err, "name");
	return typeof name === "string" ? name : "";
}

function isTimeoutError(err: unknown): boolean {
	const name = errorName(err);
	if (name === "AbortError" || name === "TimeoutError") return true;
	const code = typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
	return code === "ABORT_ERR";
}

function logWarning(config: DaemonClientConfig, message: string): void {
	if (config.logFailures === false) return;
	console.warn(message);
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Response cleanup is best-effort after the status is already known.
	}
}

async function daemonFetchResult<T>(
	daemonUrl: string,
	path: string,
	config: DaemonClientConfig,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
		readonly parseJson?: boolean;
	} = {},
): Promise<DaemonFetchResult<T>> {
	const { method = "POST", body, timeout = config.defaultTimeout, parseJson = true } = options;

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
			await cancelResponseBody(response);
			logWarning(config, `[${config.logPrefix}] ${method} ${path} failed: ${response.status}`);
			return { ok: false, reason: "http", status: response.status };
		}

		if (!parseJson) {
			await cancelResponseBody(response);
			return { ok: true, data: undefined as T };
		}

		try {
			const text = await response.text();
			try {
				const data = JSON.parse(text) as T;
				return { ok: true, data };
			} catch {
				logWarning(
					config,
					`[${config.logPrefix}] ${method} ${path} returned invalid JSON (${text.length} chars${text.length === 0 ? ", empty body" : ""})`,
				);
				return { ok: false, reason: "invalid-json", status: response.status };
			}
		} catch (e) {
			// Body read failed — typically a timeout firing after headers arrived
			if (isTimeoutError(e)) {
				logWarning(config, `[${config.logPrefix}] ${method} ${path} body read timed out after ${timeout}ms`);
				return { ok: false, reason: "timeout" };
			}
			logWarning(
				config,
				`[${config.logPrefix}] ${method} ${path} body read failed: ${errorName(e) || "unknown error"}`,
			);
			return { ok: false, reason: "body-read" };
		}
	} catch (error) {
		if (isTimeoutError(error)) {
			logWarning(config, `[${config.logPrefix}] ${method} ${path} timed out after ${timeout}ms`);
			return { ok: false, reason: "timeout" };
		}

		logWarning(config, `[${config.logPrefix}] ${method} ${path} error: ${errorName(error) || "request failed"}`);
		return { ok: false, reason: "offline" };
	}
}

export interface DaemonClient {
	post<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	postResult<T>(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<T>>;
}

export interface DaemonStatusClient extends DaemonClient {
	postStatus(path: string, body: unknown, timeout?: number): Promise<DaemonFetchResult<void>>;
}

export function createDaemonClient(daemonUrl: string, config: DaemonClientConfig): DaemonStatusClient {
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
		postStatus(path: string, body: unknown, timeout = config.defaultTimeout): Promise<DaemonFetchResult<void>> {
			return daemonFetchResult<void>(daemonUrl, path, config, {
				method: "POST",
				body,
				timeout,
				parseJson: false,
			});
		},
	};
}

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json" | "body-read";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly reason: DaemonFetchFailure; readonly status?: number };

export interface DaemonFetchConfig {
	readonly headers: () => RequestInit["headers"];
	readonly logPrefix: string;
	readonly logFailures?: boolean;
	readonly defaultTimeout?: number;
	readonly onOffline?: (
		error: unknown,
		request: { readonly daemonUrl: string; readonly method: string; readonly path: string },
	) => void;
}

export interface DaemonFetchOptions {
	readonly method?: string;
	readonly body?: unknown;
	readonly timeout?: number;
	readonly parseJson?: boolean;
}

export function createDaemonIdentityHeaders(actor: string, runtimePath: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-signet-runtime-path": runtimePath,
		"x-signet-actor": actor,
		"x-signet-actor-type": "harness",
	};
}

export function createDaemonPluginHeaders(
	actor: string,
	runtimePath: string,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const headers = createDaemonIdentityHeaders(actor, runtimePath);
	const token = readNonEmptyEnv(environment.SIGNET_API_KEY) ?? readNonEmptyEnv(environment.SIGNET_TOKEN);
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

export function createDaemonFetcher(config: DaemonFetchConfig) {
	return async function daemonFetchResult<T>(
		daemonUrl: string,
		path: string,
		options: DaemonFetchOptions = {},
	): Promise<DaemonFetchResult<T>> {
		const { method = "GET", body, timeout = config.defaultTimeout ?? 10_000, parseJson = true } = options;
		const warn = (message: string, detail?: unknown): void => {
			if (config.logFailures === false) return;
			if (detail === undefined) console.warn(`[${config.logPrefix}] ${message}`);
			else console.warn(`[${config.logPrefix}] ${message}`, detail);
		};

		try {
			const response = await fetch(`${daemonUrl}${path}`, {
				method,
				headers: config.headers(),
				signal: AbortSignal.timeout(timeout),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!response.ok) {
				await cancelResponseBody(response);
				warn(`${method} ${path} failed:`, response.status);
				return { ok: false, reason: "http", status: response.status };
			}
			if (!parseJson) {
				await cancelResponseBody(response);
				return { ok: true, data: undefined as T };
			}

			try {
				const text = await response.text();
				try {
					return { ok: true, data: JSON.parse(text) as T };
				} catch {
					warn(
						`${method} ${path} returned invalid JSON (${text.length} chars${text.length === 0 ? ", empty body" : ""})`,
					);
					return { ok: false, reason: "invalid-json", status: response.status };
				}
			} catch (error) {
				await cancelResponseBody(response);
				if (isTimeoutError(error)) {
					warn(`${method} ${path} body read timed out after ${timeout}ms`);
					return { ok: false, reason: "timeout" };
				}
				warn(`${method} ${path} body read failed:`, errorName(error) || error);
				return { ok: false, reason: "body-read" };
			}
		} catch (error) {
			if (isTimeoutError(error)) {
				warn(`${method} ${path} timed out after ${timeout}ms`);
				return { ok: false, reason: "timeout" };
			}
			if (config.onOffline) config.onOffline(error, { daemonUrl, method, path });
			else warn(`${method} ${path} error:`, error);
			return { ok: false, reason: "offline" };
		}
	};
}

function readNonEmptyEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {}
}

function errorName(error: unknown): string {
	if (typeof error !== "object" || error === null) return "";
	const name = Reflect.get(error, "name");
	return typeof name === "string" ? name : "";
}

function isTimeoutError(error: unknown): boolean {
	const name = errorName(error);
	if (name === "AbortError" || name === "TimeoutError") return true;
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ABORT_ERR";
}

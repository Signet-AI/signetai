import {
	SignetError,
	SignetCredentialError,
	apiError,
	SignetApiError,
	SignetNetworkError,
	SignetTimeoutError,
} from "./errors.js";

export type CredentialProvider = () => Promise<string | null>;
export type Query = Readonly<Record<string, string | number | boolean | undefined>>;
export interface RequestControl {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly deadline?: number;
	readonly headers?: Readonly<Record<string, string>>;
}
export interface RequestOptions extends RequestControl {
	readonly body?: unknown;
	readonly query?: Query;
}
export interface TransportConfig {
	readonly baseUrl: string;
	readonly timeoutMs?: number;
	readonly retries?: number;
	readonly retryDelayMs?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly credentialProvider?: CredentialProvider;
	readonly cookieAuth?: boolean;
}

export function validateBaseUrl(raw: string): string {
	const url = new URL(raw);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new TypeError("baseUrl must be an http(s) URL without credentials, query or fragment");
	return url.toString().replace(/\/+$/, "");
}

export function requestSignal(
	control: RequestControl,
	defaultTimeoutMs = 10_000,
): { signal: AbortSignal; timeoutMs: number; cleanup(): void } {
	if (control.deadline !== undefined && !Number.isFinite(control.deadline))
		throw new RangeError("deadline must be finite");
	const requestedTimeout = control.timeoutMs ?? defaultTimeoutMs;
	if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0 || requestedTimeout > 2_147_483_647)
		throw new RangeError("timeoutMs must be within the timer range");
	const timeoutMs = Math.min(
		requestedTimeout,
		control.deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, control.deadline - Date.now()),
	);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
		throw new RangeError("timeoutMs must be within the timer range");
	const controller = new AbortController();
	const abort = () => controller.abort(control.signal?.reason);
	control.signal?.addEventListener("abort", abort, { once: true });
	if (control.signal?.aborted) abort();
	const expire = () => controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
	if (timeoutMs === 0) expire();
	const timer = setTimeout(expire, timeoutMs);
	return {
		signal: controller.signal,
		timeoutMs,
		cleanup() {
			clearTimeout(timer);
			control.signal?.removeEventListener("abort", abort);
		},
	};
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}

export class SignetTransport {
	private readonly baseUrl: string;
	private readonly retries: number;
	private readonly retryDelayMs: number;
	constructor(private readonly config: TransportConfig) {
		this.retries = config.retries ?? 2;
		this.retryDelayMs = config.retryDelayMs ?? 500;
		if (!Number.isSafeInteger(this.retries) || this.retries < 0 || this.retries > 2)
			throw new RangeError("retries must be between 0 and 2");
		if (
			!Number.isFinite(config.timeoutMs ?? 10_000) ||
			(config.timeoutMs ?? 10_000) < 0 ||
			(config.timeoutMs ?? 10_000) > 2_147_483_647
		)
			throw new RangeError("timeoutMs must be within the timer range");
		if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs * 4 > 2_147_483_647)
			throw new RangeError("retryDelayMs exceeds timer range");
		this.baseUrl = validateBaseUrl(config.baseUrl);
	}

	private async credential(signal: AbortSignal): Promise<string | null> {
		try {
			const token = this.config.credentialProvider ? await abortable(this.config.credentialProvider(), signal) : null;
			if (token !== null && (typeof token !== "string" || token.length > 65536 || /[^\x21-\x7e]/.test(token)))
				throw new SignetCredentialError(new Error("Credential provider returned an invalid bearer credential"));
			return token;
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof SignetError) throw error;
			throw new SignetCredentialError(error);
		}
	}
	async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path))
			throw new TypeError("Request path must be daemon-relative");
		const url = new URL(`${this.baseUrl}${path}`);
		if (url.origin !== new URL(this.baseUrl).origin) throw new TypeError("Request cannot change daemon origin");
		for (const [key, value] of Object.entries(opts.query ?? {}))
			if (value !== undefined) url.searchParams.set(key, String(value));
		const headers = new Headers(this.config.headers);
		for (const [key, value] of Object.entries(opts.headers ?? {})) headers.set(key, value);
		headers.delete("x-signet-actor");
		headers.delete("x-signet-actor-type");
		const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
		if (body !== undefined) headers.set("content-type", "application/json");
		method = method.toUpperCase();
		const retryable =
			["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(method) ||
			(method === "POST" && Boolean(headers.get("idempotency-key")));
		const scope = requestSignal(opts, this.config.timeoutMs);
		try {
			for (let attempt = 0; ; attempt++) {
				let fetching = false;
				try {
					if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()), scope.signal);
					scope.signal.throwIfAborted();
					if (this.config.credentialProvider) {
						const token = await this.credential(scope.signal);
						if (token) headers.set("authorization", `Bearer ${token}`);
						else headers.delete("authorization");
					}
					if (this.config.cookieAuth) {
						const csrf =
							typeof document === "undefined"
								? undefined
								: document.cookie
										.split(";")
										.map((v) => v.trim())
										.find((v) => v.startsWith("signet_csrf="))
										?.slice(12);
						if (csrf) headers.set("x-signet-csrf", decodeURIComponent(csrf));
						else headers.delete("x-signet-csrf");
					}
					fetching = true;
					const response = await abortable(
						fetch(url, {
							method,
							headers,
							body,
							signal: scope.signal,
							redirect: "error",
							...(this.config.cookieAuth ? { credentials: "include" } : {}),
						}),
						scope.signal,
					);
					const parsed = await abortable(parseResponseBody(response), scope.signal);
					if (!response.ok) throw apiError(response.status, parsed);
					return parsed;
				} catch (error) {
					if (scope.signal.aborted) throw scope.signal.reason;
					if (!fetching) throw error;
					const transient =
						error instanceof SignetApiError
							? [408, 429, 500, 502, 503, 504].includes(error.status)
							: !(error instanceof SignetError);
					if (!retryable || !transient || attempt >= this.retries) throw error;
				}
			}
		} catch (error) {
			if (error instanceof SignetError) throw error;
			if (error instanceof Error && error.name === "TimeoutError") throw new SignetTimeoutError(scope.timeoutMs);
			throw new SignetNetworkError(
				error instanceof Error ? error.message : "Request failed",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			scope.cleanup();
		}
	}
	get<T>(path: string, query?: Query, control?: RequestControl): Promise<T> {
		return this.request("GET", path, { ...control, query });
	}
	post<T>(path: string, body?: unknown, control?: RequestControl): Promise<T> {
		return this.request("POST", path, { ...control, body });
	}
	patch<T>(path: string, body?: unknown, control?: RequestControl): Promise<T> {
		return this.request("PATCH", path, { ...control, body });
	}
	put<T>(path: string, body?: unknown, control?: RequestControl): Promise<T> {
		return this.request("PUT", path, { ...control, body });
	}
	del<T>(path: string, query?: Query, control?: RequestControl): Promise<T> {
		return this.request("DELETE", path, { ...control, query });
	}
}

async function parseResponseBody(response: Response) {
	if (response.status === 204 || response.status === 205) return undefined;
	const text = await response.text();
	if (!text) return undefined;
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json") || contentType.includes("+json")) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

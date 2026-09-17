import { resolveSignetDaemonUrl } from "@signet/core";
import { SignetApiError, SignetNetworkError, SignetTimeoutError } from "./errors.js";

export interface TransportConfig {
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly retries: number;
	readonly retryDelayMs: number;
	readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_CONFIG: TransportConfig = {
	baseUrl: resolveSignetDaemonUrl({ env: {} }),
	timeoutMs: 10_000,
	retries: 2,
	retryDelayMs: 500,
};

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_RETRIES = 10;
const MAX_TIMER_MS = 2_147_483_647;

interface RequestOptions {
	readonly body?: unknown;
	readonly query?: Record<string, string | number | boolean | undefined>;
	readonly signal?: AbortSignal;
}

export class SignetTransport {
	private readonly config: TransportConfig;

	constructor(config?: Partial<TransportConfig>) {
		const resolved: TransportConfig = {
			baseUrl: config?.baseUrl ?? DEFAULT_CONFIG.baseUrl,
			timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
			retries: config?.retries ?? DEFAULT_CONFIG.retries,
			retryDelayMs: config?.retryDelayMs ?? DEFAULT_CONFIG.retryDelayMs,
			headers: config?.headers ?? DEFAULT_CONFIG.headers,
		};
		validateConfig(resolved);
		this.config = resolved;
	}

	async request<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
		const url = this.buildUrl(path, opts?.query);
		const headers: Record<string, string> = {
			...this.config.headers,
		};

		if (opts?.body !== undefined) {
			headers["Content-Type"] = "application/json";
		}

		const canRetry = IDEMPOTENT_METHODS.has(method.toUpperCase());
		const maxAttempts = canRetry ? this.config.retries + 1 : 1;

		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				if (attempt > 0) {
					await sleep(this.config.retryDelayMs * attempt, opts?.signal);
				}

				const response = await fetch(url, {
					method,
					headers,
					body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
					signal: buildRequestSignal(opts?.signal, this.config.timeoutMs),
				});

				if (!response.ok) {
					const body = await parseResponseBody(response);
					throw new SignetApiError(response.status, body);
				}

				return await parseResponseBody<T>(response);
			} catch (error) {
				if (error instanceof SignetApiError) {
					// API errors are not retryable
					throw error;
				}

				const networkError = toNetworkError(error, this.config.timeoutMs);
				if (opts?.signal?.aborted) {
					throw networkError;
				}
				lastError = networkError;
			}
		}

		throw lastError ?? new SignetNetworkError("Request failed without an error", new Error("request failed"));
	}

	async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
		return this.request<T>("GET", path, { query });
	}

	async post<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("POST", path, { body });
	}

	async patch<T>(path: string, body?: unknown): Promise<T> {
		return this.request<T>("PATCH", path, { body });
	}

	async del<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
		return this.request<T>("DELETE", path, { query });
	}

	private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
		const base = trimTrailingSlashes(this.config.baseUrl);
		const url = new URL(`${base}${path}`);

		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined) {
					url.searchParams.set(key, String(value));
				}
			}
		}

		return url.toString();
	}
}

function validateConfig(config: TransportConfig): void {
	if (!Number.isSafeInteger(config.retries) || config.retries < 0 || config.retries > MAX_RETRIES) {
		throw new RangeError(`retries must be between 0 and ${MAX_RETRIES}`);
	}
	if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 0 || config.timeoutMs > MAX_TIMER_MS) {
		throw new RangeError(`timeoutMs must be between 0 and ${MAX_TIMER_MS}`);
	}
	if (
		!Number.isFinite(config.retryDelayMs) ||
		config.retryDelayMs < 0 ||
		config.retryDelayMs > MAX_TIMER_MS ||
		config.retryDelayMs * config.retries > MAX_TIMER_MS
	) {
		throw new RangeError(`retryDelayMs must keep the maximum backoff within ${MAX_TIMER_MS}ms`);
	}
}

function buildRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeout;
	return AbortSignal.any([signal, timeout]);
}

function toNetworkError(error: unknown, timeoutMs: number): Error {
	if (error instanceof DOMException && error.name === "TimeoutError") {
		return new SignetTimeoutError(timeoutMs);
	}
	if (error instanceof Error) {
		return new SignetNetworkError(error.message, error);
	}
	return new SignetNetworkError("Unknown network error", new Error(String(error)));
}

function trimTrailingSlashes(s: string): string {
	let end = s.length;
	while (end > 0 && s[end - 1] === "/") {
		end--;
	}
	return s.slice(0, end);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	}

	return new Promise((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const normalized = contentType.toLowerCase();
	return normalized.includes("application/json") || normalized.includes("+json");
}

async function parseResponseBody<T = unknown>(response: Response): Promise<T> {
	if (response.status === 204 || response.status === 205) {
		return undefined as T;
	}

	const text = await response.text();
	if (text.length === 0) {
		return undefined as T;
	}

	if (isJsonContentType(response.headers.get("content-type"))) {
		try {
			return JSON.parse(text) as T;
		} catch {
			// Some endpoints mislabel text as JSON; return raw to avoid masking payloads.
			return text as T;
		}
	}

	return text as T;
}

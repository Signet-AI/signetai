/**
 * Daemon HTTP client for the Signet OpenCode plugin.
 *
 * Mirrors the pattern from integrations/openclaw/memory-adapter/src/index.ts,
 * routing all requests through the "plugin" runtime path so the
 * daemon's session tracker can enforce dedup safety.
 */

import { READ_TIMEOUT, RUNTIME_PATH, WRITE_TIMEOUT } from "./types.js";

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json" | "body-read";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
	  };

// ============================================================================
// Headers
// ============================================================================

function readRuntimeEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readAuthToken(): string | undefined {
	return readRuntimeEnv("SIGNET_API_KEY") ?? readRuntimeEnv("SIGNET_TOKEN");
}

function pluginHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"x-signet-runtime-path": RUNTIME_PATH,
		"x-signet-actor": "opencode-plugin",
		"x-signet-actor-type": "harness",
	};
	const token = readAuthToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

// ============================================================================
// Core fetch helper
// ============================================================================

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

async function daemonFetchResult<T>(
	daemonUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<DaemonFetchResult<T>> {
	const { method = "GET", body, timeout = READ_TIMEOUT } = options;

	try {
		const init: RequestInit = {
			method,
			headers: pluginHeaders(),
			signal: AbortSignal.timeout(timeout),
		};

		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const res = await fetch(`${daemonUrl}${path}`, init);

		if (!res.ok) {
			console.warn(`[signet] ${method} ${path} failed:`, res.status);
			return { ok: false, reason: "http", status: res.status };
		}

		try {
			const text = await res.text();
			try {
				const data = JSON.parse(text) as T;
				return { ok: true, data };
			} catch {
				console.warn(
					`[signet] ${method} ${path} returned invalid JSON (${text.length} chars${text.length === 0 ? ", empty body" : ""})`,
				);
				return { ok: false, reason: "invalid-json", status: res.status };
			}
		} catch (e) {
			// Body read failed — typically a timeout firing after headers arrived
			if (isTimeoutError(e)) {
				console.warn(`[signet] ${method} ${path} body read timed out after ${timeout}ms`);
				return { ok: false, reason: "timeout" };
			}
			console.warn(`[signet] ${method} ${path} body read failed:`, errorName(e) || e);
			return { ok: false, reason: "body-read" };
		}
	} catch (e) {
		if (isTimeoutError(e)) {
			console.warn(`[signet] ${method} ${path} timed out after ${timeout}ms`);
			return { ok: false, reason: "timeout" };
		}
		console.warn(`[signet] ${method} ${path} error:`, e);
		return { ok: false, reason: "offline" };
	}
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
	const res = await daemonFetchResult<T>(daemonUrl, path, options);
	if (!res.ok) return null;
	return res.data;
}

// ============================================================================
// Health check
// ============================================================================

export async function isDaemonRunning(daemonUrl: string): Promise<boolean> {
	try {
		const res = await fetch(`${daemonUrl}/health`, {
			headers: pluginHeaders(),
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ============================================================================
// Client factory
// ============================================================================

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
			return daemonFetch<T>(daemonUrl, path, {
				method: "POST",
				body,
				timeout,
			});
		},

		postResult<T>(path: string, body: unknown, timeout = WRITE_TIMEOUT): Promise<DaemonFetchResult<T>> {
			return daemonFetchResult<T>(daemonUrl, path, {
				method: "POST",
				body,
				timeout,
			});
		},

		patch<T>(path: string, body: unknown, timeout = WRITE_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, {
				method: "PATCH",
				body,
				timeout,
			});
		},

		del<T>(path: string, timeout = WRITE_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, {
				method: "DELETE",
				timeout,
			});
		},
	};
}

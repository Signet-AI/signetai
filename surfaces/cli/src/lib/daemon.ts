import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOPBACK_HOST, parseSimpleYaml, resolveSignetDaemonUrl } from "@signet/core";
import chalk from "chalk";

export type DaemonFetch = <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
			/** Daemon-provided error message, when the HTTP error body carries one. */
			readonly error?: string;
			/** Parsed daemon error payload for callers that need structured retry data. */
			readonly body?: unknown;
	  };

export type DaemonStreamResult =
	| { readonly ok: true; readonly response: Response }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
			readonly error?: string;
			readonly body?: unknown;
	  };

export type DaemonApiCall = (
	method: string,
	path: string,
	body?: unknown,
	timeoutMs?: number,
) => Promise<{ readonly ok: boolean; readonly data: unknown }>;

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

/** Preserve a daemon error payload while exposing its concise message to ordinary CLI callers. */
async function readHttpErrorBody(res: Response): Promise<{ readonly error?: string; readonly body?: unknown }> {
	const text = await res.text().catch(() => "");
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text) as { error?: unknown };
		const error = typeof parsed?.error === "string" && parsed.error.trim() ? parsed.error : undefined;
		return { ...(error ? { error } : {}), body: parsed };
	} catch {
		return {};
	}
}

function readAuthToken(): string | undefined {
	const apiKey = process.env.SIGNET_API_KEY?.trim();
	if (apiKey) return apiKey;
	const legacyToken = process.env.SIGNET_TOKEN?.trim();
	return legacyToken || undefined;
}

function withAuthHeaders(headers?: HeadersInit): Headers {
	const merged = new Headers(headers);
	const token = readAuthToken();
	if (token && !merged.has("Authorization")) {
		merged.set("Authorization", `Bearer ${token}`);
	}
	return merged;
}

function createStreamAbortSignal(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { readonly signal: AbortSignal | undefined; readonly cleanup: () => void } {
	if (!callerSignal && !(timeoutMs && timeoutMs > 0)) return { signal: undefined, cleanup: () => {} };
	if (!timeoutMs || timeoutMs <= 0) return { signal: callerSignal, cleanup: () => {} };

	const controller = new AbortController();
	const abortFromCaller = () => controller.abort(callerSignal?.reason);
	if (callerSignal?.aborted) abortFromCaller();
	else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", abortFromCaller);
		},
	};
}

export function createDaemonClient(
	port: number,
	agentsDir?: string,
): {
	readonly url: string;
	/** Whether this client addresses the selected local workspace. */
	readonly localWorkspace: boolean;
	readonly fetchFromDaemon: DaemonFetch;
	readonly fetchDaemonResult: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<DaemonFetchResult<T>>;
	readonly fetchDaemonStream: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>;
	/** Raw request transport for streaming uploads; never serializes the body. */
	readonly fetchDaemonRaw: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>;
	readonly secretApiCall: DaemonApiCall;
} {
	const configUrl = agentsDir ? readDaemonUrlConfig(agentsDir) : undefined;
	const url = resolveSignetDaemonUrl({ defaultHost: LOOPBACK_HOST, defaultPort: port, configUrl });
	const localWorkspace =
		!configUrl &&
		!process.env.SIGNET_DAEMON_URL?.trim() &&
		["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

	const fetchDaemonResult = async <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	): Promise<DaemonFetchResult<T>> => {
		const { timeout, ...fetchOpts } = opts || {};
		try {
			const res = await fetch(`${url}${path}`, {
				...fetchOpts,
				headers: withAuthHeaders(fetchOpts.headers),
				signal: AbortSignal.timeout(timeout || 5_000),
			});
			if (!res.ok) {
				// Surface the daemon's own error message (e.g. "A dreaming pass
				// is already running", "No routing policy is configured.") so
				// callers can name the real cause instead of a generic
				// connectivity failure (#1074).
				const response = await readHttpErrorBody(res);
				return { ok: false, reason: "http", status: res.status, ...response };
			}
			try {
				const data: T = await res.json();
				return { ok: true, data };
			} catch {
				return { ok: false, reason: "invalid-json", status: res.status };
			}
		} catch (err) {
			if (isTimeoutError(err)) {
				return { ok: false, reason: "timeout" };
			}
			return { ok: false, reason: "offline" };
		}
	};

	const fetchDaemonStream = async (
		path: string,
		opts?: RequestInit & { timeout?: number },
	): Promise<DaemonStreamResult> => {
		const { timeout, ...fetchOpts } = opts || {};
		// Bound only the initial HTTP handshake. Once headers arrive, the SSE
		// body is intentionally long-lived and is cancelled by the caller's
		// attachment signal instead.
		const streamSignal = createStreamAbortSignal(fetchOpts.signal ?? undefined, timeout ?? 5_000);
		try {
			const res = await fetch(`${url}${path}`, {
				...fetchOpts,
				headers: withAuthHeaders(fetchOpts.headers),
				signal: streamSignal.signal,
			});
			if (!res.ok) {
				const response = await readHttpErrorBody(res);
				return { ok: false, reason: "http", status: res.status, ...response };
			}
			if (!res.body) return { ok: false, reason: "invalid-json", status: res.status };
			return { ok: true, response: res };
		} catch (err) {
			if (isTimeoutError(err)) return { ok: false, reason: "timeout" };
			return { ok: false, reason: "offline" };
		} finally {
			streamSignal.cleanup();
		}
	};

	const fetchFromDaemon: DaemonFetch = async <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	): Promise<T | null> => {
		const res = await fetchDaemonResult<T>(path, opts);
		if (!res.ok) return null;
		return res.data;
	};

	const secretApiCall: DaemonApiCall = async (
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 5_000,
	): Promise<{ readonly ok: boolean; readonly data: unknown }> => {
		try {
			const res = await fetch(`${url}${path}`, {
				method,
				headers: withAuthHeaders(body ? { "Content-Type": "application/json" } : undefined),
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				data = { error: text || "Request failed" };
			}
			return { ok: res.ok, data };
		} catch (err) {
			if (isTimeoutError(err)) {
				return {
					ok: false,
					data: { error: `Request timed out after ${timeoutMs}ms` },
				};
			}
			return {
				ok: false,
				data: { error: "Could not reach Signet daemon" },
			};
		}
	};

	return {
		url,
		localWorkspace,
		fetchFromDaemon,
		fetchDaemonResult,
		fetchDaemonStream,
		fetchDaemonRaw: fetchDaemonStream,
		secretApiCall,
	};
}

/** Read the persisted `daemon.url` from agent.yaml, if any. */
function readDaemonUrlConfig(agentsDir: string): string | undefined {
	const file = join(agentsDir, "agent.yaml");
	if (!existsSync(file)) return undefined;
	try {
		const cfg = parseSimpleYaml(readFileSync(file, "utf-8")) as Record<string, unknown>;
		const daemon = cfg.daemon as Record<string, unknown> | undefined;
		const url = daemon?.url;
		return typeof url === "string" && url.trim() ? url.trim() : undefined;
	} catch {
		return undefined;
	}
}

export async function ensureDaemonRunning(
	check: () => Promise<boolean>,
	msg = "  Daemon is not running. Start it with: signet daemon start",
): Promise<boolean> {
	const running = await check();
	if (running) {
		return true;
	}
	console.error(chalk.red(msg));
	return false;
}

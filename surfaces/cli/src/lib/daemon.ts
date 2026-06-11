import { resolveSignetDaemonUrl } from "@signet/core";
import chalk from "chalk";

export type DaemonFetch = <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
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

export function createDaemonClient(port: number): {
	readonly url: string;
	readonly fetchFromDaemon: DaemonFetch;
	readonly fetchDaemonResult: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<DaemonFetchResult<T>>;
	readonly secretApiCall: DaemonApiCall;
} {
	const url = resolveDaemonClientUrl(port);

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
				return { ok: false, reason: "http", status: res.status };
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
		fetchFromDaemon,
		fetchDaemonResult,
		secretApiCall,
	};
}

function resolveDaemonClientUrl(port: number): string {
	return resolveSignetDaemonUrl({ defaultHost: "localhost", defaultPort: port });
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

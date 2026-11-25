import { READ_TIMEOUT, RUNTIME_PATH, WRITE_TIMEOUT } from "./types.js";
import { SignetApiError, SignetUnauthorizedError, SignetTimeoutError, SignetResponseError } from "@signet/sdk";
import { resolveTarget, NodeTransport } from "@signet/sdk/node";

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json" | "body-read";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
	  };

async function daemonFetchResult<T>(
	daemonUrl: string,
	path: string,
	options: { readonly method?: string; readonly body?: unknown; readonly timeout?: number } = {},
): Promise<DaemonFetchResult<T>> {
	try {
		const transport = new NodeTransport(await resolveTarget({ harness: "opencode", configUrl: daemonUrl }), {
			headers: { "x-signet-runtime-path": RUNTIME_PATH },
			deliveryPaths: ["/api/hooks/stop"],
		});
		const data = await transport.request<T>(options.method ?? "GET", path, {
			body: options.body,
			timeoutMs: options.timeout ?? READ_TIMEOUT,
		});
		if (data === undefined || typeof data === "string") {
			console.warn(
				`[signet] ${path} returned invalid JSON (${typeof data === "string" ? `${data.length} chars` : "0 chars, empty body"})`,
			);
			return { ok: false, reason: "invalid-json", status: 200 };
		}
		return { ok: true, data };
	} catch (error) {
		if (error instanceof SignetUnauthorizedError) console.warn("Signet session expired, run `signet login`");
		if (error instanceof SignetApiError) return { ok: false, reason: "http", status: error.status };
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

export async function isDaemonRunning(daemonUrl: string): Promise<boolean> {
	return (await daemonFetchResult(daemonUrl, "/health", { timeout: 1000 })).ok;
}

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

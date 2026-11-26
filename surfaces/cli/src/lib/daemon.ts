import { existsSync, readFileSync } from "node:fs";
import { atomicPrivateWrite, configDirectory, withFileLock } from "../../../../libs/sdk/src/node/storage.js";
import { formatYaml } from "@signet/core";
import { join } from "node:path";
import { LOOPBACK_HOST, parseSimpleYaml, resolveSignetDaemonUrl } from "@signet/core";
import chalk from "chalk";
import { cliAgent, cliTarget, cliTransport } from "./organization-target.js";
import { apiError, SignetNetworkError, SignetTimeoutError } from "../../../../libs/sdk/src/errors.js";

export type DaemonFetch = <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;

export type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json";

export type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
			readonly error?: string;
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
	if (cliTarget()?.remote === false) return merged;
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
	readonly localWorkspace: boolean;
	readonly hasCredential: boolean;
	readonly fetchFromDaemon: DaemonFetch;
	readonly fetchDaemonResult: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<DaemonFetchResult<T>>;
	readonly fetchDaemonStream: (path: string, opts?: RequestInit & { timeout?: number }) => Promise<DaemonStreamResult>;
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
		const remote = cliTransport();
		if (remote) {
			if (fetchOpts.body !== undefined && typeof fetchOpts.body !== "string")
				throw new Error("This organization operation requires a JSON request body");
			return {
				ok: true,
				data: await remote.request<T>(fetchOpts.method ?? "GET", path, {
					body: typeof fetchOpts.body === "string" ? JSON.parse(fetchOpts.body) : undefined,
					headers: {
						...Object.fromEntries(new Headers(fetchOpts.headers)),
						...(cliAgent() ? { "x-signet-agent-id": cliAgent() } : {}),
					},
					signal: fetchOpts.signal ?? undefined,
					timeoutMs: timeout ?? 5000,
				}),
			};
		}
		try {
			const res = await fetch(`${cliTarget()?.url ?? url}${path}`, {
				...fetchOpts,
				headers: withAuthHeaders(fetchOpts.headers),
				signal: AbortSignal.timeout(timeout || 5_000),
			});
			if (!res.ok) {
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
		const target = cliTarget();
		if (target?.remote) {
			const timeoutMs = timeout ?? 5000;
			const signal = fetchOpts.signal
				? AbortSignal.any([fetchOpts.signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
			const headers = new Headers(fetchOpts.headers);
			const token = await target.credential.get({ signal, timeoutMs });
			if (token) headers.set("authorization", `Bearer ${token}`);
			const agentId = cliAgent();
			if (agentId) headers.set("x-signet-agent-id", agentId);
			let response: Response;
			try {
				response = await fetch(`${target.url}${path}`, { ...fetchOpts, headers, signal });
			} catch (error) {
				if (signal.aborted) throw new SignetTimeoutError(timeoutMs);
				throw new SignetNetworkError(
					"Could not reach the organization instance",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			if (!response.ok) {
				const error = await readHttpErrorBody(response);
				throw apiError(response.status, error.body ?? { error: error.error ?? "Request failed" });
			}
			return { ok: true, response };
		}
		const streamSignal = createStreamAbortSignal(fetchOpts.signal ?? undefined, timeout ?? 5_000);
		try {
			const res = await fetch(`${cliTarget()?.url ?? url}${path}`, {
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
		const remote = cliTransport();
		if (remote) return { ok: true, data: await remote.request(method, path, { body, timeoutMs }) };
		try {
			const res = await fetch(`${cliTarget()?.url ?? url}${path}`, {
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
		get url() {
			return cliTarget()?.url ?? url;
		},
		get localWorkspace() {
			const target = cliTarget();
			return target ? !target.remote : localWorkspace;
		},
		get hasCredential() {
			const target = cliTarget();
			return target ? target.credential.source !== "none" : readAuthToken() !== undefined;
		},
		fetchFromDaemon,
		fetchDaemonResult,
		fetchDaemonStream,
		fetchDaemonRaw: fetchDaemonStream,
		secretApiCall,
	};
}
function clientConfigFile() {
	return join(configDirectory(), "config.yaml");
}
function daemonConfiguration(file: string): Record<string, unknown> {
	const value: unknown = existsSync(file) ? parseSimpleYaml(readFileSync(file, "utf8")) : {};
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid client daemon configuration");
	return Object.fromEntries(Object.entries(value));
}
export async function saveDaemonLoginUrl(url: string): Promise<void> {
	const normalized = resolveSignetDaemonUrl({ env: {}, configUrl: url });
	const file = clientConfigFile();
	await withFileLock(`${file}.lock`, async () => {
		const value = daemonConfiguration(file);
		const daemon = value.daemon ?? {};
		if (typeof daemon !== "object" || daemon === null || Array.isArray(daemon))
			throw new Error("Invalid client daemon configuration");
		await atomicPrivateWrite(file, formatYaml({ ...value, daemon: { ...daemon, url: normalized } }));
	});
}
export function readDaemonUrlConfig(agentsDir: string): string | undefined {
	const file = existsSync(clientConfigFile()) ? clientConfigFile() : join(agentsDir, "agent.yaml");
	const value = daemonConfiguration(file);
	const daemon = value.daemon;
	if (daemon === undefined) return undefined;
	if (typeof daemon !== "object" || daemon === null || Array.isArray(daemon))
		throw new Error("Invalid client daemon configuration");
	const url = "url" in daemon ? daemon.url : undefined;
	if (url === undefined) return undefined;
	if (typeof url !== "string" || !url.trim()) throw new Error("Invalid client daemon URL");
	return resolveSignetDaemonUrl({ env: {}, configUrl: url });
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

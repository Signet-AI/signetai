/**
 * Daemon HTTP client for the Signet OpenCode plugin.
 *
 * Mirrors the pattern from packages/adapters/openclaw/src/index.ts,
 * routing all requests through the "plugin" runtime path so the
 * daemon's session tracker can enforce dedup safety.
 */

import { READ_TIMEOUT, RUNTIME_PATH, WRITE_TIMEOUT } from "./types.js";

// ============================================================================
// Headers
// ============================================================================

function pluginHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-signet-runtime-path": RUNTIME_PATH,
		"x-signet-actor": "opencode-plugin",
		"x-signet-actor-type": "harness",
	};
}

// ============================================================================
// Core fetch helper
// ============================================================================

async function daemonFetch<T>(
	daemonUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<T | null> {
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
			return null;
		}

		return (await res.json()) as T;
	} catch (e) {
		console.warn(`[signet] ${method} ${path} error:`, e);
		return null;
	}
}

// ============================================================================
// Health check
// ============================================================================

export async function isDaemonRunning(daemonUrl: string): Promise<boolean> {
	try {
		const res = await fetch(`${daemonUrl}/health`, {
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
	patch<T>(path: string, body: unknown, timeout?: number): Promise<T | null>;
	del<T>(path: string, timeout?: number): Promise<T | null>;
}

export function createDaemonClient(daemonUrl: string): DaemonClient {
	return {
		get<T>(path: string, timeout = READ_TIMEOUT): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, { timeout });
		},

		post<T>(
			path: string,
			body: unknown,
			timeout = WRITE_TIMEOUT,
		): Promise<T | null> {
			return daemonFetch<T>(daemonUrl, path, {
				method: "POST",
				body,
				timeout,
			});
		},

		patch<T>(
			path: string,
			body: unknown,
			timeout = WRITE_TIMEOUT,
		): Promise<T | null> {
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

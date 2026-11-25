import { captureRemoteSessionEnd } from "@signet/connector-base";
import { SignetApiError, SignetTimeoutError } from "../../../../libs/sdk/src/index.js";
import { ConnectorRegistry, NodeTransport, resolveTarget } from "../../../../libs/sdk/src/node.js";
import type { DaemonFetchResult } from "./daemon.js";

export type HookFetch = (<T>(
	path: string,
	options?: RequestInit & { timeout?: number },
) => Promise<DaemonFetchResult<T>>) & { readonly remote: boolean };
export async function createHookFetch(harness: string): Promise<HookFetch> {
	const target = await resolveTarget({ harness });
	const entry = (await new ConnectorRegistry().read())[harness];
	const transport = new NodeTransport(target, {
		headers: { "x-signet-runtime-path": "legacy", ...(entry?.agentId ? { "x-signet-agent-id": entry.agentId } : {}) },
		deliveryPaths: ["/api/hooks/stop"],
	});
	const fetch = async <T>(
		path: string,
		options?: RequestInit & { timeout?: number },
	): Promise<DaemonFetchResult<T>> => {
		let body: unknown = typeof options?.body === "string" ? JSON.parse(options.body) : undefined;
		if (target.remote && path === "/api/hooks/session-end") body = await captureRemoteSessionEnd(body);
		try {
			const headers = new Headers(options?.headers);
			headers.delete("content-type");
			const data = await transport.request<T>(options?.method ?? "GET", path, {
				body,
				headers: Object.fromEntries(headers),
				timeoutMs: options?.timeout,
				signal: options?.signal ?? undefined,
			});
			return { ok: true, data };
		} catch (error) {
			if (error instanceof SignetApiError)
				return { ok: false, reason: "http", status: error.status, body: error.body, error: error.message };
			return { ok: false, reason: error instanceof SignetTimeoutError ? "timeout" : "offline" };
		}
	};
	return Object.assign(fetch, { remote: target.remote });
}

/**
 * Daemon-driven provider connect for `signet setup` — the CLI counterpart of
 * the dashboard's ConnectProviderController. Talks to the SAME daemon endpoints
 * the dashboard uses, so a provider connected here is identical to one
 * connected in the browser:
 *
 *   - POST /api/secrets/:name            (API-key store)
 *   - POST /api/inference/oauth/login/:id (SSE login stream)
 *   - POST /api/inference/oauth/complete  (answer a login prompt)
 *   - GET  /api/inference/catalog         (live model list)
 *
 * HTTP + UI are injected so the state machine is unit-testable without a live
 * daemon or TTY.
 */
import type { ConnectableProvider } from "./setup-inference-connect.js";
import { oauthSecretName, providerKeySecretName } from "./setup-inference-connect.js";

export interface ConnectHttp {
	/** JSON POST to the daemon; returns { ok, data?, error? }. */
	readonly postJson: (
		path: string,
		body: unknown,
	) => Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: string }>;
	/** JSON GET to the daemon (e.g. the catalog). */
	readonly getJson: (
		path: string,
	) => Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: string }>;
	/** POST that returns the raw SSE body stream for OAuth login. */
	readonly postStream: (path: string, body: unknown) => Promise<ReadableStream<Uint8Array>>;
}

export interface ConnectUi {
	/** Open/Show a URL the user must visit in a browser. */
	readonly openUrl: (url: string) => void;
	/** Print a device code + verification URI (no browser needed). */
	readonly showDeviceCode: (userCode: string, verificationUri: string) => void;
	/** Free-text prompt (manual code / OAuth text prompt). */
	readonly promptText: (message: string) => Promise<string>;
	/** Multiple-choice prompt. */
	readonly promptSelect: (
		message: string,
		options: ReadonlyArray<{ readonly id: string; readonly label: string }>,
	) => Promise<string>;
	readonly onProgress?: (message: string) => void;
	readonly onError?: (message: string) => void;
}

export type ConnectResult =
	| { readonly ok: true; readonly method: "api" | "oauth" }
	| { readonly ok: false; readonly error: string };

/**
 * Connect an API-key provider: store the key under the canonical secret name
 * the router resolves (mirrors the dashboard's putSecret + linkAccountForApiKey).
 */
export async function connectApiKey(http: ConnectHttp, family: string, key: string): Promise<ConnectResult> {
	const name = providerKeySecretName(family);
	const res = await http.postJson(`/api/secrets/${encodeURIComponent(name)}`, { value: key });
	if (!res.ok) {
		// secretApiCall nests the daemon error at res.data.error; fall back to the
		// top-level error field, then a generic message.
		const nested = (res.data as { error?: string } | undefined)?.error;
		return { ok: false, error: res.error ?? nested ?? "Failed to store API key" };
	}
	return { ok: true, method: "api" };
}

interface SseEvent {
	readonly type: string;
	readonly data: Record<string, unknown>;
}

/** Parse one SSE frame (`event: t\ndata: {...}\n\n`) into { type, data }. */
function parseSseFrame(chunk: string): SseEvent | null {
	let type = "message";
	let dataLine = "";
	for (const line of chunk.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("event:")) type = trimmed.slice(6).trim();
		else if (trimmed.startsWith("data:")) dataLine += trimmed.slice(5).trim();
	}
	if (!dataLine) return null;
	try {
		return { type, data: JSON.parse(dataLine) as Record<string, unknown> };
	} catch {
		return null;
	}
}

/**
 * Drive an OAuth login to completion via the daemon's SSE stream. Mirrors the
 * dashboard's ConnectProviderController.runOAuth: opens the auth/device URL,
 * answers prompt/select/manual_code via inquirer-style callbacks, and POSTs
 * each answer to /api/inference/oauth/complete. The daemon stores the
 * resulting credential in the SIGNET_OAUTH_* secret.
 */
export async function connectOAuth(http: ConnectHttp, ui: ConnectUi, providerId: string): Promise<ConnectResult> {
	let stream: ReadableStream<Uint8Array>;
	try {
		stream = await http.postStream(`/api/inference/oauth/login/${encodeURIComponent(providerId)}`, {});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "OAuth login request failed" };
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sessionId: string | undefined;

	// Outstanding prompt the daemon is waiting on; resolved when the UI answers.
	let pending: { readonly responseId: string; readonly kind: "text" | "select" | "manual_code" } | undefined;

	const answer = async (responseId: string, value: string): Promise<void> => {
		await http.postJson("/api/inference/oauth/complete", { sessionId, responseId, value });
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		// Frames are separated by a blank line (\n\n).
		while ((nl = buffer.indexOf("\n\n")) >= 0) {
			const frame = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 2);
			const event = parseSseFrame(frame);
			if (!event) continue;
			const d = event.data;

			if (event.type === "session") sessionId = typeof d.sessionId === "string" ? d.sessionId : sessionId;
			else if (event.type === "auth" && typeof d.url === "string") ui.openUrl(d.url);
			else if (event.type === "device_code" && typeof d.userCode === "string" && typeof d.verificationUri === "string")
				ui.showDeviceCode(d.userCode, d.verificationUri);
			else if (event.type === "progress" && typeof d.message === "string") ui.onProgress?.(d.message);
			else if (event.type === "connected") return { ok: true, method: "oauth" };
			else if (event.type === "error" && typeof d.error === "string") {
				ui.onError?.(d.error);
				return { ok: false, error: d.error };
			} else if (event.type === "prompt" && typeof d.responseId === "string") {
				pending = { responseId: d.responseId, kind: "text" };
				const msg = typeof d.message === "string" ? d.message : "Enter a value";
				const val = await ui.promptText(msg);
				await answer(d.responseId, val);
				pending = undefined;
			} else if (event.type === "select" && typeof d.responseId === "string" && Array.isArray(d.options)) {
				const options = (d.options as ReadonlyArray<Record<string, unknown>>).map((o) => ({
					id: String(o.id),
					label: String(o.label ?? o.id),
				}));
				const chosen = await ui.promptSelect(typeof d.message === "string" ? d.message : "Select an option", options);
				await answer(d.responseId, chosen);
			} else if (event.type === "manual_code" && typeof d.responseId === "string") {
				const val = await ui.promptText("Paste the final redirect URL or authorization code");
				await answer(d.responseId, val);
			}
		}
	}
	return pending
		? { ok: false, error: "OAuth login ended with a pending prompt" }
		: { ok: false, error: "OAuth login ended unexpectedly" };
}

export interface CatalogModel {
	readonly id: string;
	readonly name: string;
}

/** Fetch the live model list for a provider family from the daemon catalog. */
export async function fetchModels(http: ConnectHttp, family: string): Promise<CatalogModel[]> {
	const res = await http.getJson("/api/inference/catalog");
	if (!res.ok || !res.data) return [];
	const models = (res.data as { models?: Record<string, CatalogModel[]> }).models?.[family];
	return Array.isArray(models) ? models : [];
}

/** Whether a provider offers a choice between OAuth and API key. */
export function connectChoice(provider: ConnectableProvider): "oauth" | "key" | "choice" | null {
	if (provider.supportsOAuth && !provider.supportsApiKey) return "oauth";
	if (provider.supportsApiKey && !provider.supportsOAuth) return "key";
	if (provider.supportsOAuth && provider.supportsApiKey) return "choice";
	return null;
}

export { oauthSecretName };

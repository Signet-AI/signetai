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
import { type OAuthCredentials, type OAuthLoginCallbacks, getOAuthProvider } from "@earendil-works/pi-ai/oauth";
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

/** Acquire OAuth credentials via pi-ai's login() — injectable for tests. */
export type OAuthLoginFn = (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;

function defaultLogin(providerId: string): OAuthLoginFn {
	return (callbacks) => {
		const provider = getOAuthProvider(providerId);
		if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
		return provider.login(callbacks);
	};
}

/**
 * Drive an OAuth login to completion using pi-ai's own login() — the same
 * self-contained flow the SDK ships (it spins its own localhost callback
 * server for browser-callback providers and handles device codes for the
 * rest). The dashboard proxies this through the daemon only because a browser
 * can't run node:http; the CLI calls the SDK directly. The resulting
 * credential is stored under the canonical SIGNET_OAUTH_* secret so the
 * daemon resolves it at call time.
 */
export async function connectOAuth(
	http: ConnectHttp,
	ui: ConnectUi,
	providerId: string,
	deps?: { readonly login: OAuthLoginFn },
): Promise<ConnectResult> {
	const login = deps?.login ?? defaultLogin(providerId);

	let credentials: OAuthCredentials;
	try {
		credentials = await login({
			onAuth: (info) => ui.openUrl(info.url),
			onDeviceCode: (info) => ui.showDeviceCode(info.userCode, info.verificationUri),
			onPrompt: async (prompt) => ui.promptText(prompt.message),
			onSelect: async (prompt) =>
				ui.promptSelect(
					prompt.message,
					prompt.options.map((o) => ({ id: o.id, label: o.label })),
				),
			onProgress: (message) => ui.onProgress?.(message),
			onManualCodeInput: async () => ui.promptText("Paste the final redirect URL or authorization code"),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : "OAuth login failed";
		ui.onError?.(msg);
		return { ok: false, error: msg };
	}

	const name = oauthSecretName(providerId);
	const res = await http.postJson(`/api/secrets/${encodeURIComponent(name)}`, {
		value: JSON.stringify(credentials),
	});
	if (!res.ok) {
		const nested = (res.data as { error?: string } | undefined)?.error;
		return { ok: false, error: res.error ?? nested ?? "Failed to store OAuth credentials" };
	}
	return { ok: true, method: "oauth" };
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

export { oauthSecretName };

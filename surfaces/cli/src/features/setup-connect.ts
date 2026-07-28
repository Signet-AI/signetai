/**
 * Provider connect for `signet setup` — runs the OAuth flow via pi-ai's own
 * SDK (self-contained: it spins its own localhost callback server, so no daemon
 * is needed for the login itself) and stores the resulting credential via the
 * daemon secrets API. The dashboard proxies login through the daemon only
 * because a browser can't run node:http; the CLI calls the SDK directly during
 * the wizard, before listing models.
 */
import { type OAuthCredentials, type OAuthLoginCallbacks, getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { oauthSecretName, providerKeySecretName } from "./setup-inference-connect.js";

export interface ConnectHttp {
	/** JSON POST to the daemon secrets store; returns { ok, data?, error? }. */
	readonly postJson: (
		path: string,
		body: unknown,
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

export type ConnectResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

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
 * Run the OAuth login NOW (during the wizard) using pi-ai's self-contained
 * login() — the browser opens / a device code is shown, and the user
 * authenticates. Returns the credential to persist (storage happens later via
 * storeOAuthCredentials, once the daemon is running). Rejects on failure.
 *
 * pi-ai's login races a local callback server against manual input and can
 * emit unhandled rejections from its internal async ops (e.g. a bind or fetch
 * failure on the callback race) that would otherwise kill the process
 * silently. Those are captured here and surfaced as a normal rejection so the
 * wizard can fail gracefully (message + return to menu) instead of quitting.
 */
export async function runOAuthLogin(
	ui: ConnectUi,
	providerId: string,
	deps?: { readonly login: OAuthLoginFn },
): Promise<OAuthCredentials> {
	const login = deps?.login ?? defaultLogin(providerId);
	const callbacks: OAuthLoginCallbacks = {
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
	};
	return new Promise<OAuthCredentials>((resolve, reject) => {
		const cleanup = () => {
			clearInterval(keepalive);
			process.off("unhandledRejection", onUnhandled);
		};
		// Hold the event loop open for the duration of the interactive login. pi-ai's
		// callback server + browser race are async and may not ref the loop (the
		// browser is a detached process), so without this bun can exit cleanly
		// mid-login after the last inquirer prompt resolves.
		const keepalive = setInterval(() => {}, 1000);
		const onUnhandled = (reason: unknown) => {
			cleanup();
			const msg = reason instanceof Error ? reason.message : String(reason);
			ui.onError?.(msg);
			reject(reason instanceof Error ? reason : new Error(msg));
		};
		process.on("unhandledRejection", onUnhandled);
		login(callbacks).then(
			(creds) => {
				cleanup();
				resolve(creds);
			},
			(err) => {
				cleanup();
				reject(err);
			},
		);
	});
}

/** Store an OAuth credential under the canonical SIGNET_OAUTH_* secret (post-start). */
export async function storeOAuthCredentials(
	http: ConnectHttp,
	providerId: string,
	credentials: OAuthCredentials,
): Promise<ConnectResult> {
	const res = await http.postJson(`/api/secrets/${encodeURIComponent(oauthSecretName(providerId))}`, {
		value: JSON.stringify(credentials),
	});
	if (!res.ok) {
		const nested = (res.data as { error?: string } | undefined)?.error;
		return { ok: false, error: res.error ?? nested ?? "Failed to store OAuth credentials" };
	}
	return { ok: true };
}

/** Store an API key under the canonical SIGNET_KEY_* secret (post-start). */
export async function storeApiKey(http: ConnectHttp, family: string, key: string): Promise<ConnectResult> {
	const res = await http.postJson(`/api/secrets/${encodeURIComponent(providerKeySecretName(family))}`, {
		value: key,
	});
	if (!res.ok) {
		const nested = (res.data as { error?: string } | undefined)?.error;
		return { ok: false, error: res.error ?? nested ?? "Failed to store API key" };
	}
	return { ok: true };
}

export { oauthSecretName };

/**
 * Connect-provider controller — the state machine behind ConnectProviderDialog.
 *
 * Two flows share one reducer:
 *   1. OAuth login (Claude Max / ChatGPT Codex / GitHub Copilot) — driven by
 *      the daemon's SSE login stream. Events advance a finite state machine.
 *   2. API-key connect — paste a key, validate, save to the vault, link.
 *
 * States are an exhaustive union so impossible states are unrepresentable
 * (you can't be "connected" and "awaiting prompt" at once). Mirrors the
 * dispatch/Match structure OpenCode's dialog-connect-provider uses, adapted to
 * pi-ai's streaming event model.
 */
import {
	type KeyValidationState,
	type OAuthLoginEvent,
	type OAuthProviderStatus,
	completeOAuthInteraction,
	disconnectOAuthProvider,
	providerKeySecretName,
	putSecret,
	startOAuthLogin,
	validateApiKey,
} from "$lib/api";

export type ConnectPhase =
	| { kind: "method" }
	| { kind: "oauth-running"; url?: string; deviceCode?: { userCode: string; verificationUri: string }; prompt?: PendingPrompt; progress?: string }
	| { kind: "key-entry"; key: string; reveal: boolean; validation: KeyValidationState; testing: boolean }
	| { kind: "saving" }
	| { kind: "connected" }
	| { kind: "error"; message: string };

export interface PendingPrompt {
	readonly responseId: string;
	readonly kind: "text" | "select" | "manual_code";
	readonly message: string;
	readonly placeholder?: string;
	readonly allowEmpty?: boolean;
	readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface ConnectOptions {
	readonly provider: OAuthProviderStatus | { readonly id: string; readonly name: string; readonly connected: boolean };
	readonly supportsOAuth: boolean;
	readonly supportsApiKey: boolean;
	readonly onSaved?: () => void | Promise<void>;
	/** Called when an OAuth login completes so the caller can write the
	 * `subscription_session` account entry the router resolves against. */
	readonly linkOAuthAccount?: () => void;
}

export class ConnectProviderController {
	readonly providerId: string;
	readonly providerName: string;
	phase = $state<ConnectPhase>({ kind: "method" });

	private readonly supportsOAuth: boolean;
	private readonly supportsApiKey: boolean;
	private readonly onSaved?: () => void | Promise<void>;
	private readonly linkOAuthAccount?: () => void;
	private login: Awaited<ReturnType<typeof startOAuthLogin>> | null = null;

	constructor(opts: ConnectOptions) {
		this.providerId = opts.provider.id;
		this.providerName = opts.provider.name;
		this.supportsOAuth = opts.supportsOAuth;
		this.supportsApiKey = opts.supportsApiKey;
		this.onSaved = opts.onSaved;
		this.linkOAuthAccount = opts.linkOAuthAccount;
	}

	/** True when only one path exists — the dialog can auto-start it. */
	get singlePath(): "oauth" | "key" | "choice" | null {
		if (this.supportsOAuth && !this.supportsApiKey) return "oauth";
		if (this.supportsApiKey && !this.supportsOAuth) return "key";
		if (this.supportsOAuth && this.supportsApiKey) return "choice";
		return null;
	}

	// ---- OAuth flow ------------------------------------------------------

	startOAuth(): void {
		if (this.phase.kind !== "method" && this.phase.kind !== "error") return;
		this.phase = { kind: "oauth-running" };
		void this.runOAuth();
	}

	private async runOAuth(): Promise<void> {
		let url: string | undefined;
		let deviceCode: { userCode: string; verificationUri: string } | undefined;
		let progress: string | undefined;
		let prompt: PendingPrompt | undefined;
		const handle = await startOAuthLogin(this.providerId, () => {
			// OAuth login stored the credential daemon-side; now wire the
			// account entry so the router resolves it as subscription_session.
			this.linkOAuthAccount?.();
			this.onSaved?.();
		});
		this.login = handle;
		handle.onEvent((event) => {
			switch (event.type) {
				case "auth":
					url = event.url;
					this.phase = { kind: "oauth-running", url, deviceCode, progress, prompt };
					break;
				case "device_code":
					deviceCode = { userCode: event.userCode, verificationUri: event.verificationUri };
					this.phase = { kind: "oauth-running", url, deviceCode, progress, prompt };
					break;
				case "prompt":
					prompt = {
						responseId: event.responseId,
						kind: "text",
						message: event.message,
						placeholder: event.placeholder,
						allowEmpty: event.allowEmpty === true,
					};
					this.phase = { kind: "oauth-running", url, deviceCode, progress, prompt };
					break;
				case "select":
					prompt = {
						responseId: event.responseId,
						kind: "select",
						message: event.message,
						options: event.options,
					};
					this.phase = { kind: "oauth-running", url, deviceCode, progress, prompt };
					break;
				case "manual_code":
					prompt = {
						responseId: event.responseId,
						kind: "manual_code",
						message: event.message,
					};
					this.phase = { kind: "oauth-running", url, deviceCode, progress, prompt };
					break;
				case "progress":
					progress = event.message;
					this.phase = { kind: "oauth-running", url, deviceCode, progress, prompt };
					break;
				case "connected":
					this.phase = { kind: "connected" };
					break;
				case "error":
					this.phase = { kind: "error", message: event.error };
					break;
				case "session":
				case "done":
					break;
			}
		});
		this.login.onError((message) => {
			if (this.phase.kind === "oauth-running") this.phase = { kind: "error", message };
		});
	}

	async answerPrompt(value: string): Promise<void> {
		const sessionId = this.login?.sessionId;
		const prompt = this.phase.kind === "oauth-running" ? this.phase.prompt : undefined;
		if (!sessionId || !prompt) return;
		let ok: boolean;
		try {
			ok = await completeOAuthInteraction(sessionId, prompt.responseId, value);
		} catch (error) {
			// Network-level failure (daemon gone, connection drop): the HTTP !ok path
			// is covered by `ok === false`; this catches transport rejection so the
			// prompt doesn't hang with no feedback.
			const message = error instanceof Error ? error.message : "Could not reach the daemon.";
			this.phase = { kind: "error", message };
			return;
		}
		if (!ok) {
			this.phase = { kind: "error", message: "The provider rejected that response. Try again." };
			return;
		}
		// Clear the prompt; the stream emits the next event (progress/connected).
		if (this.phase.kind === "oauth-running") {
			this.phase = { ...this.phase, prompt: undefined };
		}
	}

	cancelOAuth(): void {
		this.login?.close();
		this.login = null;
		this.phase = { kind: "method" };
	}

	async disconnect(): Promise<boolean> {
		// Daemon-side disconnect only. The caller (dialog) owns the single
		// onSaved notification so it can persist the account-entry removal in
		// the same refresh — firing onSaved here would save the pre-removal state
		// first and double the refresh.
		return disconnectOAuthProvider(this.providerId);
	}

	// ---- API-key flow ----------------------------------------------------

	enterKeyMode(): void {
		this.phase = { kind: "key-entry", key: "", reveal: false, validation: "empty", testing: false };
	}

	setKey(value: string): void {
		if (this.phase.kind !== "key-entry") return;
		this.phase = {
			...this.phase,
			key: value,
			validation: validateApiKey(this.providerId, value),
			testing: false,
		};
	}

	toggleReveal(): void {
		if (this.phase.kind !== "key-entry") return;
		this.phase = { ...this.phase, reveal: !this.phase.reveal };
	}

	/** Save the key into the encrypted vault + link the account. The caller
	 * (dialog) wires the account/credentialRef into agent.yaml via the settings
	 * store; this only handles the secret write and final status. */
	async saveKey(linkAccount: () => void): Promise<void> {
		if (this.phase.kind !== "key-entry") return;
		const value = this.phase.key.trim();
		if (!value) return;
		this.phase = { kind: "saving" };
		const name = providerKeySecretName(this.providerId);
		const stored = await putSecret(name, value);
		if (!stored) {
			this.phase = { kind: "error", message: "Could not save the key to the encrypted vault." };
			return;
		}
		linkAccount();
		this.onSaved?.();
		this.phase = { kind: "connected" };
	}

	reset(): void {
		this.login?.close();
		this.login = null;
		this.phase = { kind: "method" };
	}

	dispose(): void {
		this.login?.close();
		this.login = null;
	}
}

/**
 * Connect-provider dialog — OAuth sign-in (popup + SSE state machine) or
 * API-key paste. Visual language follows the settings modal (mcard/ctrl);
 * flows ported from the old Svelte ConnectProviderDialog.
 */
import { useConnectController } from "@/components/settings/connect-controller";
import { api } from "@/lib/api";
import { getDesktopBridge } from "@/lib/desktop";
import { apiKeyFormat, providerKeySecretName } from "@/lib/inference-keys";
import { createOAuthNavigation, safeOAuthHref, type OAuthNavigation } from "@/lib/oauth-navigation";
import { cn } from "@/lib/utils";
import { CheckCircle, Eye, EyeOff, KeyRound, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface ConnectableProvider {
	id: string;
	name: string;
	supportsOAuth: boolean;
	supportsApiKey: boolean;
	connected: boolean;
	isOAuth: boolean;
}

function hostnameOf(uri: string): string {
	try {
		return new URL(uri).hostname || uri;
	} catch {
		return uri;
	}
}

export function ConnectProviderDialog({
	provider,
	modelCount,
	onClose,
	onSaved,
	linkOAuthAccount,
	linkApiKeyAccount,
	unlinkAccount,
}: {
	provider: ConnectableProvider;
	modelCount: number;
	onClose: () => void;
	/** Persist config + refresh catalog after any wiring change. */
	onSaved: () => void | Promise<void>;
	/** Write the subscription_session account entry into agent config. */
	linkOAuthAccount: () => void;
	/** Write the api account entry (kind + providerFamily + credentialRef). */
	linkApiKeyAccount: (secretName: string) => void;
	/** Remove the account entry entirely (disconnect path). */
	unlinkAccount: () => void;
}) {
	// Desktop uses the context-isolated external-navigation bridge. Browser
	// sessions keep the synchronous popup fallback for popup blockers.
	const [oauthOpenError, setOAuthOpenError] = useState<string | null>(null);
	const oauthNavigationRef = useRef<OAuthNavigation | null>(null);
	const oauthNavigation =
		oauthNavigationRef.current ??
		createOAuthNavigation({
			bridge: getDesktopBridge(),
			popup: () => window.open("about:blank", "signet-oauth", "width=640,height=760"),
			reportError: setOAuthOpenError,
			clearError: () => setOAuthOpenError(null),
		});
	oauthNavigationRef.current = oauthNavigation;
	const openOAuthWindow = (): boolean => oauthNavigation.open();
	const navigateOAuthWindow = (url: string): void => oauthNavigation.navigate(url);
	const closeOAuthWindow = (): void => oauthNavigation.close();

	const controller = useConnectController({
		providerId: provider.id,
		supportsOAuth: provider.supportsOAuth,
		supportsApiKey: provider.supportsApiKey,
		onNavigate: navigateOAuthWindow,
		onConnected: () => {
			linkOAuthAccount();
			void onSaved();
		},
	});
	const { phase } = controller;

	// Auto-enter the only available path. OAuth is NEVER auto-started — the
	// navigation must begin inside a real click gesture.
	const [autoEntered, setAutoEntered] = useState(false);
	useEffect(() => {
		if (autoEntered || provider.connected) return;
		if (!provider.supportsOAuth && provider.supportsApiKey) {
			controller.enterKeyMode();
			setAutoEntered(true);
		}
	}, [autoEntered, provider, controller]);

	// Close the popup once OAuth resolves (any non-running phase).
	useEffect(() => {
		if (phase.kind !== "oauth-running") oauthNavigation.close();
	}, [phase.kind, oauthNavigation]);
	useEffect(() => () => oauthNavigation.dispose(), [oauthNavigation]);

	const [promptInput, setPromptInput] = useState("");
	const [disconnecting, setDisconnecting] = useState(false);
	const format = apiKeyFormat(provider.id);

	const handleSignIn = () => {
		setOAuthOpenError(null);
		if (!openOAuthWindow()) {
			controller.setError("Your browser blocked the sign-in popup. Allow popups for this page and try again.");
			return;
		}
		controller.startOAuth();
	};

	const handleSaveKey = async () => {
		if (phase.kind !== "key-entry") return;
		const value = phase.key.trim();
		if (!value) return;
		controller.beginSaving();
		const name = providerKeySecretName(provider.id);
		const stored = await api.putSecret(name, value);
		if (!stored.ok) {
			controller.finishSaved(false, stored.error ?? "Could not save the key to the encrypted vault.");
			return;
		}
		linkApiKeyAccount(name);
		void onSaved();
		controller.finishSaved(true);
	};

	const handleDisconnect = async () => {
		setDisconnecting(true);
		// daemon-side first: clear OAuth creds + delete any stored API key,
		// then remove the account entry and persist — order matters, or
		// agent.yaml keeps a credentialRef pointing at a deleted secret.
		await api.deleteSecret(providerKeySecretName(provider.id));
		await controller.disconnect();
		unlinkAccount();
		await onSaved();
		setDisconnecting(false);
		onClose();
	};

	const submitPrompt = () => {
		const prompt = phase.kind === "oauth-running" ? phase.prompt : undefined;
		const value = promptInput.trim();
		if (!value && prompt?.allowEmpty !== true) return;
		void controller.answerPrompt(value);
		setPromptInput("");
	};

	return (
		<div
			className="cp-backdrop"
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="cp-panel" role="dialog" aria-modal="true" aria-label={`Connect ${provider.name}`}>
				<header className="cp-header">
					<span className="cp-header-icon">
						{phase.kind === "key-entry" || phase.kind === "saving" ? <KeyRound className="size-4" /> : <CheckCircle className="size-4" />}
					</span>
					<div className="min-w-0 flex-1">
						<div className="cp-title">{provider.name}</div>
						<div className="cp-sub">
							{provider.connected ? "Connected" : provider.isOAuth ? "OAuth sign-in" : "API key"}
							{modelCount > 0 ? ` · ${modelCount} models` : ""}
						</div>
					</div>
					<button type="button" className="gr-close" aria-label="Close" onClick={onClose}>
						<X className="size-3.5" />
					</button>
				</header>

				<div className="cp-body">
					{/* connected state — status + disconnect */}
					{provider.connected && phase.kind === "method" && (
						<>
							<div className="cp-status-line">
								<span className="cp-dot cp-dot--on" />
								Connected — credentials are stored and resolving.
							</div>
							<button type="button" className="cp-btn cp-btn--danger" disabled={disconnecting} onClick={handleDisconnect}>
								{disconnecting ? "Disconnecting…" : "Disconnect"}
							</button>
						</>
					)}

					{/* method choice */}
					{!provider.connected && phase.kind === "method" && (
						<div className="flex flex-col gap-2">
							{provider.supportsOAuth && (
								<button type="button" className="cp-btn cp-btn--primary" onClick={handleSignIn}>
									Sign in with {provider.name}
								</button>
							)}
							{provider.supportsApiKey && (
								<button type="button" className="cp-btn" onClick={controller.enterKeyMode}>
									Paste an API key
								</button>
							)}
						</div>
					)}

					{/* OAuth running */}
					{phase.kind === "oauth-running" && (
						<div className="flex flex-col gap-2.5">
							<div className="cp-status-line">
								<Loader2 className="size-3.5 animate-spin" />
								{phase.progress ?? "Waiting for sign-in…"}
							</div>
							{oauthOpenError && !phase.prompt && (
								<div className="cp-error">
									<TriangleAlert className="size-3.5 shrink-0" /> {oauthOpenError}
								</div>
							)}
							{phase.url && safeOAuthHref(phase.url) && (
								<a className="cp-link" href={safeOAuthHref(phase.url)!} target="_blank" rel="noreferrer">
									Open {hostnameOf(phase.url)} to continue →
								</a>
							)}
							{phase.deviceCode && (
								<div className="cp-device">
									<span className="cp-device__label">Enter this code at {hostnameOf(phase.deviceCode.verificationUri)}</span>
									<span className="cp-device__code">{phase.deviceCode.userCode}</span>
								</div>
							)}
							{phase.prompt && phase.prompt.kind !== "select" && (
								<div className="flex flex-col gap-1.5">
									<label className="cp-label" htmlFor="cp-prompt">{phase.prompt.message}</label>
									<div className="flex gap-1.5">
										<input
											id="cp-prompt"
											className="ctrl ctrl--field flex-1"
											placeholder={phase.prompt.placeholder ?? ""}
											value={promptInput}
											autoFocus
											onChange={(e) => setPromptInput(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") submitPrompt();
											}}
										/>
										<button type="button" className="cp-btn cp-btn--primary" onClick={submitPrompt}>Send</button>
									</div>
								</div>
							)}
							{phase.prompt?.kind === "select" && (
								<div className="flex flex-col gap-1.5">
									<span className="cp-label">{phase.prompt.message}</span>
									{phase.prompt.options?.map((opt) => (
										<button key={opt.id} type="button" className="cp-btn" onClick={() => void controller.answerPrompt(opt.id)}>
											{opt.label}
										</button>
									))}
								</div>
							)}
							<button type="button" className="cp-btn" onClick={controller.cancelOAuth}>Cancel</button>
						</div>
					)}

					{/* API-key entry */}
					{phase.kind === "key-entry" && (
						<div className="flex flex-col gap-2">
							<label className="cp-label" htmlFor="cp-key">
								API key {format ? <span className="text-muted-foreground">({format.hint})</span> : null}
							</label>
							<div className="flex gap-1.5">
								<div className="ctrl ctrl--field flex-1">
									<input
										id="cp-key"
										type={phase.reveal ? "text" : "password"}
										placeholder="Paste the key…"
										value={phase.key}
										autoFocus
										autoComplete="off"
										spellCheck={false}
										onChange={(e) => controller.setKey(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void handleSaveKey();
										}}
									/>
									<button type="button" className="cp-eye" aria-label={phase.reveal ? "Hide key" : "Show key"} onClick={controller.toggleReveal}>
										{phase.reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
									</button>
								</div>
								<button type="button" className="cp-btn cp-btn--primary" disabled={!phase.key.trim()} onClick={() => void handleSaveKey()}>
									Connect
								</button>
							</div>
							{phase.validation === "unsure" && phase.key.trim() && (
								<div className="cp-hint">
									<TriangleAlert className="size-3" />
									Doesn&apos;t match the usual {provider.name} key shape — saved anyway if you continue.
								</div>
							)}
							<div className="cp-hint">Stored encrypted in the Signet vault. The value is never shown again.</div>
						</div>
					)}

					{phase.kind === "saving" && (
						<div className="cp-status-line">
							<Loader2 className="size-3.5 animate-spin" /> Saving to the encrypted vault…
						</div>
					)}

					{phase.kind === "connected" && (
						<div className="cp-status-line">
							<span className="cp-dot cp-dot--on" /> Connected — you can assign this provider to a target now.
						</div>
					)}

					{phase.kind === "error" && (
						<div className="flex flex-col gap-2">
							<div className="cp-error">
								<TriangleAlert className="size-3.5 shrink-0" /> {phase.message}
							</div>
							<button type="button" className="cp-btn" onClick={controller.reset}>Try again</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

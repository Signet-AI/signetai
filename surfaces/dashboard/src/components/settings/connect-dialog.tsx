import { ModalHeading } from "@/components/ui/modal-heading";
import { Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { useConnectController } from "@/components/settings/connect-controller";
import { api } from "@/lib/api";
import { getDesktopBridge } from "@/lib/desktop";
import { apiKeyFormat, providerKeySecretName } from "@/lib/inference-keys";
import { createOAuthNavigation, safeOAuthHref, type OAuthNavigation } from "@/lib/oauth-navigation";
import { CheckCircle, Eye, EyeOff, KeyRound, Loader2, TriangleAlert } from "@/components/mingcute-icons";
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
	onSaved: () => void | Promise<void>;
	linkOAuthAccount: () => void;
	linkApiKeyAccount: (secretName: string) => void;
	unlinkAccount: () => void;
}) {
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
	const _closeOAuthWindow = (): void => oauthNavigation.close();

	const controller = useConnectController({
		providerId: provider.id,
		supportsOAuth: provider.supportsOAuth,
		supportsApiKey: provider.supportsApiKey,
		onNavigate: navigateOAuthWindow,
		onConnected: async () => {
			linkOAuthAccount();
			await onSaved();
		},
	});
	const { phase } = controller;
	const [autoEntered, setAutoEntered] = useState(false);
	useEffect(() => {
		if (autoEntered || provider.connected) return;
		if (!provider.supportsOAuth && provider.supportsApiKey) {
			controller.enterKeyMode();
			setAutoEntered(true);
		}
	}, [autoEntered, provider, controller]);
	useEffect(() => {
		if (phase.kind !== "oauth-running") oauthNavigation.close();
	}, [phase.kind, oauthNavigation]);
	useEffect(() => () => oauthNavigation.dispose(), [oauthNavigation]);

	const keySaveController = useRef<AbortController | null>(null);
	useEffect(() => () => keySaveController.current?.abort(), []);

	const closeDialog = () => {
		keySaveController.current?.abort();
		onClose();
	};

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

	const handleSaveKey = async (authorizeKeyring = false) => {
		if (phase.kind !== "key-entry" && phase.kind !== "keyring-authorization") return;
		const value = phase.key.trim();
		if (!value) return;
		if (keySaveController.current) return;
		const request = new AbortController();
		keySaveController.current = request;
		controller.beginSaving();
		const name = providerKeySecretName(provider.id);
		const stored = await api.putSecret(name, value, request.signal, authorizeKeyring);
		keySaveController.current = null;
		if (request.signal.aborted) return;
		if (!stored.ok) {
			if (stored.authorizationRequired) {
				controller.requestKeyringAuthorization(
					value,
					stored.error ?? "Authorize macOS Keychain access to save your key.",
				);
				return;
			}
			controller.finishSaved(false, stored.error ?? "Could not save the key to the encrypted vault.");
			return;
		}
		linkApiKeyAccount(name);
		try {
			await onSaved();
			controller.finishSaved(true);
		} catch (error) {
			controller.finishSaved(false, error instanceof Error ? error.message : "Could not save the connection.");
		}
	};

	const handleDisconnect = async () => {
		setDisconnecting(true);
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
			className="cs-backdrop"
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget) closeDialog();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") closeDialog();
			}}
		>
			<div
				className="cs-panel"
				style={{ width: 420 }}
				role="dialog"
				aria-modal="true"
				aria-label={`Connect ${provider.name}`}
			>
				<ModalHeading
					title={provider.name}
					description={
						<>
							{provider.connected ? "Connected" : provider.isOAuth ? "OAuth sign-in" : "API key"}
							{modelCount > 0 ? ` · ${modelCount} models` : ""}
						</>
					}
					icon={
						phase.kind === "key-entry" || phase.kind === "keyring-authorization" || phase.kind === "saving" ? (
							<KeyRound className="size-4" />
						) : (
							<CheckCircle className="size-4" />
						)
					}
					onClose={closeDialog}
				/>

				<div className="cs-body">
					{provider.connected && phase.kind === "method" && (
						<>
							<div className="cp-status-line">
								<span className="cp-dot cp-dot--on" />
								Sign-in saved. Test the memory connection to verify it works.
							</div>
							<Button
								variant="destructive"
								size="compact"
								type="button"
								disabled={disconnecting}
								onClick={handleDisconnect}
							>
								{disconnecting ? "Disconnecting…" : "Disconnect"}
							</Button>
						</>
					)}
					{!provider.connected && phase.kind === "method" && (
						<div className="flex flex-col gap-2">
							{provider.supportsOAuth && (
								<Button variant="default" size="compact" type="button" onClick={handleSignIn}>
									Sign in with {provider.name}
								</Button>
							)}
							{provider.supportsApiKey && (
								<Button variant="outline" size="compact" type="button" onClick={() => controller.enterKeyMode()}>
									Paste an API key
								</Button>
							)}
						</div>
					)}
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
								<a className="cp-link" href={safeOAuthHref(phase.url) ?? undefined} target="_blank" rel="noreferrer">
									Open {hostnameOf(phase.url)} to continue →
								</a>
							)}
							{phase.deviceCode && (
								<div className="cp-device">
									<span className="cp-device__label">
										Enter this code at {hostnameOf(phase.deviceCode.verificationUri)}
									</span>
									<span className="cp-device__code">{phase.deviceCode.userCode}</span>
								</div>
							)}
							{phase.prompt && phase.prompt.kind !== "select" && (
								<div className="flex flex-col gap-1.5">
									<label className="cp-label" htmlFor="cp-prompt">
										{phase.prompt.message}
									</label>
									<div className="flex gap-1.5">
										<Input
											id="cp-prompt"
											className="flex-1"
											placeholder={phase.prompt.placeholder ?? ""}
											value={promptInput}
											onChange={(e) => setPromptInput(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") submitPrompt();
											}}
										/>
										<Button variant="default" size="compact" type="button" onClick={submitPrompt}>
											Send
										</Button>
									</div>
								</div>
							)}
							{phase.prompt?.kind === "select" && (
								<div className="flex flex-col gap-1.5">
									<span className="cp-label">{phase.prompt.message}</span>
									{phase.prompt.options?.map((opt) => (
										<Button
											variant="outline"
											size="compact"
											key={opt.id}
											type="button"
											onClick={() => void controller.answerPrompt(opt.id)}
										>
											{opt.label}
										</Button>
									))}
								</div>
							)}
							<Button variant="outline" size="compact" type="button" onClick={controller.cancelOAuth}>
								Cancel
							</Button>
						</div>
					)}
					{phase.kind === "key-entry" && (
						<div className="flex flex-col gap-2">
							<label className="cp-label" htmlFor="cp-key">
								API key {format ? <span className="text-muted-foreground">({format.hint})</span> : null}
							</label>
							<div className="flex gap-1.5">
								<div className="ui-search-field flex-1">
									<Input
										id="cp-key"
										type={phase.reveal ? "text" : "password"}
										placeholder="Paste the key…"
										value={phase.key}
										autoComplete="off"
										spellCheck={false}
										onChange={(e) => controller.setKey(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void handleSaveKey();
										}}
									/>
									<Button
										variant="ghost"
										size="icon-sm"
										type="button"
										aria-label={phase.reveal ? "Hide key" : "Show key"}
										onClick={controller.toggleReveal}
									>
										{phase.reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
									</Button>
								</div>
								<Button
									variant="default"
									size="compact"
									type="button"
									disabled={!phase.key.trim()}
									onClick={() => void handleSaveKey()}
								>
									Connect
								</Button>
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

					{phase.kind === "keyring-authorization" && (
						<div className="flex flex-col gap-2">
							<div className="cp-error">
								<TriangleAlert className="size-3.5 shrink-0" /> {phase.message}
							</div>
							<p className="cp-hint">
								The next prompt is from macOS. Enter your login Keychain password and choose Always Allow so Signet can
								use this provider in the background. One-time access cannot enable background requests.
							</p>
							<Button type="button" onClick={() => void handleSaveKey(true)}>
								Authorize and save key
							</Button>
							<Button type="button" variant="outline" onClick={() => controller.enterKeyMode(phase.key)}>
								Cancel
							</Button>
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
							<Button variant="outline" size="compact" type="button" onClick={controller.reset}>
								Try again
							</Button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

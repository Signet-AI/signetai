<script lang="ts">
import type { OAuthProviderStatus } from "$lib/api";
import { apiKeyFormat, deleteSecret, getInferenceStatus, providerKeySecretName } from "$lib/api";
import { CheckCircle, ExternalLink, Eye, EyeOff, KeyRound, Loader, RefreshCw, TriangleAlertIcon, Unlink, X } from "$lib/icons";
import { st } from "$lib/stores/settings.svelte";
import { onDestroy, onMount } from "svelte";
import { ConnectProviderController } from "./connect-provider.svelte";

interface Props {
	provider: OAuthProviderStatus | { readonly id: string; readonly name: string; readonly connected: boolean };
	supportsOAuth: boolean;
	supportsApiKey: boolean;
	onclose: () => void;
	onsaved: () => void | Promise<void>;
}

let {
	provider,
	supportsOAuth,
	supportsApiKey,
	onclose,
	onsaved,
}: Props = $props();

// Controller owns all flow state. The component is a thin render over phase.
let controller = $state(
	new ConnectProviderController({
		provider,
		supportsOAuth,
		supportsApiKey,
		onSaved: onsaved,
		linkOAuthAccount: linkOAuthAccountForProvider,
		onNavigate: navigateOAuthWindow,
	}),
);

let verifying = $state(false);
let verifyResult = $state<{ ok: boolean; message: string } | null>(null);
let otp = $state("");
let promptInput = $state("");
// OAuth popup handle. Opened SYNCHRONOUSLY inside the sign-in click (the only
// way browsers permit window.open), then navigated once the daemon emits the
// auth URL. The daemon runs a local callback server (e.g. localhost:53692 for
// Claude, localhost:1455 for Codex); the provider redirects there after login,
// the daemon captures the code, and the SSE stream emits `connected`.
let oauthWindow: Window | null = null;

function openOAuthWindow(): boolean {
	if (oauthWindow && !oauthWindow.closed) return true;
	// NOTE: do NOT pass noopener — that makes window.open return null (spec),
	// which would discard the handle and leave the popup stranded on about:blank.
	// We need the handle to navigate the popup to the auth URL once it arrives.
	oauthWindow = window.open("about:blank", "signet-oauth", "width=640,height=760");
	if (!oauthWindow) {
		// Popup blocker prevented the window. The UI still renders a clickable
		// link when the URL arrives, so the user can open it manually.
		oauthWindow = null;
		return false;
	}
	return true;
}

function navigateOAuthWindow(url: string): void {
	if (!oauthWindow || oauthWindow.closed) return;
	try {
		oauthWindow.location.href = url;
	} catch {
		// Cross-origin guard — can happen briefly on some browsers; the clickable
		// link in the dialog is the fallback.
	}
}

function closeOAuthWindow(): void {
	if (oauthWindow && !oauthWindow.closed) {
		try {
			oauthWindow.close();
		} catch {
			/* ignore */
		}
	}
	oauthWindow = null;
}

const format = apiKeyFormat(provider.id);
const phase = $derived(controller.phase);

onMount(() => {
	// Only auto-enter API-key mode (no window needed). OAuth is NEVER auto-
	// started: window.open must run inside a real user gesture (the Sign in
	// click), which onMount is not, so the popup would be blocked.
	const path = controller.singlePath;
	if (path === "key") controller.enterKeyMode();
});

onDestroy(() => {
	closeOAuthWindow();
	controller.dispose();
});

// The connected phase lingers (no auto-close) so the user can verify the
// connection and dismiss deliberately.
function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") handleClose();
}

function handleClose(): void {
	closeOAuthWindow();
	controller.dispose();
	onclose();
}

// Sign-in entry point: open the browser window FIRST (synchronously, inside
// the click) so the popup is allowed, then start the daemon-side OAuth flow;
// when the auth URL arrives it navigates the already-open window.
function beginSignIn(): void {
	openOAuthWindow();
	controller.startOAuth();
}

// Close the popup once OAuth resolves (connected/error/cancel). Kept as an
// effect so every exit path is covered without scattering closeOAuthWindow().
$effect(() => {
	if (phase.kind !== "oauth-running") closeOAuthWindow();
});

function linkAccountForApiKey(): void {
	// Wire inference.accounts.<provider> as a key-bearing API account so the
	// router resolves credentialRef → stored secret. Matches the shape
	// parseAccountConfig requires (kind + providerFamily) and the router's
	// resolveCredential precedence (env, then secret). The secret name MUST
	// match what saveKey stored (providerKeySecretName) — reuse the helper so
	// the two can never drift.
	const base = ["inference", "accounts", provider.id];
	st.aSetStr([...base, "kind"], "api");
	st.aSetStr([...base, "providerFamily"], provider.id);
	st.aSetStr([...base, "credentialRef"], providerKeySecretName(provider.id));
}

function linkOAuthAccountForProvider(): void {
	// OAuth providers connect as a subscription_session account. The router's
	// isOAuthBackedAccount() recognizes kind: subscription_session (or a missing
	// credentialRef) and resolves the OAuth credential daemon-side. No
	// credentialRef — creds live in the SIGNET_OAUTH_* secret the login wrote.
	const base = ["inference", "accounts", provider.id];
	st.aSetStr([...base, "kind"], "subscription_session");
	st.aSetStr([...base, "providerFamily"], provider.id);
	st.aDel([...base, "credentialRef"]);
}

async function handleSaveKey(): Promise<void> {
	await controller.saveKey(linkAccountForApiKey);
}

async function handleVerify(): Promise<void> {
	verifying = true;
	verifyResult = null;
	const status = await getInferenceStatus(true);
	verifying = false;
	// Find targets whose config account resolves to this provider (the only
	// honest cross-reference available client-side: config-side account family).
	const family = provider.id;
	const boundRefs: string[] = [];
	for (const targetName of ["background", "aggregation"]) {
		const acct = st.aStr(["inference", "targets", targetName, "account"]);
		const acctFamily = acct ? st.aStr(["inference", "accounts", acct, "providerFamily"]) : "";
		if (acctFamily === family) boundRefs.push(`${targetName}/default`);
	}
	const targets = status?.runtimeSnapshot?.targets ?? {};
	let okSeen = false;
	let failReason: string | null = null;
	for (const ref of boundRefs) {
		const state = targets[ref];
		if (state?.available) okSeen = true;
		else if (state && !failReason) failReason = state.unavailableReason ?? "not reachable yet";
	}
	if (okSeen) {
		verifyResult = { ok: true, message: "Connection verified — provider is reachable." };
	} else if (boundRefs.length === 0) {
		verifyResult = {
			ok: true,
			message: "Key saved and encrypted. Assign this provider to a target below to use it.",
		};
	} else if (failReason) {
		verifyResult = { ok: false, message: failReason };
	} else {
		// Bound to a target that isn't probeable yet (usually no model selected).
		verifyResult = {
			ok: false,
			message: "Provider is assigned but not probeable yet — pick a model for the target.",
		};
	}
}

async function handleDisconnect(): Promise<void> {
	// daemon-side: clear OAuth creds + delete the stored API key (persist now).
	await deleteSecret(providerKeySecretName(provider.id));
	await controller.disconnect();
	// config-side: remove the account entry, THEN persist + refresh. The aDel
	// must be saved (not just in-memory) or agent.yaml keeps a credentialRef
	// pointing at the now-deleted secret — a broken "Connected" card on reload.
	const base = ["inference", "accounts", provider.id];
	st.aDel([...base, "kind"]);
	st.aDel([...base, "providerFamily"]);
	st.aDel([...base, "credentialRef"]);
	st.aDel(base);
	await onsaved();
	handleClose();
}

function submitPrompt(): void {
	const allowEmpty = phase.kind === "oauth-running" && phase.prompt?.allowEmpty === true;
	const value = promptInput.trim();
	if (!value && !allowEmpty) return;
	void controller.answerPrompt(value);
	promptInput = "";
}

// Select an offered OAuth option (device flow choice etc.)
function selectOption(id: string): void {
	void controller.answerPrompt(id);
}

// Safely extract a hostname for the device-code link label; never throws in render.
function hostnameOf(uri: string): string {
	try {
		return new URL(uri).hostname || uri;
	} catch {
		return uri;
	}
}

// Allowlist http(s) for any daemon-sourced URL we bind to href. Svelte escapes
// attribute text but does not block javascript:/data: schemes; a poisoned OAuth
// stream could otherwise inject a click-to-execute link. Defense-in-depth.
function safeHref(uri: string | undefined): string | null {
	if (!uri) return null;
	return /^https?:\/\//i.test(uri) ? uri : null;
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="dialog-backdrop"
	role="presentation"
	onclick={(e) => {
		if (e.target === e.currentTarget) handleClose();
	}}
>
	<div class="dialog-panel" role="dialog" aria-modal="true" aria-label="Connect {provider.name}">
		<header class="dialog-header">
			<div class="title-wrap">
				{#if phase.kind === "key-entry" || phase.kind === "saving"}
					<KeyRound class="size-4" />
				{:else}
					<div class="provider-dot" aria-hidden="true"></div>
				{/if}
				<h2 class="dialog-title">{provider.name}</h2>
			</div>
			<button class="dialog-close" onclick={handleClose} aria-label="Close">
				<X class="size-4" />
			</button>
		</header>

		<div class="dialog-body">
			{#if phase.kind === "method"}
				<p class="lede">Choose how to connect {provider.name}.</p>
				<div class="method-list">
					{#if supportsOAuth}
						<button class="method-card" onclick={() => beginSignIn()}>
							<div class="method-icon"><RefreshCw class="size-4" /></div>
							<div class="method-text">
								<span class="method-label">Sign in</span>
								<span class="method-hint">Open a secure login in your browser</span>
							</div>
						</button>
					{/if}
					{#if supportsApiKey}
						<button class="method-card" onclick={() => controller.enterKeyMode()}>
							<div class="method-icon"><KeyRound class="size-4" /></div>
							<div class="method-text">
								<span class="method-label">Use an API key</span>
								<span class="method-hint">Paste a key from your provider dashboard</span>
							</div>
						</button>
					{/if}
				</div>
			{:else if phase.kind === "oauth-running"}
				{#if phase.prompt}
					<div class="prompt-block">
						<p class="prompt-message">{phase.prompt.message}</p>
						{#if phase.prompt.kind === "select" && phase.prompt.options}
							<div class="option-list">
								{#each phase.prompt.options as opt (opt.id)}
									<button class="option-card" onclick={() => selectOption(opt.id)}>
										<span>{opt.label}</span>
									</button>
								{/each}
							</div>
						{:else}
							<form
								onsubmit={(e) => {
									e.preventDefault();
									submitPrompt();
								}}
							>
								<div class="key-row">
									<input
										class="text-input"
										type="text"
										placeholder={phase.prompt.placeholder ?? ""}
										bind:value={promptInput}
										autocomplete="off"
										spellcheck="false"
									/>
									<button class="btn btn--primary" type="submit" disabled={!promptInput.trim() && !(phase.prompt?.allowEmpty === true)}>
										Continue
									</button>
								</div>
							</form>
						{/if}
						<button class="link-btn" onclick={() => controller.cancelOAuth()}>Cancel</button>
					</div>
				{:else if phase.url}
					<div class="auth-block">
						<p class="lede">A login page should have opened in your browser.</p>
						{#if safeHref(phase.url)}
							<a class="btn btn--primary auth-link" href={safeHref(phase.url)} target="_blank" rel="noopener noreferrer">
								<ExternalLink class="size-3.5" /> Open login page
							</a>
						{:else}
							<p class="format-hint">Login URL: {phase.url}</p>
						{/if}
						<div class="waiting">
							<Loader class="size-3.5 spin" />
							<span>Waiting for you to finish signing in…</span>
						</div>
						{#if phase.progress}<p class="progress-note">{phase.progress}</p>{/if}
						<button class="link-btn" onclick={() => controller.cancelOAuth()}>Cancel</button>
					</div>
				{:else if phase.deviceCode}
					<div class="device-block">
						<p class="lede">Enter this code, then approve the login:</p>
						<div class="device-code" role="textbox" aria-label="Device code" tabindex="-1">{phase.deviceCode.userCode}</div>
						{#if safeHref(phase.deviceCode.verificationUri)}
							<a class="btn btn--secondary auth-link" href={safeHref(phase.deviceCode.verificationUri)} target="_blank" rel="noopener noreferrer">
								<ExternalLink class="size-3.5" /> Open {hostnameOf(phase.deviceCode.verificationUri)}
							</a>
						{:else}
							<p class="format-hint">Verification URL: {phase.deviceCode.verificationUri}</p>
						{/if}
						<div class="waiting">
							<Loader class="size-3.5 spin" />
							<span>Waiting for approval…</span>
						</div>
						<button class="link-btn" onclick={() => controller.cancelOAuth()}>Cancel</button>
					</div>
				{:else}
					<div class="waiting-block">
						<Loader class="size-4 spin" />
						<p>Starting secure login…</p>
					</div>
				{/if}
			{:else if phase.kind === "key-entry"}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						if (phase.validation !== "empty") handleSaveKey();
					}}
				>
					<p class="lede">Paste your {provider.name} API key. It's stored encrypted and never shown again.</p>
					{#if format}
						<p class="format-hint">Keys for this provider usually {format.hint}.</p>
					{/if}
					<div class="key-row">
						<input
							class="text-input"
							type={phase.reveal ? "text" : "password"}
							placeholder="Paste API key"
							value={phase.key}
							oninput={(e) => controller.setKey(e.currentTarget.value)}
							autocomplete="off"
							spellcheck="false"
						/>
						<button
							class="reveal-btn"
							type="button"
							onclick={() => controller.toggleReveal()}
							aria-label={phase.reveal ? "Hide key" : "Show key"}
						>
							{#if phase.reveal}<EyeOff class="size-3.5" />{:else}<Eye class="size-3.5" />{/if}
						</button>
					</div>
					{#if phase.validation === "valid"}
						<p class="key-status key-status--ok"><CheckCircle class="size-3.5" /> Looks like a valid {provider.name} key.</p>
					{:else if phase.validation === "unsure" && phase.key.trim()}
						<p class="key-status key-status--unsure"><TriangleAlertIcon class="size-3.5" /> That doesn't match the usual format. Double-check it — it may still work.</p>
					{/if}
					{#if verifyResult}
						<p class="key-status {verifyResult.ok ? "key-status--ok" : "key-status--unsure"}">
							{#if verifyResult.ok}<CheckCircle class="size-3.5" />{:else}<TriangleAlertIcon class="size-3.5" />{/if}
							{verifyResult.message}
						</p>
					{/if}
					<div class="key-actions">
						<button class="btn btn--primary" type="submit" disabled={phase.validation === "empty"}>
							Connect
						</button>
						<button class="btn btn--ghost" type="button" onclick={handleVerify} disabled={verifying || phase.validation === "empty"}>
							{#if verifying}<Loader class="size-3.5 spin" />{:else}<RefreshCw class="size-3.5" />{/if}
							Verify
						</button>
					</div>
				</form>
			{:else if phase.kind === "saving"}
				<div class="waiting-block">
					<Loader class="size-4 spin" />
					<p>Saving key…</p>
				</div>
			{:else if phase.kind === "connected"}
				<div class="success-block">
					<CheckCircle class="size-6" />
					<p>{provider.name} is connected.</p>
					{#if verifyResult}
						<p class="key-status {verifyResult.ok ? "key-status--ok" : "key-status--unsure"}">
							{#if verifyResult.ok}<CheckCircle class="size-3.5" />{:else}<TriangleAlertIcon class="size-3.5" />{/if}
							{verifyResult.message}
						</p>
					{/if}
					<div class="key-actions">
						<button class="btn btn--ghost" onclick={handleVerify} disabled={verifying}>
							{#if verifying}<Loader class="size-3.5 spin" />{:else}<RefreshCw class="size-3.5" />{/if}
							Verify
						</button>
						<button class="btn btn--primary" onclick={handleClose}>Done</button>
					</div>
				</div>
			{:else if phase.kind === "error"}
				<div class="error-block">
					<TriangleAlertIcon class="size-5" />
					<p class="error-message">{phase.message}</p>
					<div class="error-actions">
						<button class="btn btn--primary" onclick={() => controller.reset()}>Try again</button>
						{#if provider.connected}
							<button class="btn btn--ghost" onclick={handleDisconnect}>
								<Unlink class="size-3.5" /> Disconnect
							</button>
						{/if}
					</div>
				</div>
			{/if}

			{#if provider.connected && phase.kind === "method"}
				<div class="manage-block">
					<p class="manage-note">{provider.name} is currently connected.</p>
					<button class="btn btn--ghost danger" onclick={handleDisconnect}>
						<Unlink class="size-3.5" /> Disconnect
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}

	.dialog-panel {
		background: var(--sig-surface);
		border: 1px solid var(--sig-border-strong);
		border-radius: 12px;
		width: 100%;
		max-width: 460px;
		max-height: 85vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 18px 12px;
		border-bottom: 1px solid var(--sig-border);
	}

	.title-wrap {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.provider-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--sig-accent);
	}

	.dialog-title {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		color: var(--sig-text);
		margin: 0;
	}

	.dialog-close {
		background: none;
		border: none;
		color: var(--sig-text-muted);
		cursor: pointer;
		padding: 4px;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.dialog-close:hover {
		color: var(--sig-text);
		background: var(--sig-surface-raised);
	}

	.dialog-body {
		padding: 18px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		overflow-y: auto;
	}

	.lede {
		font-family: var(--font-body);
		font-size: 12px;
		line-height: 1.55;
		color: var(--sig-text-muted);
		margin: 0;
	}

	.method-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.method-card {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--sig-border);
		border-radius: 9px;
		background: var(--sig-bg);
		cursor: pointer;
		text-align: left;
		transition: border-color 0.12s, background 0.12s;
	}
	.method-card:hover {
		border-color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}
	.method-icon {
		color: var(--sig-accent);
		display: flex;
	}
	.method-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.method-label {
		font-family: var(--font-body);
		font-size: 12.5px;
		font-weight: 600;
		color: var(--sig-text);
	}
	.method-hint {
		font-family: var(--font-body);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.key-row {
		display: flex;
		gap: 6px;
		align-items: stretch;
	}
	.text-input {
		flex: 1;
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 8px 10px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 8px;
		background: var(--sig-bg);
		color: var(--sig-text);
		outline: none;
		min-width: 0;
	}
	.text-input:focus {
		border-color: var(--sig-accent);
	}
	.reveal-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		border: 1px solid var(--sig-border-strong);
		border-radius: 8px;
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		cursor: pointer;
	}
	.reveal-btn:hover {
		color: var(--sig-text);
	}

	.format-hint {
		font-family: var(--font-body);
		font-size: 10.5px;
		color: var(--sig-text-muted);
		margin: -8px 0 0 0;
		opacity: 0.8;
	}

	.key-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-body);
		font-size: 11px;
		margin: 0;
	}
	.key-status--ok {
		color: #4ade80;
	}
	.key-status--unsure {
		color: #fbbf24;
	}

	.key-actions {
		display: flex;
		gap: 8px;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		font-family: var(--font-body);
		font-size: 11.5px;
		font-weight: 500;
		padding: 7px 14px;
		border-radius: 8px;
		cursor: pointer;
		border: 1px solid transparent;
		transition: background 0.12s, border-color 0.12s, opacity 0.12s;
	}
	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.btn--primary {
		background: var(--sig-accent);
		color: var(--sig-bg);
	}
	.btn--primary:not(:disabled):hover {
		opacity: 0.9;
	}
	.btn--secondary {
		background: var(--sig-surface-raised);
		color: var(--sig-text);
		border-color: var(--sig-border-strong);
	}
	.btn--ghost {
		background: transparent;
		color: var(--sig-text-muted);
		border-color: var(--sig-border);
	}
	.btn--ghost:not(:disabled):hover {
		color: var(--sig-text);
		background: var(--sig-surface-raised);
	}
	.btn.danger {
		color: #f87171;
		border-color: rgba(248, 113, 113, 0.3);
	}
	.btn.danger:hover {
		background: rgba(248, 113, 113, 0.1);
	}

	.auth-link,
	.auth-link:visited {
		text-decoration: none;
		align-self: flex-start;
	}

	.waiting {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-body);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.waiting-block,
	.success-block,
	.error-block {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 16px 0;
		text-align: center;
	}
	.waiting-block p,
	.success-block p {
		font-family: var(--font-body);
		font-size: 12px;
		color: var(--sig-text-muted);
		margin: 0;
	}
	.success-block {
		color: #4ade80;
	}

	.device-block,
	.auth-block,
	.prompt-block {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.device-code {
		font-family: var(--font-mono);
		font-size: 22px;
		font-weight: 700;
		letter-spacing: 0.18em;
		text-align: center;
		padding: 14px;
		border: 1px dashed var(--sig-border-strong);
		border-radius: 9px;
		background: var(--sig-bg);
		color: var(--sig-text);
		user-select: all;
	}

	.prompt-message {
		font-family: var(--font-body);
		font-size: 12px;
		color: var(--sig-text);
		margin: 0;
	}
	.option-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.option-card {
		text-align: left;
		padding: 10px 12px;
		border: 1px solid var(--sig-border);
		border-radius: 8px;
		background: var(--sig-bg);
		color: var(--sig-text);
		font-family: var(--font-body);
		font-size: 12px;
		cursor: pointer;
	}
	.option-card:hover {
		border-color: var(--sig-accent);
		background: var(--sig-surface-raised);
	}

	.link-btn {
		align-self: flex-start;
		background: none;
		border: none;
		color: var(--sig-text-muted);
		font-family: var(--font-body);
		font-size: 11px;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}
	.link-btn:hover {
		color: var(--sig-text);
	}

	.progress-note {
		font-family: var(--font-body);
		font-size: 11px;
		color: var(--sig-text-muted);
		margin: 0;
		opacity: 0.7;
	}

	.error-block {
		color: #f87171;
	}
	.error-message {
		font-family: var(--font-body);
		font-size: 12px;
		color: var(--sig-text);
		margin: 0;
		word-break: break-word;
	}
	.error-actions {
		display: flex;
		gap: 8px;
	}

	.manage-block {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--sig-border);
		align-items: flex-start;
	}
	.manage-note {
		font-family: var(--font-body);
		font-size: 11px;
		color: var(--sig-text-muted);
		margin: 0;
	}

	:global(.spin) {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>

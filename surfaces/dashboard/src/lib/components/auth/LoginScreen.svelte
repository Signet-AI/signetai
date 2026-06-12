<script lang="ts">
import { loginWithPassword, type AuthProviderInfo } from "$lib/api";
import { setDashboardAuthToken } from "$lib/auth";

interface Props {
	providers: readonly AuthProviderInfo[];
	onauthenticated?: () => void;
}

let { providers, onauthenticated }: Props = $props();

let username = $state("admin");
let password = $state("");
let loading = $state(false);
let error = $state<string | null>(null);

const passwordProvider = $derived(providers.find((provider) => provider.id === "password"));
const ssoProvider = $derived(providers.find((provider) => provider.id === "sso"));
const samlProvider = $derived(providers.find((provider) => provider.id === "saml"));

$effect(() => {
	if (passwordProvider?.username && username === "admin") username = passwordProvider.username;
});

async function submit(): Promise<void> {
	if (loading) return;
	loading = true;
	error = null;
	const result = await loginWithPassword(username.trim(), password);
	loading = false;
	if (!result.ok || !result.token || !result.expiresAt) {
		error = result.error ?? "Login failed";
		return;
	}
	setDashboardAuthToken(result.token, result.expiresAt);
	onauthenticated?.();
}
</script>

<div class="login-shell">
	<section class="login-card" aria-labelledby="signet-login-title">
		<div class="login-mark">◈</div>
		<p class="login-eyebrow">Signet admin</p>
		<h1 id="signet-login-title">Sign in to the dashboard</h1>
		<p class="login-copy">Use the configured admin username and password. SSO and SAML entry points are reserved for future providers.</p>

		<form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
			<label>
				<span>Username</span>
				<input bind:value={username} autocomplete="username" spellcheck="false" disabled={loading || !passwordProvider?.enabled} />
			</label>
			<label>
				<span>Password</span>
				<input bind:value={password} type="password" autocomplete="current-password" disabled={loading || !passwordProvider?.enabled} />
			</label>
			{#if error}<p class="login-error">{error}</p>{/if}
			{#if !passwordProvider?.enabled}<p class="login-error">Password login is not configured on this daemon.</p>{/if}
			<button type="submit" disabled={loading || !passwordProvider?.enabled}>{loading ? "Signing in…" : "Sign in"}</button>
		</form>

		<div class="future-providers" aria-label="Future login providers">
			<a class:disabled={!ssoProvider?.enabled} href={ssoProvider?.startPath ?? "/api/auth/sso/start"}>SSO</a>
			<a class:disabled={!samlProvider?.enabled} href={samlProvider?.startPath ?? "/api/auth/saml/start"}>SAML</a>
		</div>
	</section>
</div>

<style>
	.login-shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 24px;
		background:
			radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--sig-highlight) 18%, transparent), transparent 36rem),
			var(--sig-bg);
		color: var(--sig-text-bright);
	}

	.login-card {
		width: min(420px, 100%);
		border: 1px solid var(--sig-border-strong);
		background: color-mix(in srgb, var(--sig-surface-raised) 92%, transparent);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.36);
		padding: 32px;
	}

	.login-mark {
		font-size: 28px;
		color: var(--sig-highlight);
		text-shadow: 0 0 18px color-mix(in srgb, var(--sig-highlight) 60%, transparent);
	}

	.login-eyebrow,
	label span,
	.future-providers {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	h1 {
		margin: 8px 0 10px;
		font-size: clamp(28px, 5vw, 40px);
		line-height: 0.95;
		letter-spacing: -0.04em;
	}

	.login-copy {
		margin: 0 0 24px;
		color: var(--sig-text-muted);
		line-height: 1.5;
	}

	form {
		display: grid;
		gap: 14px;
	}

	label {
		display: grid;
		gap: 7px;
	}

	input {
		width: 100%;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		color: var(--sig-text-bright);
		padding: 12px 13px;
		font: inherit;
		outline: none;
	}

	input:focus {
		border-color: var(--sig-highlight);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--sig-highlight) 22%, transparent);
	}

	button {
		margin-top: 4px;
		border: 1px solid var(--sig-highlight);
		background: var(--sig-highlight);
		color: var(--sig-bg);
		font-weight: 700;
		padding: 12px 16px;
		cursor: pointer;
	}

	button:disabled,
	input:disabled,
	.disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.login-error {
		margin: 0;
		color: var(--sig-danger, #ff6b6b);
		font-size: 13px;
	}

	.future-providers {
		display: flex;
		gap: 10px;
		margin-top: 20px;
	}

	.future-providers a {
		color: var(--sig-text-muted);
		text-decoration: none;
		border: 1px solid var(--sig-border);
		padding: 7px 10px;
	}
</style>

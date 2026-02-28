<script lang="ts">
import { marked } from "marked";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { sk, doInstall, doUninstall, closeDetail } from "$lib/stores/skills.svelte";
import { toast } from "$lib/stores/toast.svelte";
import { computeTrustProfile } from "$lib/skills/risk-profile";

let open = $derived(sk.detailOpen);

let isInstalled = $derived(
	sk.selectedName
		? sk.installed.some((s) => s.name === sk.selectedName)
		: false,
);

function handleOpenChange(value: boolean) {
	if (!value) closeDetail();
}

let renderedContent = $derived.by(() => {
	if (!sk.detailContent) return "";
	const content = sk.detailContent.replace(/^---[\s\S]*?---\n*/, "");
	return marked.parse(content, { async: false }) as string;
});

let copied = $state(false);
async function copyInstallCommand() {
	const name = sk.selectedName;
	if (!name) return;
	try {
		await navigator.clipboard.writeText(`npx skills add ${name}`);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	} catch {
		toast("Copy failed", "error");
	}
}

function formatStat(n: number | undefined): string {
	if (n === undefined) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

let providerUrl = $derived.by(() => {
	const src = sk.detailSource;
	if (!src?.provider) return null;
	if (src.provider === "clawhub") return `https://clawhub.ai/skills/${src.name}`;
	return `https://skills.sh`;
});

let trustProfile = $derived.by(() => {
	const source = sk.detailSource;
	const meta = sk.detailMeta;
	if (!source && !meta) return null;
	const item = { ...(source ?? {}), ...(meta ?? {}) };
	return computeTrustProfile(item, sk.installed.map((s) => s.name));
});
</script>

<Sheet.Root bind:open onOpenChange={handleOpenChange}>
	<Sheet.Content
		side="right"
		class="!w-[520px] !max-w-[90vw] !bg-[var(--sig-surface)]
			!border-l !border-l-[var(--sig-border)] !p-0 flex flex-col"
	>
		{#if sk.detailLoading}
			<div class="flex-1 flex items-center justify-center">
				<span class="text-[var(--sig-text-muted)] text-[12px]">
					Loading...
				</span>
			</div>
		{:else}
			<!-- Header -->
			<div class="px-5 pt-5 pb-4 border-b border-[var(--sig-border)]">
				<div class="flex items-start justify-between gap-4">
					<div class="flex flex-col gap-1 min-w-0">
						<h2 class="detail-title">{sk.selectedName}</h2>
						<div class="flex items-center gap-2 flex-wrap">
							{#if sk.detailSource?.provider}
								<span
									class="provider-badge"
									class:clawhub={sk.detailSource.provider === "clawhub"}
								>
									{sk.detailSource.provider}
								</span>
							{/if}
							{#if sk.detailMeta}
								{#if sk.detailMeta.user_invocable}
									<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">
										/{sk.detailMeta.name}
									</Badge>
								{/if}
								{#if sk.detailMeta.builtin}
									<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">Built-in</Badge>
								{/if}
								{#if sk.detailMeta.arg_hint}
									<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-border-strong)] text-[var(--sig-text-muted)]">
										{sk.detailMeta.arg_hint}
									</Badge>
								{/if}
							{/if}
						</div>
					</div>

					<!-- Action button -->
					<div class="shrink-0">
						{#if sk.detailMeta?.builtin}
							<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-border-strong)] text-[var(--sig-text-muted)]">System</Badge>
						{:else if isInstalled}
							<Button
								variant="outline"
								size="sm"
								class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
								onclick={() => sk.detailMeta && doUninstall(sk.detailMeta.name)}
								disabled={sk.uninstalling === sk.detailMeta?.name}
							>
								{sk.uninstalling === sk.detailMeta?.name ? "..." : "Uninstall"}
							</Button>
						{:else}
							<Button
								variant="outline"
								size="sm"
								class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
								onclick={() => sk.selectedName && doInstall(sk.selectedName)}
								disabled={sk.installing === sk.selectedName}
							>
								{sk.installing === sk.selectedName ? "..." : "Install"}
							</Button>
						{/if}
					</div>
				</div>

				<!-- Stats row -->
				{#if sk.detailSource}
					<div class="detail-stats">
						{#if sk.detailSource.downloads !== undefined}
							<span class="detail-stat">
								<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
									<path d="M8 12L3 7h3V1h4v6h3L8 12zM2 14h12v1H2v-1z"/>
								</svg>
								{formatStat(sk.detailSource.downloads)} downloads
							</span>
						{/if}
						{#if sk.detailSource.stars !== undefined && sk.detailSource.stars > 0}
							<span class="detail-stat">
								<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
									<path d="M8 0L10 5.5L16 6L11.5 10L13 16L8 12.5L3 16L4.5 10L0 6L6 5.5L8 0Z"/>
								</svg>
								{formatStat(sk.detailSource.stars)} stars
							</span>
						{/if}
						{#if sk.detailSource.versions !== undefined && sk.detailSource.versions > 0}
							<span class="detail-stat">
								{sk.detailSource.versions} version{sk.detailSource.versions !== 1 ? "s" : ""}
							</span>
						{/if}
						{#if sk.detailSource.maintainer || sk.detailSource.author}
							<span class="detail-stat">
								by {sk.detailSource.maintainer ?? sk.detailSource.author}
							</span>
						{/if}
					</div>
				{/if}

				{#if trustProfile}
					<div class="trust-card">
						<div class="trust-head">Trust profile before install</div>
						<div class="trust-grid">
							<div>
								<span class="trust-label">Compatibility</span>
								<span class="trust-value">{trustProfile.compatibilityScore}%</span>
							</div>
							<div>
								<span class="trust-label">Security confidence</span>
								<span class="trust-value">{trustProfile.securityConfidence}%</span>
							</div>
							<div>
								<span class="trust-label">Verified</span>
								<span class="trust-value">{trustProfile.verified}</span>
							</div>
							<div>
								<span class="trust-label">Maintainer</span>
								<span class="trust-value">{trustProfile.maintainer}</span>
							</div>
							<div>
								<span class="trust-label">Permissions</span>
								<span class="trust-value">{trustProfile.permissionFootprint}</span>
							</div>
						</div>
						<p class="trust-reason">
							Compatibility: {trustProfile.compatibilityReason}
						</p>
						<p class="trust-reason">
							Security: {trustProfile.securityReason}
						</p>
					</div>
				{/if}

				<!-- Install command -->
				<button
					type="button"
					class="detail-cmd"
					onclick={copyInstallCommand}
					title="Click to copy"
				>
					<span class="opacity-50">$</span>
					npx skills add {sk.selectedName}
					<span class="detail-cmd-hint">
						{copied ? "copied!" : "click to copy"}
					</span>
				</button>

				<!-- Provider link -->
				{#if providerUrl}
					<a
						href={providerUrl}
						target="_blank"
						rel="noopener"
						class="detail-provider-link"
					>
						View on {sk.detailSource?.provider} &rarr;
					</a>
				{/if}
			</div>

			<!-- Body -->
			<div class="flex-1 overflow-y-auto px-5 py-4">
				{#if renderedContent}
					<div class="skill-markdown">
						{@html renderedContent}
					</div>
				{:else if sk.detailMeta?.description}
					<p class="text-[12px] text-[var(--sig-text)] leading-[1.6]">
						{sk.detailMeta.description}
					</p>
				{:else if sk.detailSource?.description}
					<p class="text-[12px] text-[var(--sig-text)] leading-[1.6]">
						{sk.detailSource.description}
					</p>
				{:else}
					<p class="text-[12px] text-[var(--sig-text-muted)]">
						No documentation available.
					</p>
				{/if}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<style>
	.detail-title {
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 700;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.provider-badge {
		font-family: var(--font-mono);
		font-size: 9px;
		padding: 1px 5px;
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.provider-badge.clawhub {
		border-color: var(--sig-accent);
		color: var(--sig-accent);
	}

	.detail-stats {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 10px;
		flex-wrap: wrap;
	}

	.detail-stat {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.detail-cmd {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		text-align: left;
		margin-top: 12px;
		padding: 6px 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.detail-cmd:hover {
		border-color: var(--sig-accent);
	}
	.detail-cmd-hint {
		margin-left: auto;
		font-size: 9px;
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.detail-provider-link {
		display: inline-block;
		margin-top: 8px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		text-decoration: none;
	}
	.detail-provider-link:hover {
		text-decoration: underline;
	}

	.trust-card {
		margin-top: 12px;
		padding: 10px;
		border: 1px solid var(--sig-border-strong);
		background: var(--sig-bg);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.trust-head {
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sig-text-bright);
	}

	.trust-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}

	.trust-label {
		display: block;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sig-text-muted);
	}

	.trust-value {
		display: block;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		margin-top: 2px;
	}

	.trust-reason {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.45;
		color: var(--sig-text-muted);
	}

	:global(.skill-markdown) {
		font-size: 12px;
		line-height: 1.7;
		color: var(--sig-text);
	}
	:global(.skill-markdown h1),
	:global(.skill-markdown h2),
	:global(.skill-markdown h3) {
		font-family: var(--font-display);
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: 1.5em;
		margin-bottom: 0.5em;
	}
	:global(.skill-markdown h1) { font-size: 14px; }
	:global(.skill-markdown h2) { font-size: 13px; }
	:global(.skill-markdown h3) { font-size: 12px; }
	:global(.skill-markdown p) {
		margin: 0.5em 0;
	}
	:global(.skill-markdown code) {
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--sig-bg);
		padding: 2px 5px;
		border: 1px solid var(--sig-border);
	}
	:global(.skill-markdown pre) {
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		padding: var(--space-sm);
		overflow-x: auto;
		margin: 0.75em 0;
	}
	:global(.skill-markdown pre code) {
		background: none;
		border: none;
		padding: 0;
	}
	:global(.skill-markdown ul),
	:global(.skill-markdown ol) {
		padding-left: 1.5em;
		margin: 0.5em 0;
	}
	:global(.skill-markdown li) {
		margin: 0.25em 0;
	}
	:global(.skill-markdown a) {
		color: var(--sig-accent);
		text-decoration: none;
	}
	:global(.skill-markdown a:hover) {
		text-decoration: underline;
	}
</style>

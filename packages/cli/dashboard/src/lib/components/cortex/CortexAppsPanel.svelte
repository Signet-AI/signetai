<script lang="ts">
	import { onMount } from "svelte";
	import { SvelteSet } from "svelte/reactivity";
	import {
		fetchMarketplaceMcpInstalled,
		mcpMarket,
		removeMarketplaceMcpServer,
		refreshMarketplaceMcpTools,
	} from "$lib/stores/marketplace-mcp.svelte";
	import { getMonogram, getMonogramBg, getAvatarFromSource } from "$lib/card-utils";
	import { Button } from "$lib/components/ui/button/index.js";
	import RefreshCw from "@lucide/svelte/icons/refresh-cw";
	import Server from "@lucide/svelte/icons/server";

	let refreshing = $state(false);
	const avatarErrors = new SvelteSet<string>();

	$effect(() => { mcpMarket.installed; avatarErrors.clear(); });

	onMount(() => {
		fetchMarketplaceMcpInstalled();
		refreshMarketplaceMcpTools();
	});

	async function refresh(): Promise<void> {
		refreshing = true;
		await fetchMarketplaceMcpInstalled();
		await refreshMarketplaceMcpTools();
		refreshing = false;
	}

</script>

<div class="apps-panel">
	<div class="apps-header">
		<div class="apps-title">
			<Server class="size-3.5" style="color: var(--sig-text-muted)" />
			<span class="sig-eyebrow">Installed Tool Servers</span>
			<span class="apps-count">{mcpMarket.installed.length}</span>
		</div>
		<button
			class="apps-refresh"
			onclick={refresh}
			disabled={refreshing}
			title="Refresh"
		>
			<RefreshCw class={`size-3${refreshing ? " spinning" : ""}`} />
		</button>
	</div>

	{#if mcpMarket.loadingInstalled}
		<div class="apps-empty">Loading installed tool servers...</div>
	{:else if mcpMarket.installedError}
		<div class="apps-error">{mcpMarket.installedError}</div>
	{:else if mcpMarket.installed.length === 0}
		<div class="apps-empty">No tool servers installed yet.</div>
	{:else}
		<div class="apps-flow">
			{#each mcpMarket.installed as server (server.id)}
				{@const avatar = getAvatarFromSource(server.source, server.catalogId)}
				<div class="app-card">
					<div class="app-icon" style={`background: ${avatar && !avatarErrors.has(server.id) ? 'transparent' : getMonogramBg(server.name)};`}>
						{#if avatar && !avatarErrors.has(server.id)}
							<img
								src={avatar}
								alt={server.name}
								class="app-avatar"
								onerror={() => { avatarErrors.add(server.id); }}
							/>
						{:else}
							{getMonogram(server.name)}
						{/if}
					</div>
					<div class="app-info">
						<span class="app-name">{server.name}</span>
						<span class="app-desc">{server.description || server.id}</span>
					</div>
					<div class="app-badges">
						<span class="app-badge app-badge--installed">installed</span>
						<span class="app-badge">{server.config.transport}</span>
					</div>
					<div class="app-actions">
						<Button
							variant="outline"
							size="sm"
							class="h-auto rounded-md font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-0.5 border-[var(--sig-border)] text-[var(--sig-text-muted)] transition-all duration-150 hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-danger)]"
							onclick={(e: MouseEvent) => {
								e.stopPropagation();
								void removeMarketplaceMcpServer(server.id);
							}}
							disabled={mcpMarket.removingId === server.id}
						>
							{mcpMarket.removingId === server.id ? "..." : "Remove"}
						</Button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.apps-panel {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: var(--space-md);
		gap: var(--space-md);
	}

	.apps-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-shrink: 0;
	}

	.apps-title {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.apps-count {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		padding: 0 5px;
		border-radius: 4px;
		line-height: 1.6;
	}

	.apps-refresh {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
		border-radius: 6px;
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.apps-refresh:hover {
		color: var(--sig-text-bright);
		border-color: var(--sig-border-strong);
	}

	.apps-empty,
	.apps-error {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.apps-empty {
		color: var(--sig-text-muted);
	}

	.apps-error {
		color: var(--sig-danger);
	}

	/* Floating card layout — no rigid grid snap */
	.apps-flow {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		align-content: flex-start;
	}

	.app-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		width: 280px;
		padding: 12px 14px;
		background: var(--sig-surface);
		border: 1px solid transparent;
		border-radius: 10px;
		transition:
			background var(--dur) var(--ease),
			border-color var(--dur) var(--ease),
			box-shadow var(--dur) var(--ease);
		text-align: left;
		color: inherit;
		font: inherit;
	}

	.app-card:hover {
		background: var(--sig-surface-raised);
		border-color: var(--sig-border);
		box-shadow:
			0 2px 8px rgba(0, 0, 0, 0.3),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}

	:root[data-theme="light"] .app-card:hover {
		box-shadow:
			0 2px 8px rgba(0, 0, 0, 0.08),
			inset 0 1px 0 rgba(255, 255, 255, 0.6);
	}

	.app-card:focus-visible {
		outline: 2px solid var(--sig-highlight);
		outline-offset: 1px;
	}

	.app-icon {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		display: grid;
		place-items: center;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.06em;
		color: var(--sig-icon-fg);
		text-transform: uppercase;
		flex-shrink: 0;
		overflow: hidden;
	}

	.app-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.app-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.app-name {
		font-family: var(--font-display);
		font-size: 12px;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.app-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.45;
		color: var(--sig-text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.app-badges {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.app-badge {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		padding: 1px 6px;
		border-radius: 4px;
		line-height: 1.4;
	}

	.app-badge--installed {
		color: var(--sig-success);
		border-color: color-mix(in srgb, var(--sig-success) 40%, var(--sig-border));
	}

	.app-actions {
		display: flex;
		margin-top: auto;
		padding-top: 4px;
	}

	:global(.spinning) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
</style>

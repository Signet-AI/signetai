<script lang="ts">
import type { MarketplaceMcpCatalogEntry } from "$lib/api";
import McpInstallSheet from "$lib/components/marketplace/McpInstallSheet.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import {
	type McpCatalogSort,
	type McpCatalogSourceFilter,
	fetchMarketplaceMcpCatalog,
	fetchMarketplaceMcpInstalled,
	getFilteredMarketplaceMcpCatalog,
	getMarketplaceMcpCategoryOptions,
	getMarketplaceMcpSourceOptions,
	mcpMarket,
	refreshMarketplaceMcpTools,
	removeMarketplaceMcpServer,
	toggleMarketplaceMcpServer,
} from "$lib/stores/marketplace-mcp.svelte";
import { onMount } from "svelte";

interface Props {
	embedded?: boolean;
}

const { embedded = false }: Props = $props();

const filteredCatalog = $derived(getFilteredMarketplaceMcpCatalog());
const categories = $derived(getMarketplaceMcpCategoryOptions());
const sourceOptions = $derived(getMarketplaceMcpSourceOptions());
const installedCatalogIds = $derived(
	new Set(mcpMarket.installed.flatMap((s) => (s.catalogId ? [`${s.source}:${s.catalogId}`] : []))),
);
const healthByServer = $derived(new Map(mcpMarket.serverHealth.map((h) => [h.serverId, h])));
let installSheetOpen = $state(false);
let selectedCatalogEntry = $state<MarketplaceMcpCatalogEntry | null>(null);
const activeCategoryLabel = $derived(mcpMarket.category === "all" ? "All categories" : mcpMarket.category);
const activeSourceLabel = $derived(mcpMarket.source === "all" ? "All sources" : formatSourceLabel(mcpMarket.source));
const activeSortLabel = $derived.by(() => {
	if (mcpMarket.sortBy === "name") return "Name";
	if (mcpMarket.sortBy === "official") return "Official";
	return "Popularity";
});
const installedPanelHint = $derived(
	mcpMarket.loadingInstalled
		? "Loading installed tool servers..."
		: mcpMarket.installedError
			? `Failed to load installed servers: ${mcpMarket.installedError}`
			: "No Tool Servers installed yet.",
);

onMount(() => {
	fetchMarketplaceMcpInstalled();
	fetchMarketplaceMcpCatalog(5);
	refreshMarketplaceMcpTools();
});

function formatSourceLabel(source: string): string {
	if (source === "modelcontextprotocol/servers") {
		return "MCP GitHub";
	}
	if (source === "mcpservers.org") {
		return "MCP Registry";
	}
	return source;
}

function parseSort(value: string): McpCatalogSort {
	if (value === "name" || value === "official") {
		return value;
	}
	return "popularity";
}

function parseSource(value: string): McpCatalogSourceFilter {
	if (value === "mcpservers.org" || value === "modelcontextprotocol/servers") {
		return value;
	}
	return "all";
}

function parseCategory(value: string): string {
	if (value === "all") return "all";
	return categories.includes(value) ? value : "all";
}

function openInstallSheet(entry: MarketplaceMcpCatalogEntry): void {
	selectedCatalogEntry = entry;
	installSheetOpen = true;
}

function closeInstallSheet(): void {
	installSheetOpen = false;
	selectedCatalogEntry = null;
}
</script>

<div class="h-full flex flex-col overflow-hidden">
	<div
		class="shrink-0 px-[var(--space-md)] py-[var(--space-sm)]
			border-b border-[var(--sig-border)] flex items-center gap-2 flex-wrap"
	>
		{#if !embedded}
			<input
				type="text"
				class="search-input"
				placeholder="Search tool servers..."
				value={mcpMarket.query}
				oninput={(e) => {
					mcpMarket.query = e.currentTarget.value;
				}}
			/>
		{/if}

		<Select.Root type="single" value={mcpMarket.category} onValueChange={(v) => { mcpMarket.category = parseCategory(v ?? "all"); }}>
			<Select.Trigger class="select-trigger">{activeCategoryLabel}</Select.Trigger>
			<Select.Content class="select-content">
				{#each categories as category}
					<Select.Item value={category} label={category} class="select-item" />
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root type="single" value={mcpMarket.source} onValueChange={(v) => { mcpMarket.source = parseSource(v ?? "all"); }}>
			<Select.Trigger class="select-trigger">{activeSourceLabel}</Select.Trigger>
			<Select.Content class="select-content">
				{#each sourceOptions as source}
					<Select.Item
						value={source}
						label={source === "all" ? "All sources" : formatSourceLabel(source)}
						class="select-item"
					/>
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root type="single" value={mcpMarket.sortBy} onValueChange={(v) => { mcpMarket.sortBy = parseSort(v ?? "popularity"); }}>
			<Select.Trigger class="select-trigger">{activeSortLabel}</Select.Trigger>
			<Select.Content class="select-content">
				<Select.Item value="popularity" label="Popularity" class="select-item" />
				<Select.Item value="official" label="Official" class="select-item" />
				<Select.Item value="name" label="Name" class="select-item" />
			</Select.Content>
		</Select.Root>

		<Button
			variant="outline"
			size="sm"
			class="h-7 text-[10px] font-[family-name:var(--font-mono)]"
			onclick={() => refreshMarketplaceMcpTools(true)}
			disabled={mcpMarket.toolsLoading}
		>
			{mcpMarket.toolsLoading ? "Refreshing..." : "Refresh routed tools"}
		</Button>
	</div>

	<div class="flex-1 overflow-y-auto p-[var(--space-sm)] flex flex-col gap-[var(--space-sm)]">
		<section class="panel">
			<div class="panel-head">
				<span>Installed Tool Servers ({mcpMarket.installed.length})</span>
				<span>{mcpMarket.tools.length} routed tools</span>
			</div>
			{#if mcpMarket.toolsError}
				<div class="panel-alert">Tool routing refresh failed: {mcpMarket.toolsError}</div>
			{/if}
			{#if mcpMarket.installed.length === 0}
				<div class="panel-empty">
					{installedPanelHint}
					{#if !mcpMarket.loadingInstalled && !mcpMarket.installedError}
						<span class="panel-empty-hint">Install one from the catalog below to route tools.</span>
					{/if}
				</div>
			{:else}
				<div class="installed-list">
					{#each mcpMarket.installed as server (server.id)}
						<div class="installed-row">
							<div class="installed-main">
								<div class="installed-name">{server.name}</div>
								<div class="installed-meta">
									<span>{server.id}</span>
									<span>&middot;</span>
									<span>{server.config.transport}</span>
									<span>&middot;</span>
									<span>{healthByServer.get(server.id)?.toolCount ?? 0} tools</span>
									{#if healthByServer.get(server.id)?.ok === false}
										<span class="text-[var(--sig-danger)]">offline</span>
									{/if}
								</div>
							</div>
							<div class="installed-actions">
								<Switch
									checked={server.enabled}
									onCheckedChange={(v: boolean) =>
										toggleMarketplaceMcpServer(server.id, v)}
									disabled={mcpMarket.togglingId === server.id}
									class="scale-75 origin-right"
								/>
								<Button
									variant="outline"
									size="sm"
									class="h-6 text-[9px]"
									onclick={() => removeMarketplaceMcpServer(server.id)}
									disabled={mcpMarket.removingId === server.id}
								>
									{mcpMarket.removingId === server.id ? "..." : "Remove"}
								</Button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<section class="panel">
			<div class="panel-head">
				<span>Discover Tool Servers (MCP)</span>
				<span>{filteredCatalog.length} shown{#if mcpMarket.catalogTotal > 0} / {mcpMarket.catalogTotal} total{/if}</span>
			</div>
			{#if mcpMarket.catalogError}
				<div class="panel-alert">Failed to load catalog: {mcpMarket.catalogError}</div>
			{/if}
			{#if mcpMarket.catalogLoading}
				<div class="panel-empty">Loading catalog...</div>
			{:else if filteredCatalog.length === 0}
				<div class="panel-empty">
					No matching Tool Servers.
					<button
						type="button"
						class="panel-reset"
						onclick={() => {
							mcpMarket.query = "";
							mcpMarket.category = "all";
							mcpMarket.source = "all";
						}}
					>
						Clear filters
					</button>
				</div>
			{:else}
				<div class="catalog-grid">
					{#each filteredCatalog as entry (entry.id)}
						<div class="catalog-card">
							<div class="catalog-name">{entry.name}</div>
							<div class="catalog-desc">{entry.description}</div>
							<div class="catalog-meta">
								<span>{formatSourceLabel(entry.source)}</span>
								<span>{entry.category}</span>
								{#if entry.official}
									<span class="text-[var(--sig-success)]">official</span>
								{/if}
								<span>#{entry.popularityRank}</span>
							</div>
							<div class="catalog-actions">
								<a href={entry.sourceUrl} target="_blank" rel="noopener" class="catalog-link">View</a>
								{#if installedCatalogIds.has(entry.id)}
									<Button variant="outline" size="sm" class="h-6 text-[9px]" disabled>
										Installed
									</Button>
								{:else}
									<Button
										variant="outline"
										size="sm"
										class="h-6 text-[9px]"
										onclick={() => openInstallSheet(entry)}
										disabled={mcpMarket.installingId === entry.id}
									>
										{mcpMarket.installingId === entry.id ? "..." : "Install"}
									</Button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</div>
</div>

<McpInstallSheet
	open={installSheetOpen}
	entry={selectedCatalogEntry}
	onclose={closeInstallSheet}
/>

<style>
	.search-input {
		flex: 1;
		min-width: 220px;
		font-family: var(--font-mono);
		font-size: 11px;
		padding: 6px 8px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-bright);
		outline: none;
	}
	.search-input:focus {
		border-color: var(--sig-accent);
	}

	:global(.select-trigger) {
		font-family: var(--font-mono);
		font-size: 10px;
		padding: 5px 8px;
		height: auto;
		min-height: 28px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-bright);
		border-radius: 0.5rem;
	}

	:global(.select-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	:global(.select-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.panel {
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
	}

	.panel-head {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--sig-border);
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	.panel-empty {
		padding: 14px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.panel-empty-hint {
		font-size: 10px;
	}

	.panel-alert {
		padding: 8px 10px;
		border-bottom: 1px solid var(--sig-border);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-danger);
		background: color-mix(in srgb, var(--sig-danger) 10%, transparent);
	}

	.panel-reset {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		border: none;
		background: transparent;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}

	.panel-reset:hover {
		text-decoration: underline;
	}

	.installed-list {
		display: flex;
		flex-direction: column;
	}

	.installed-row {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		padding: 9px 10px;
		border-bottom: 1px solid var(--sig-border);
	}
	.installed-row:last-child {
		border-bottom: none;
	}

	.installed-main {
		min-width: 0;
	}

	.installed-name {
		font-family: var(--font-display);
		font-size: 12px;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.installed-meta {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.installed-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.catalog-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 8px;
		padding: 8px;
	}

	.catalog-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 9px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
	}

	.catalog-name {
		font-family: var(--font-display);
		font-size: 12px;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.catalog-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.45;
		color: var(--sig-text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
		min-height: 56px;
	}

	.catalog-meta {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.catalog-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: auto;
	}

	.catalog-link {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		text-decoration: none;
	}
	.catalog-link:hover {
		text-decoration: underline;
	}
</style>

<script lang="ts">
import type { MarketplaceMcpCatalogEntry, MarketplaceMcpServer } from "$lib/api";
import { getAvatarFromSource, getAvatarUrl, getMonogram, getMonogramBg } from "$lib/card-utils";
import McpDetailSheet from "$lib/components/marketplace/McpDetailSheet.svelte";
import McpInstallSheet from "$lib/components/marketplace/McpInstallSheet.svelte";
import McpUsagePanel from "$lib/components/marketplace/McpUsagePanel.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import {
	type McpCatalogSort,
	type McpCatalogSourceFilter,
	fetchMarketplaceMcpCatalog,
	fetchMarketplaceMcpInstalled,
	getFilteredMarketplaceMcpCatalog,
	getMarketplaceMcpSourceOptions,
	mcpMarket,
	refreshMarketplaceMcpTools,
	removeMarketplaceMcpServer,
} from "$lib/stores/marketplace-mcp.svelte";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";

interface Props {
	embedded?: boolean;
	showViewTabs?: boolean;
	currentView?: "browse" | "installed";
	onviewchange?: (view: "browse" | "installed") => void;
	onreviewrequest?: (payload: {
		targetType: "mcp";
		targetId: string;
		targetLabel: string;
	}) => void | Promise<void>;
}

const { embedded = false, showViewTabs = true, currentView = "browse", onviewchange }: Props = $props();

interface McpDetailItem {
	targetId: string;
	name: string;
	description: string;
	category: string;
	sourceLabel: string;
	official: boolean;
	popularityRank: number | null;
	sourceUrl: string;
	catalogEntry: MarketplaceMcpCatalogEntry | null;
	serverId: string | null;
}

const filteredCatalog = $derived(getFilteredMarketplaceMcpCatalog());
const sourceOptions = $derived(getMarketplaceMcpSourceOptions());

const MCP_PAGE_SIZE = 60;
let visibleCount = $state(MCP_PAGE_SIZE);
// Reset pagination and avatar errors when filters or installed list change
$effect(() => {
	filteredCatalog;
	visibleCount = MCP_PAGE_SIZE;
	catalogAvatarErrors.clear();
});
$effect(() => {
	mcpMarket.installed;
	installedAvatarErrors.clear();
});
const visibleCatalog = $derived(filteredCatalog.slice(0, visibleCount));
const hasMore = $derived(visibleCount < filteredCatalog.length);
const remaining = $derived(filteredCatalog.length - visibleCount);
const installedCatalogIds = $derived(
	new Set(mcpMarket.installed.flatMap((s) => (s.catalogId ? [`${s.source}:${s.catalogId}`] : []))),
);
const installedServerByCatalogId = $derived(
	new Map<string, string>(
		mcpMarket.installed.flatMap((s) => (s.catalogId ? [[`${s.source}:${s.catalogId}`, s.id] as [string, string]] : [])),
	),
);
const catalogById = $derived(
	new Map<string, MarketplaceMcpCatalogEntry>(mcpMarket.catalog.map((entry) => [entry.id, entry])),
);
let installSheetOpen = $state(false);
let selectedCatalogEntry = $state<MarketplaceMcpCatalogEntry | null>(null);
let detailOpen = $state(false);
let detailItem = $state<McpDetailItem | null>(null);
let view = $state<"browse" | "installed">("browse");
// Enabled as part of MCP CLI bridge — install UI is now functional
const MCP_INSTALLS_ENABLED = true;
const activeSourceLabel = $derived(mcpMarket.source === "all" ? "All sources" : formatSourceLabel(mcpMarket.source));
const activeSortLabel = $derived.by(() => {
	if (mcpMarket.sortBy === "name") return "Name";
	if (mcpMarket.sortBy === "official") return "Official";
	return "Popularity";
});
const displayMode = $derived<"installed" | "browse">(
	view === "installed" && !mcpMarket.query.trim() ? "installed" : "browse",
);

onMount(() => {
	fetchMarketplaceMcpInstalled();
	fetchMarketplaceMcpCatalog(5);
	refreshMarketplaceMcpTools();
});

function formatSourceLabel(source: string): string {
	if (source === "modelcontextprotocol/servers") return "MCP GitHub";
	if (source === "mcpservers.org") return "MCP Registry";
	if (source === "github") return "GitHub";
	return source;
}

function parseSort(value: string): McpCatalogSort {
	if (value === "name" || value === "official") {
		return value;
	}
	return "popularity";
}

function parseSource(value: string): McpCatalogSourceFilter {
	if (value === "mcpservers.org" || value === "modelcontextprotocol/servers" || value === "github") {
		return value;
	}
	return "all";
}

$effect(() => {
	view = currentView;
});

function parseView(value: string): "browse" | "installed" {
	return value === "installed" ? "installed" : "browse";
}

const installedAvatarErrors = new SvelteSet<string>();
const catalogAvatarErrors = new SvelteSet<string>();

function openInstallSheet(entry: MarketplaceMcpCatalogEntry): void {
	if (!MCP_INSTALLS_ENABLED) return;
	selectedCatalogEntry = entry;
	installSheetOpen = true;
}

function closeInstallSheet(): void {
	installSheetOpen = false;
	selectedCatalogEntry = null;
}

function mcpReviewTargetIdForInstalled(server: MarketplaceMcpServer): string {
	if (server.catalogId) {
		return `${server.source}:${server.catalogId}`;
	}
	const normalized = server.name.trim().toLowerCase().replace(/\s+/g, "-");
	return `${server.source}:${normalized}`;
}

function openCatalogDetail(entry: MarketplaceMcpCatalogEntry): void {
	detailItem = {
		targetId: entry.id,
		name: entry.name,
		description: entry.description,
		category: entry.category,
		sourceLabel: formatSourceLabel(entry.source),
		official: entry.official,
		popularityRank: entry.popularityRank,
		sourceUrl: entry.sourceUrl,
		catalogEntry: entry,
		serverId: installedServerByCatalogId.get(entry.id) ?? null,
	};
	detailOpen = true;
	mcpMarket.catalogDetail = true;
}

function openInstalledDetail(server: MarketplaceMcpServer): void {
	const catalogKey = server.catalogId ? `${server.source}:${server.catalogId}` : null;
	const catalogEntry = catalogKey ? (catalogById.get(catalogKey) ?? null) : null;
	detailItem = {
		targetId: catalogKey ?? mcpReviewTargetIdForInstalled(server),
		name: server.name,
		description: server.description || catalogEntry?.description || server.id,
		category: server.category || catalogEntry?.category || "general",
		sourceLabel: formatSourceLabel(server.source),
		official: server.official || catalogEntry?.official || false,
		popularityRank: catalogEntry?.popularityRank ?? null,
		sourceUrl: catalogEntry?.sourceUrl || server.homepage || "",
		catalogEntry,
		serverId: server.id,
	};
	detailOpen = true;
	mcpMarket.catalogDetail = true;
}

function closeDetailSheet(): void {
	detailOpen = false;
	mcpMarket.catalogDetail = false;
}

function onCatalogCardKeydown(event: KeyboardEvent, entry: MarketplaceMcpCatalogEntry): void {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	openCatalogDetail(entry);
}

function onInstalledCardKeydown(event: KeyboardEvent, server: MarketplaceMcpServer): void {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	openInstalledDetail(server);
}

function openInstallFromDetail(entry: MarketplaceMcpCatalogEntry): void {
	if (!MCP_INSTALLS_ENABLED) return;
	detailOpen = false;
	mcpMarket.catalogDetail = false;
	openInstallSheet(entry);
}

async function removeFromDetail(serverId: string): Promise<void> {
	await removeMarketplaceMcpServer(serverId);
	if (!detailItem || detailItem.serverId !== serverId) return;
	detailItem = { ...detailItem, serverId: null };
}
</script>

<div class="h-full flex flex-col overflow-hidden">
	<div
		class={`shrink-0 px-[var(--space-md)] py-[var(--space-sm)] flex items-center gap-2 flex-wrap ${
			embedded ? "" : "border-b border-[var(--sig-border)]"
		}`}
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

		{#if showViewTabs}
		<Tabs.Root
			value={view}
			onValueChange={(v) => {
				view = parseView(v ?? "browse");
				onviewchange?.(view);
			}}
		>
			<Tabs.List class="bg-transparent h-auto gap-0 rounded-none border-none">
				<Tabs.Trigger
					value="browse"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					Browse{mcpMarket.catalogTotal ? ` (${mcpMarket.catalogTotal.toLocaleString()})` : ""}
				</Tabs.Trigger>
				<Tabs.Trigger
					value="installed"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					Installed ({mcpMarket.installed.length})
				</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
		{/if}

		{#if !embedded}
		<div class="ml-auto flex items-center gap-2">
			<Select.Root type="single" value={mcpMarket.sortBy} onValueChange={(v) => { mcpMarket.sortBy = parseSort(v ?? "popularity"); }}>
				<Select.Trigger class="select-trigger">{activeSortLabel}</Select.Trigger>
				<Select.Content class="select-content">
					<Select.Item value="popularity" label="Popularity" class="select-item" />
					<Select.Item value="official" label="Official" class="select-item" />
					<Select.Item value="name" label="Name" class="select-item" />
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
		</div>
		{/if}
	</div>

	<div class="flex-1 overflow-y-auto px-[var(--space-sm)] pb-[var(--space-sm)] pt-0 flex flex-col gap-[var(--space-sm)]">
		{#if !MCP_INSTALLS_ENABLED && displayMode !== "installed"}
			<div class="panel-alert">
				MCP installation is temporarily disabled while we harden reliability.
			</div>
		{/if}
		{#if displayMode === "installed"}
			{#if mcpMarket.installed.length > 0}
				<McpUsagePanel />
			{/if}
			{#if mcpMarket.installed.length === 0}
				<div class="panel-empty">
					{mcpMarket.loadingInstalled
						? "Loading installed tool servers..."
						: mcpMarket.installedError
							? `Failed to load installed servers: ${mcpMarket.installedError}`
							: "No Tool Servers installed yet."}
				</div>
			{:else}
				<div class="catalog-grid">
					{#each mcpMarket.installed as server (server.id)}
						{@const sAvatar = getAvatarFromSource(server.source, server.catalogId)}
						<div
							class="catalog-card"
							role="button"
							tabindex="0"
							onclick={() => openInstalledDetail(server)}
							onkeydown={(event) => onInstalledCardKeydown(event, server)}
						>
							<div class="catalog-top">
								<div class="mcp-icon" style={`background: ${sAvatar && !installedAvatarErrors.has(server.id) ? 'transparent' : getMonogramBg(server.name)};`}>
									{#if sAvatar && !installedAvatarErrors.has(server.id)}
										<img src={sAvatar} alt={server.name} class="mcp-avatar" onerror={() => { installedAvatarErrors.add(server.id); }} />
									{:else}
										{getMonogram(server.name)}
									{/if}
								</div>
								<div class="catalog-name">{server.name}</div>
							</div>
							<div class="catalog-desc">{server.description || server.id}</div>
							<div class="catalog-meta">
								<span class="mcp-badge">installed</span>
								<span class="mcp-badge">{server.config.transport}</span>
							</div>
							<div class="catalog-actions">
								<Button
									variant="outline"
									size="sm"
									class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text)] transition-all duration-150 hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-danger)] hover:shadow-[0_0_12px_rgba(220,38,38,0.35)] hover:scale-[1.02]"
									onclick={(event: MouseEvent) => {
										event.stopPropagation();
										void removeMarketplaceMcpServer(server.id);
									}}
									disabled={mcpMarket.removingId === server.id}
								>
									{mcpMarket.removingId === server.id ? "..." : "REMOVE"}
								</Button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{:else if mcpMarket.catalogError}
			<div class="panel-alert">Failed to load catalog: {mcpMarket.catalogError}</div>
		{:else if mcpMarket.catalogLoading}
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
				{#each visibleCatalog as entry (entry.id)}
					{@const avatar = getAvatarUrl(entry.sourceUrl)}
					<div
						class="catalog-card"
						role="button"
						tabindex="0"
						onclick={() => openCatalogDetail(entry)}
						onkeydown={(event) => onCatalogCardKeydown(event, entry)}
					>
						<div class="catalog-top">
							<div class="mcp-icon" style={`background: ${avatar && !catalogAvatarErrors.has(entry.id) ? 'transparent' : getMonogramBg(entry.name)};`}>
								{#if avatar && !catalogAvatarErrors.has(entry.id)}
									<img src={avatar} alt={entry.name} class="mcp-avatar" onerror={() => { catalogAvatarErrors.add(entry.id); }} />
								{:else}
									{getMonogram(entry.name)}
								{/if}
							</div>
							<div class="catalog-name">{entry.name}</div>
						</div>
						<div class="catalog-desc">{entry.description}</div>
						<div class="catalog-meta">
							<span class="mcp-badge">{formatSourceLabel(entry.source)}</span>
							<span class="mcp-badge">{entry.category}</span>
							{#if entry.official}
								<span class="mcp-badge mcp-official">official</span>
							{/if}
							<span class="mcp-rank">#{entry.popularityRank}</span>
						</div>
						<div class="catalog-actions">
							{#if installedCatalogIds.has(entry.id)}
								<Button
									variant="outline"
									size="sm"
									class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text)] transition-all duration-150 hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-danger)] hover:shadow-[0_0_12px_rgba(220,38,38,0.35)] hover:scale-[1.02]"
									onclick={(event: MouseEvent) => {
										event.stopPropagation();
										const serverId = installedServerByCatalogId.get(entry.id);
										if (serverId) {
											void removeMarketplaceMcpServer(serverId);
										}
									}}
									disabled={!installedServerByCatalogId.get(entry.id)}
								>
									REMOVE
								</Button>
							{:else}
								<Button
									variant="outline"
									size="sm"
									class="flex-1 h-auto rounded-lg font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-border-strong)] text-[var(--sig-text)] transition-all duration-150 hover:bg-[var(--sig-surface-raised)] hover:text-[var(--sig-text-bright)] hover:border-[var(--sig-text-muted)] hover:shadow-[0_0_12px_rgba(255,255,255,0.1)] hover:scale-[1.02]"
									onclick={(event: MouseEvent) => {
										event.stopPropagation();
										openInstallSheet(entry);
									}}
									disabled={!MCP_INSTALLS_ENABLED || mcpMarket.installingId === entry.id}
								>
									{#if !MCP_INSTALLS_ENABLED}
										DISABLED
									{:else}
										{mcpMarket.installingId === entry.id ? "..." : "INSTALL"}
									{/if}
								</Button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
			{#if hasMore}
				<button
					type="button"
					class="show-more"
					onclick={() => (visibleCount += MCP_PAGE_SIZE)}
				>
					Show more ({remaining} remaining)
				</button>
			{/if}
		{/if}
	</div>
</div>

<McpInstallSheet
	open={installSheetOpen}
	entry={selectedCatalogEntry}
	onclose={closeInstallSheet}
/>

<McpDetailSheet
	open={detailOpen}
	item={detailItem}
	isInstalled={detailItem ? detailItem.serverId !== null : false}
	canReview={detailItem ? detailItem.serverId !== null : false}
	canInstall={MCP_INSTALLS_ENABLED}
	installBusy={detailItem?.catalogEntry ? mcpMarket.installingId === detailItem.catalogEntry.id : false}
	removeBusy={detailItem?.serverId ? mcpMarket.removingId === detailItem.serverId : false}
	onclose={closeDetailSheet}
	oninstall={openInstallFromDetail}
	onuninstall={(serverId) => {
		void removeFromDetail(serverId);
	}}
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
		transition: border-color 0.15s;
	}

	.search-input:hover {
		border-color: var(--sig-accent);
	}

	.search-input:focus {
		border-color: var(--sig-accent);
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
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
		transition: border-color 0.15s;
	}

	:global(.select-trigger:hover) {
		border-color: var(--sig-accent);
	}

	:global(.select-trigger:focus-visible) {
		outline: 2px solid var(--sig-accent);
		outline-offset: 1px;
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
		align-items: flex-start;
		gap: 10px;
		padding: 9px 10px;
		border-bottom: 1px solid var(--sig-border);
		background:
			radial-gradient(circle at 12% -24%, color-mix(in srgb, var(--sig-accent) 8%, transparent), transparent 52%),
			linear-gradient(220deg, color-mix(in srgb, var(--sig-surface-raised) 92%, black) 0%, var(--sig-surface) 72%);
	}
	.installed-row:last-child {
		border-bottom: none;
	}

	.installed-main {
		flex: 1;
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
		gap: var(--space-sm);
		background: transparent;
	}

	.catalog-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: var(--space-sm);
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
		border-radius: var(--radius);
		cursor: pointer;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
		min-height: 0;
		width: 100%;
		text-align: left;
	}

	.catalog-card:hover {
		border-color: var(--sig-border-strong);
		background: var(--sig-surface-raised);
	}

	.catalog-card:focus {
		border-color: var(--sig-highlight);
	}

	.catalog-card:focus-visible {
		outline: 2px solid var(--sig-highlight);
		outline-offset: 1px;
		border-color: var(--sig-highlight);
	}

	.catalog-top {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.catalog-name {
		font-family: var(--font-display);
		font-size: 12px;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.mcp-icon {
		width: 28px;
		height: 28px;
		border-radius: 0.45rem;
		border: 1px solid var(--sig-icon-border);
		display: grid;
		place-items: center;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.06em;
		color: var(--sig-icon-fg);
		text-transform: uppercase;
		flex-shrink: 0;
		overflow: hidden;
	}

	.mcp-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.catalog-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.45;
		color: var(--sig-text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
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

	.mcp-badge {
		border: 1px solid var(--sig-border-strong);
		padding: 1px 6px;
		line-height: 1.3;
	}

	.mcp-official {
		border-color: color-mix(in srgb, var(--sig-success) 70%, var(--sig-border-strong));
		color: var(--sig-success);
	}

	.mcp-rank {
		color: var(--sig-text-muted);
	}

	.catalog-actions {
		display: flex;
		justify-content: flex-start;
		align-items: center;
		gap: 6px;
		margin-top: auto;
	}

	.show-more {
		display: block;
		width: 100%;
		padding: var(--space-sm) var(--space-md);
		background: transparent;
		border: 1px dashed var(--sig-border);
		border-radius: 6px;
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
		margin-top: var(--space-sm);
	}

	.show-more:hover {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
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

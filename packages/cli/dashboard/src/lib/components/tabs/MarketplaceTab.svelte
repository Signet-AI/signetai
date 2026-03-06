<script lang="ts">
import McpServersTab from "$lib/components/marketplace/McpServersTab.svelte";
import SkillsTab from "$lib/components/tabs/SkillsTab.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Collapsible from "$lib/components/ui/collapsible/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import {
	fetchTargetReviews,
	loadMarketplaceReviewConfig,
	reviewsMarket,
	removeMarketplaceReview,
	saveMarketplaceReviewConfig,
	setReviewTarget,
	submitMarketplaceReview,
	syncMarketplaceReviewsNow,
} from "$lib/stores/marketplace-reviews.svelte";
import { toast } from "$lib/stores/toast.svelte";
import {
	fetchMarketplaceMcpCatalog,
	fetchMarketplaceMcpInstalled,
	refreshMarketplaceMcpTools,
	getMarketplaceMcpCategoryOptions,
	mcpMarket,
} from "$lib/stores/marketplace-mcp.svelte";
import {
	fetchCatalog,
	fetchInstalled,
	getCategoryOptions,
	setQuery,
	sk,
} from "$lib/stores/skills.svelte";
import { onMount } from "svelte";

let section = $state<"skills" | "mcp">("skills");
let sortOpen = $state(true);
let reviewSyncOpen = $state(false);
let refreshingSkills = $state(false);
let refreshingMcp = $state(false);
let refreshingTools = $state(false);
const MOBILE_RAIL_QUERY = "(max-width: 1120px)";

type SpotlightItem = {
	readonly title: string;
	readonly subtitle: string;
	readonly targetType: "skill" | "mcp";
	readonly targetId: string;
};

const activeQuery = $derived(section === "skills" ? sk.query : mcpMarket.query);
const activeSectionLabel = $derived(section === "skills" ? "Agent Skills" : "MCP Tool Servers");
const sectionCatalogCount = $derived(section === "skills" ? sk.catalogTotal : mcpMarket.catalogTotal);
const activeInstalledCount = $derived(section === "skills" ? sk.installed.length : mcpMarket.installed.length);

const skillsFirst = $derived(
	sk.catalog[0]
		? {
			title: sk.catalog[0].name,
			targetType: "skill" as const,
			targetId: sk.catalog[0].name,
		}
		: null,
);

const mcpFirst = $derived(
	mcpMarket.catalog[0]
		? {
			title: mcpMarket.catalog[0].name,
			targetType: "mcp" as const,
			targetId: mcpMarket.catalog[0].id,
		}
		: null,
);

const firstReviewTarget = $derived(section === "skills" ? skillsFirst : mcpFirst);

const categoryOptions = $derived.by(() => {
	if (section === "skills") {
		return getCategoryOptions();
	}
	return getMarketplaceMcpCategoryOptions();
});

const activeCategory = $derived.by(() => {
	if (section === "skills") return sk.categoryFilter;
	return mcpMarket.category;
});

const activeCategoryLabel = $derived(activeCategory === "all" ? "All categories" : activeCategory);
const activeView = $derived(section === "skills" ? sk.view : mcpMarket.view);
const activeSortLabel = $derived.by(() => {
	if (section === "skills") {
		if (sk.sortBy === "installs") return "Downloads";
		if (sk.sortBy === "stars") return "Stars";
		if (sk.sortBy === "name") return "Name";
		if (sk.sortBy === "newest") return "Newest";
		return "Popularity";
	}
	if (mcpMarket.sortBy === "official") return "Official";
	if (mcpMarket.sortBy === "name") return "Name";
	return "Popularity";
});

const activeSecondarySortLabel = $derived.by(() => {
	if (section === "skills") {
		if (sk.providerFilter === "skills.sh") return "skills.sh";
		if (sk.providerFilter === "clawhub") return "ClawHub";
		return "All providers";
	}
	if (mcpMarket.source === "mcpservers.org") return "MCP Registry";
	if (mcpMarket.source === "modelcontextprotocol/servers") return "MCP GitHub";
	return "All sources";
});

function handleSectionChange(value: string): void {
	section = value === "mcp" ? "mcp" : "skills";
}

function updateActiveQuery(value: string): void {
	if (section === "skills") {
		setQuery(value);
		return;
	}
	mcpMarket.query = value;
}

function applyCategory(category: string): void {
	const safe = categoryOptions.includes(category) ? category : "all";
	if (section === "skills") {
		sk.categoryFilter = safe;
		return;
	}
	mcpMarket.category = safe;
}

function applySort(value: string): void {
	if (section === "skills") {
		if (value === "installs" || value === "stars" || value === "name" || value === "newest") {
			sk.sortBy = value;
			return;
		}
		sk.sortBy = "popularity";
		return;
	}
	if (value === "name" || value === "official") {
		mcpMarket.sortBy = value;
		return;
	}
	mcpMarket.sortBy = "popularity";
}

function applySecondarySort(value: string): void {
	if (section === "skills") {
		if (value === "skills.sh" || value === "clawhub") {
			sk.providerFilter = value;
			return;
		}
		sk.providerFilter = "all";
		return;
	}
	if (value === "mcpservers.org" || value === "modelcontextprotocol/servers") {
		mcpMarket.source = value;
		return;
	}
	mcpMarket.source = "all";
}

function clearSectionFilters(): void {
	if (section === "skills") {
		setQuery("");
		sk.categoryFilter = "all";
		sk.providerFilter = "all";
		return;
	}
	mcpMarket.query = "";
	mcpMarket.category = "all";
	mcpMarket.source = "all";
}

function setActiveView(value: "browse" | "installed"): void {
	if (section === "skills") {
		sk.view = value;
		return;
	}
	mcpMarket.view = value;
}

function hasUsedTarget(targetType: "skill" | "mcp", targetId: string): boolean {
	if (targetType === "skill") {
		return sk.installed.some((s) => s.name === targetId);
	}
	return mcpMarket.installed.some((s) => (s.catalogId ? `${s.source}:${s.catalogId}` === targetId : false));
}

async function handleReviewRequest(payload: {
	targetType: "skill" | "mcp";
	targetId: string;
	targetLabel: string;
}): Promise<void> {
	const canReview = hasUsedTarget(payload.targetType, payload.targetId);
	await setReviewTarget(payload.targetType, payload.targetId, payload.targetLabel, {
		canReview,
		reason: "Install or use this app before leaving a review.",
	});
	if (!canReview) {
		toast("Install or use this app before leaving a review.", "error");
	}
}

async function refreshSkills(): Promise<void> {
	refreshingSkills = true;
	try {
		sk.catalogLoaded = false;
		await Promise.all([fetchInstalled(), fetchCatalog()]);
	} finally {
		refreshingSkills = false;
	}
}

async function refreshMcpServers(): Promise<void> {
	refreshingMcp = true;
	try {
		mcpMarket.catalogLoaded = false;
		await Promise.all([fetchMarketplaceMcpInstalled(), fetchMarketplaceMcpCatalog(5)]);
	} finally {
		refreshingMcp = false;
	}
}

async function refreshRoutedToolsNow(): Promise<void> {
	refreshingTools = true;
	try {
		await refreshMarketplaceMcpTools(true);
	} finally {
		refreshingTools = false;
	}
}

onMount(() => {
	const media = window.matchMedia(MOBILE_RAIL_QUERY);
	const applyRailLayoutState = (): void => {
		if (media.matches) {
			sortOpen = false;
			reviewSyncOpen = false;
			return;
		}
		sortOpen = true;
		reviewSyncOpen = false;
	};

	applyRailLayoutState();
	media.addEventListener("change", applyRailLayoutState);

	void fetchInstalled();
	void fetchCatalog();
	void fetchMarketplaceMcpInstalled();
	void fetchMarketplaceMcpCatalog(5);
	void refreshMarketplaceMcpTools();
	void loadMarketplaceReviewConfig();

	return () => {
		media.removeEventListener("change", applyRailLayoutState);
	};
});

$effect(() => {
	if (!firstReviewTarget) return;
	if (reviewsMarket.targetId && reviewsMarket.targetType) return;
	void setReviewTarget(firstReviewTarget.targetType, firstReviewTarget.targetId, firstReviewTarget.title, {
		canReview: hasUsedTarget(firstReviewTarget.targetType, firstReviewTarget.targetId),
		reason: "Install or use this app before leaving a review.",
	});
});

$effect(() => {
	if (!reviewsMarket.targetType || !reviewsMarket.targetId) return;
	void fetchTargetReviews();
});
</script>

<div class="store-shell">
	<section class="hero">
		<div class="hero-main">
			<h2>
				{section === "skills"
					? "Equip your agent with legendary skill packs"
					: "Connect relay servers and wield production tools"}
			</h2>
			<p>
				{section === "skills"
					? "Install trusted abilities, compare loadouts, and forge your optimal build."
					: "Bind relay servers, monitor active channels, and rate your arsenal."}
			</p>
			<div class="hero-actions">
				<Button
					variant="outline"
					size="sm"
					class={`hero-switch ${section === "skills" ? "hero-switch-active" : ""}`}
					onclick={() => handleSectionChange("skills")}
				>
					&#x2694; Skill Packs
				</Button>
				<Button
					variant="outline"
					size="sm"
					class={`hero-switch ${section === "mcp" ? "hero-switch-active" : ""}`}
					onclick={() => handleSectionChange("mcp")}
				>
					&#x27F3; Relay Servers
				</Button>
			</div>
		</div>
		<div class="hero-aside">
			<div class="hero-metric"><span>Arsenal Section</span><strong>{activeSectionLabel} · {activeInstalledCount} installed</strong></div>
			<div class="hero-metric"><span>Items in Catalog</span><strong>{sectionCatalogCount.toLocaleString()}</strong></div>
			<div class="hero-metric"><span>Battle Reviews</span><strong>{reviewsMarket.summary.count} reviews</strong></div>
		</div>
	</section>

	<div class="store-grid">
		<main class="store-main">
			<div class="module-head">
				<div class="module-search-wrap">
					<div class="module-search-inner">
						<input
							type="text"
							class="module-search"
							placeholder={section === "skills" ? "Search skills..." : "Search MCP servers..."}
							value={activeQuery}
							oninput={(e) => updateActiveQuery(e.currentTarget.value)}
						/>
						<Button variant="outline" size="sm" class="search-clear" onclick={clearSectionFilters}>Clear</Button>
					</div>
				</div>
				<div class="module-view-tabs">
					<Button
						variant="outline"
						size="sm"
						class={`view-tab ${activeView === "browse" ? "view-tab-active" : ""}`}
						onclick={() => setActiveView("browse")}
					>
						Browse
					</Button>
					<Button
						variant="outline"
						size="sm"
						class={`view-tab ${activeView === "installed" ? "view-tab-active" : ""}`}
						onclick={() => setActiveView("installed")}
					>
						Installed
					</Button>
				</div>
			</div>

			<div class="module-body">
				{#if section === "skills"}
					<SkillsTab embedded={true} showViewTabs={false} onreviewrequest={handleReviewRequest} />
				{:else}
					<McpServersTab
						embedded={true}
						showViewTabs={false}
						currentView={activeView}
						onviewchange={(v) => setActiveView(v)}
						onreviewrequest={handleReviewRequest}
					/>
				{/if}
			</div>
		</main>

		<aside class="store-rail">
			<Collapsible.Root bind:open={sortOpen} class="rail-panel">
				<Collapsible.Trigger class="rail-trigger">
					<span>Sort</span>
					<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${sortOpen ? "rotate-180" : ""}`} />
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="rail-content">
						<Select.Root
							type="single"
							value={section === "skills" ? sk.sortBy : mcpMarket.sortBy}
							onValueChange={(v) => applySort(v ?? "popularity")}
						>
							<Select.Trigger class="rail-select">{activeSortLabel}</Select.Trigger>
							<Select.Content class="section-select-content">
								{#if section === "skills"}
									<Select.Item value="popularity" label="Popularity" class="section-select-item" />
									<Select.Item value="installs" label="Downloads" class="section-select-item" />
									<Select.Item value="stars" label="Stars" class="section-select-item" />
									<Select.Item value="name" label="Name" class="section-select-item" />
									<Select.Item value="newest" label="Newest" class="section-select-item" />
								{:else}
									<Select.Item value="popularity" label="Popularity" class="section-select-item" />
									<Select.Item value="official" label="Official" class="section-select-item" />
									<Select.Item value="name" label="Name" class="section-select-item" />
								{/if}
							</Select.Content>
						</Select.Root>

						<Select.Root
							type="single"
							value={section === "skills" ? sk.providerFilter : mcpMarket.source}
							onValueChange={(v) => applySecondarySort(v ?? "all")}
						>
							<Select.Trigger class="rail-select">{activeSecondarySortLabel}</Select.Trigger>
							<Select.Content class="section-select-content">
								{#if section === "skills"}
									<Select.Item value="all" label="All providers" class="section-select-item" />
									<Select.Item value="skills.sh" label="skills.sh" class="section-select-item" />
									<Select.Item value="clawhub" label="ClawHub" class="section-select-item" />
								{:else}
									<Select.Item value="all" label="All sources" class="section-select-item" />
									<Select.Item value="mcpservers.org" label="MCP Registry" class="section-select-item" />
									<Select.Item value="modelcontextprotocol/servers" label="MCP GitHub" class="section-select-item" />
								{/if}
							</Select.Content>
						</Select.Root>

						<Select.Root type="single" value={activeCategory} onValueChange={(v) => applyCategory(v ?? "all")}>
							<Select.Trigger class="rail-select">{activeCategoryLabel}</Select.Trigger>
							<Select.Content class="section-select-content">
								{#each categoryOptions as category (category)}
									<Select.Item value={category} label={category} class="section-select-item" />
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</Collapsible.Content>
			</Collapsible.Root>

			<Collapsible.Root bind:open={reviewSyncOpen} class="rail-panel">
				<Collapsible.Trigger class="rail-trigger">
					<span>Sync</span>
					<ChevronDown class={`size-3 text-[var(--sig-text-muted)] transition-transform ${reviewSyncOpen ? "rotate-180" : ""}`} />
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="rail-content">
						<div class="rail-refresh">
							<Button variant="outline" size="sm" class="rail-btn" disabled={refreshingSkills} onclick={refreshSkills}>
								{refreshingSkills ? "Refreshing Skills..." : "Refresh Skills"}
							</Button>
							<Button variant="outline" size="sm" class="rail-btn" disabled={refreshingMcp} onclick={refreshMcpServers}>
								{refreshingMcp ? "Refreshing MCP Servers..." : "Refresh MCP Servers"}
							</Button>
							<Button variant="outline" size="sm" class="rail-btn" disabled={refreshingTools} onclick={refreshRoutedToolsNow}>
								{refreshingTools ? "Refreshing Routed Tools..." : "Refresh Routed Tools"}
							</Button>
						</div>

				<label class="toggle-row">
					<input type="checkbox" bind:checked={reviewsMarket.configEnabled} />
					<span>Enable endpoint sync</span>
				</label>
				<input
					type="url"
					class="input"
					placeholder="https://example.com/signet-reviews"
					bind:value={reviewsMarket.configEndpointUrl}
				/>
				<div class="sync-actions">
					<Button variant="outline" size="sm" disabled={reviewsMarket.configSaving} onclick={saveMarketplaceReviewConfig}>
						{reviewsMarket.configSaving ? "Saving..." : "Save Sync Config"}
					</Button>
					<Button variant="outline" size="sm" disabled={reviewsMarket.syncing} onclick={syncMarketplaceReviewsNow}>
						{reviewsMarket.syncing ? "Syncing..." : `Sync Now (${reviewsMarket.pendingSync})`}
					</Button>
				</div>
				{#if reviewsMarket.lastSyncAt}
					<div class="muted">Last sync: {new Date(reviewsMarket.lastSyncAt).toLocaleString()}</div>
				{/if}
				{#if reviewsMarket.lastSyncError}
					<div class="error">{reviewsMarket.lastSyncError}</div>
				{/if}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</aside>
	</div>
</div>

<style>
	.store-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow: hidden;
		padding: 10px;
	}

	.hero,
	.store-main,
	:global(.rail-panel) {
		border: none;
		background: var(--sig-surface);
	}

	.hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: 10px;
		padding: 14px;
		background:
			radial-gradient(circle at 85% -20%, color-mix(in srgb, var(--sig-accent) 16%, transparent), transparent 45%),
			linear-gradient(140deg, color-mix(in srgb, var(--sig-surface-raised) 88%, black) 0%, var(--sig-surface) 65%);
	}

	.hero-main h2 {
		margin: 8px 0 4px;
		font-size: clamp(19px, 2vw, 27px);
		line-height: 1.15;
	}

	.hero-main p {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.55;
		color: var(--sig-text);
	}

	.hero-aside {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.hero-metric {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px;
		background: color-mix(in srgb, var(--sig-surface-raised) 55%, transparent);
		border-radius: 0.45rem;
	}

	.hero-metric span {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.hero-metric strong {
		font-family: var(--font-display);
		font-size: 11px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.module-search,
	.input,
	:global(.section-select) {
		height: 34px;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		outline: none;
		border-radius: 0.5rem;
	}

	:global(.section-select-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	:global(.section-select-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.store-grid {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 250px;
		gap: 10px;
	}

	.store-main {
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}

	.module-head {
		display: grid;
		grid-template-columns: minmax(260px, 1fr) auto;
		align-items: center;
		gap: 8px;
		padding: 0 8px;
		margin-bottom: 8px;
	}

	.module-search {
		height: 30px;
		min-width: 0;
		width: 100%;
		padding-right: 72px;
	}

	.module-search-wrap {
		display: block;
	}

	.module-search-inner {
		position: relative;
		display: flex;
		align-items: center;
	}

	:global(.search-clear) {
		position: absolute;
		right: 4px;
		height: 22px;
		min-height: 22px;
		padding: 0 8px;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.module-view-tabs {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	:global(.view-tab) {
		height: 30px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	:global(.view-tab.view-tab-active) {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
	}

	.hero-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	:global(.hero-switch) {
		height: 30px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	:global(.hero-switch.hero-switch-active) {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
		background: color-mix(in srgb, var(--sig-surface-raised) 84%, transparent);
	}

	.module-body {
		flex: 1;
		min-height: 0;
	}

	.store-rail {
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow-y: auto;
		padding-top: 2px;
		justify-self: center;
		width: 100%;
		max-width: 250px;
	}

	:global(.rail-panel) {
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: color-mix(in srgb, var(--sig-surface-raised) 35%, transparent);
		border-radius: 0.5rem;
	}

	:global(.rail-trigger) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 2px 0;
		background: transparent;
		border: none;
		font-family: var(--font-display);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sig-text-bright);
		cursor: pointer;
	}

	:global(.rail-content) {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 6px;
	}

	:global(.rail-select) {
		height: 32px;
		width: 100%;
		padding: 0 10px;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	.rail-refresh {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-top: 4px;
	}

	:global(.rail-btn) {
		justify-content: flex-start;
		font-family: var(--font-mono);
		font-size: 10px;
		height: 30px;
	}

	.muted {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.toggle-row span,
	.error {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.toggle-row span {
		color: var(--sig-text-muted);
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.sync-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.error {
		color: var(--sig-danger);
	}

	@media (max-width: 1120px) {
		.store-grid {
			grid-template-columns: 1fr;
		}

		.store-rail {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 8px;
			max-width: none;
			max-height: none;
		}

		:global(.rail-panel) {
			min-height: 0;
		}
	}

	@media (max-width: 980px) {
		.hero {
			grid-template-columns: 1fr;
		}

		.module-head {
			grid-template-columns: 1fr;
		}

		.module-search-wrap {
			display: block;
		}
	}
</style>

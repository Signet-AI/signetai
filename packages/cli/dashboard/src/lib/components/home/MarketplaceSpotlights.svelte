<script lang="ts">
import type { MarketplaceMcpCatalogEntry, SkillSearchResult } from "$lib/api";
import { getAvatarFromSource, getAvatarUrl, getMonogram, getMonogramBg } from "$lib/card-utils";
import { fetchMarketplaceMcpCatalog, mcpMarket } from "$lib/stores/marketplace-mcp.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { fetchCatalog, sk } from "$lib/stores/skills.svelte";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";

type SpotlightEntry =
	| { readonly kind: "skill"; readonly item: SkillSearchResult }
	| { readonly kind: "mcp"; readonly item: MarketplaceMcpCatalogEntry };

const TOTAL = 6;

let loaded = $state(false);
const avatarErrors = new SvelteSet<string>();

onMount(async () => {
	await Promise.allSettled([fetchCatalog(), fetchMarketplaceMcpCatalog(5)]);
	loaded = true;
});

const spotlights = $derived.by((): SpotlightEntry[] => {
	const skills: SpotlightEntry[] = sk.catalog.slice(0, 3).map((item) => ({ kind: "skill" as const, item }));
	const mcps: SpotlightEntry[] = mcpMarket.catalog.slice(0, 3).map((item) => ({ kind: "mcp" as const, item }));
	return [...skills, ...mcps].slice(0, TOTAL);
});

function spotlightId(entry: SpotlightEntry): string {
	return entry.kind === "skill" ? `sk:${entry.item.name}` : `mcp:${entry.item.id}`;
}

function spotlightName(entry: SpotlightEntry): string {
	return entry.item.name;
}

function spotlightDesc(entry: SpotlightEntry): string {
	return entry.item.description;
}

function spotlightBadge(entry: SpotlightEntry): string {
	return entry.kind === "skill" ? "SKILL" : "MCP";
}

function spotlightAvatar(entry: SpotlightEntry): string | null {
	if (entry.kind === "mcp") {
		return getAvatarFromSource(entry.item.source, entry.item.catalogId) ?? getAvatarUrl(entry.item.sourceUrl);
	}
	const maintainer = entry.item.maintainer;
	if (maintainer) return `https://github.com/${maintainer.split("/")[0]}.png?size=40`;
	return null;
}

function handleClick(_entry: SpotlightEntry): void {
	// Both skills and MCP servers live on the "skills" (Marketplace) tab
	nav.activeTab = "skills";
}
</script>

<div class="spotlights-panel sig-panel">
	<div class="spotlights-header sig-panel-header">
		<span class="spotlights-title">MOST USED SKILLS & SERVERS</span>
		<span class="spotlights-count">{spotlights.length} TOP PICKS</span>
	</div>

	{#if !loaded && spotlights.length === 0}
		<div class="empty-state">LOADING CATALOG...</div>
	{:else if spotlights.length === 0}
		<div class="empty-state">NO CATALOG DATA</div>
	{:else}
		<div class="spotlights-grid">
			{#each spotlights as entry (spotlightId(entry))}
				{@const avatar = spotlightAvatar(entry)}
				{@const id = spotlightId(entry)}
				<button
					type="button"
					class="spotlight-card"
					onclick={() => handleClick(entry)}
				>
					<div class="spotlight-top">
						<div
							class="spotlight-icon"
							style="background: {avatar && !avatarErrors.has(id) ? 'transparent' : getMonogramBg(spotlightName(entry))};"
						>
							{#if avatar && !avatarErrors.has(id)}
								<img
									src={avatar}
									alt={spotlightName(entry)}
									class="spotlight-avatar"
									onerror={() => { avatarErrors.add(id); }}
								/>
							{:else}
								{getMonogram(spotlightName(entry))}
							{/if}
						</div>
						<div class="spotlight-meta">
							<span class="spotlight-name">{spotlightName(entry)}</span>
							<span class="spotlight-badge">{spotlightBadge(entry)}</span>
						</div>
					</div>
					<p class="spotlight-desc">{spotlightDesc(entry)}</p>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.spotlights-panel {
		display: flex;
		flex-direction: column;
		background: var(--sig-surface);
	}

	.spotlights-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		flex-shrink: 0;
	}

	.spotlights-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.spotlights-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.spotlights-grid {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: var(--space-xs);
		padding: var(--space-sm) var(--space-md) var(--space-sm);
		align-content: start;
	}

	.spotlight-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: var(--space-xs) var(--space-sm);
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		background: var(--sig-surface);
		cursor: pointer;
		text-align: left;
		min-width: 0;
		transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.spotlight-card:hover {
		border-color: var(--sig-border-strong);
		background: var(--sig-surface-raised);
	}

	.spotlight-card:focus-visible {
		outline: 2px solid var(--sig-highlight);
		outline-offset: 1px;
	}

	.spotlight-top {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.spotlight-icon {
		width: 22px;
		height: 22px;
		border-radius: 3px;
		border: 1px solid var(--sig-icon-border);
		display: grid;
		place-items: center;
		font-family: var(--font-mono);
		font-size: 8px;
		font-weight: 700;
		color: var(--sig-icon-fg);
		text-transform: uppercase;
		flex-shrink: 0;
		overflow: hidden;
	}

	.spotlight-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.spotlight-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}

	.spotlight-name {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.spotlight-badge {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 8px;
		padding: 1px 4px;
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.spotlight-desc {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		line-height: 1.4;
		margin: 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.empty-state {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

</style>

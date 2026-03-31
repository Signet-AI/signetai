<script lang="ts">
import { getAvatarFromSource, getAvatarUrl, getMonogram, getMonogramBg } from "$lib/card-utils";
import { fetchMcpAnalytics, mcpAnalytics } from "$lib/stores/mcp-analytics.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { fetchSkillAnalytics, skillAnalytics } from "$lib/stores/skill-analytics.svelte";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";

type SpotlightEntry =
	| { readonly kind: "skill"; readonly name: string; readonly description: string; readonly count: number }
	| { readonly kind: "mcp"; readonly name: string; readonly description: string; readonly count: number };

const TOTAL = 6;

let loaded = $state(false);
const avatarErrors = new SvelteSet<string>();

onMount(async () => {
	await Promise.allSettled([fetchSkillAnalytics(), fetchMcpAnalytics()]);
	loaded = true;
});

const spotlights = $derived.by((): SpotlightEntry[] => {
	const skills: SpotlightEntry[] = (skillAnalytics.data?.topSkills ?? []).slice(0, 3).map((s) => ({
		kind: "skill" as const,
		name: s.skillName,
		description: `${s.count} calls, ${s.avgLatencyMs}ms avg`,
		count: s.count,
	}));
	const mcps: SpotlightEntry[] = (mcpAnalytics.data?.topTools ?? []).slice(0, 3).map((t) => ({
		kind: "mcp" as const,
		name: t.toolName,
		description: `${t.count} calls, ${t.avgLatencyMs}ms avg`,
		count: t.count,
	}));
	// Interleave by usage count
	const all = [...skills, ...mcps].sort((a, b) => b.count - a.count);
	return all.slice(0, TOTAL);
});

function spotlightId(entry: SpotlightEntry): string {
	return `${entry.kind}:${entry.name}`;
}

function spotlightBadge(entry: SpotlightEntry): string {
	return entry.kind === "skill" ? "SKILL" : "MCP";
}

function handleClick(_entry: SpotlightEntry): void {
	nav.activeTab = "skills";
}

const hasAnyData = $derived(spotlights.length > 0);
</script>

<div class="spotlights-panel sig-panel">
	<div class="spotlights-header sig-panel-header">
		<span class="spotlights-title">MOST USED SKILLS & SERVERS</span>
		{#if hasAnyData}
			<span class="spotlights-count">{spotlights.length} TOP PICKS</span>
		{/if}
	</div>

	{#if !loaded && !hasAnyData}
		<div class="empty-state">LOADING USAGE DATA...</div>
	{:else if !hasAnyData}
		<div class="empty-state">NO USAGE DATA YET</div>
	{:else}
		<div class="spotlights-grid">
			{#each spotlights as entry (spotlightId(entry))}
				<button
					type="button"
					class="spotlight-card"
					onclick={() => handleClick(entry)}
				>
					<div class="spotlight-top">
						<div
							class="spotlight-icon"
							style="background: {getMonogramBg(entry.name)};"
						>
							{getMonogram(entry.name)}
						</div>
						<div class="spotlight-meta">
							<span class="spotlight-name">{entry.name}</span>
							<span class="spotlight-badge">{spotlightBadge(entry)}</span>
						</div>
					</div>
					<p class="spotlight-desc">{entry.description}</p>
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

<script lang="ts">
import type {
	MarketplaceMcpServer,
	Skill,
	SkillAnalyticsSummary,
	McpAnalyticsSummary,
} from "$lib/api";
import { getAvatarFromSource, getAvatarUrl, getMonogram, getMonogramBg } from "$lib/card-utils";
import {
	getMcpAnalytics,
	getMarketplaceMcpServers,
	getSkillAnalytics,
	getSkills,
} from "$lib/api";
import { fetchMarketplaceMcpCatalog, mcpMarket } from "$lib/stores/marketplace-mcp.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { fetchCatalog, sk } from "$lib/stores/skills.svelte";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";

type SpotlightEntry = {
	readonly kind: "skill" | "mcp";
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly count: number;
};

const TOTAL = 6;
const LIMIT = 3;
const SINCE = new Date(Date.now() - 30 * 86_400_000).toISOString();

let loaded = $state(false);
let installedSkills = $state<Skill[]>([]);
let installedServers = $state<MarketplaceMcpServer[]>([]);
let skillUsage = $state<SkillAnalyticsSummary | null>(null);
let mcpUsage = $state<McpAnalyticsSummary | null>(null);
const avatarErrors = new SvelteSet<string>();

onMount(async () => {
	const results = await Promise.allSettled([
		fetchCatalog(),
		fetchMarketplaceMcpCatalog(5),
		getSkills(),
		getMarketplaceMcpServers(),
		getSkillAnalytics({ since: SINCE, limit: LIMIT }),
		getMcpAnalytics({ since: SINCE, limit: LIMIT }),
	]);

	if (results[2]?.status === "fulfilled") installedSkills = results[2].value;
	if (results[3]?.status === "fulfilled") installedServers = results[3].value.servers;
	if (results[4]?.status === "fulfilled") skillUsage = results[4].value;
	if (results[5]?.status === "fulfilled") mcpUsage = results[5].value;
	loaded = true;
});

const spotlights = $derived.by((): SpotlightEntry[] => {
	const skillMeta = new Map<string, { name: string; description: string }>();
	for (const item of installedSkills) {
		skillMeta.set(item.name.toLowerCase(), {
			name: item.name,
			description: item.description,
		});
	}
	for (const item of sk.catalog) {
		const key = item.name.toLowerCase();
		if (skillMeta.has(key)) continue;
		skillMeta.set(key, {
			name: item.name,
			description: item.description,
		});
	}

	const serverMeta = new Map<string, { name: string; description: string }>();
	for (const item of installedServers) {
		serverMeta.set(item.id, {
			name: item.name,
			description: item.description,
		});
	}
	for (const item of mcpMarket.catalog) {
		if (serverMeta.has(item.id)) continue;
		serverMeta.set(item.id, {
			name: item.name,
			description: item.description,
		});
	}

	const skills: SpotlightEntry[] = (skillUsage?.topSkills ?? []).slice(0, LIMIT).map((item) => {
		const meta = skillMeta.get(item.skillName.toLowerCase());
		return {
			kind: "skill",
			id: item.skillName,
			name: meta?.name ?? item.skillName,
			description: meta?.description ?? "Tracked from real skill invocation history.",
			count: item.count,
		};
	});

	const mcps: SpotlightEntry[] = (mcpUsage?.topServers ?? []).slice(0, LIMIT).map((item) => {
		const meta = serverMeta.get(item.serverId);
		return {
			kind: "mcp",
			id: item.serverId,
			name: meta?.name ?? item.serverId,
			description: meta?.description ?? "Tracked from real MCP server invocation history.",
			count: item.count,
		};
	});

	return [...skills, ...mcps].slice(0, TOTAL);
});

function spotlightId(entry: SpotlightEntry): string {
	return entry.kind === "skill" ? `sk:${entry.id}` : `mcp:${entry.id}`;
}

function spotlightBadge(entry: SpotlightEntry): string {
	return entry.kind === "skill" ? "SKILL" : "MCP";
}

function spotlightAvatar(entry: SpotlightEntry): string | null {
	if (entry.kind === "mcp") {
		const installed = installedServers.find((item) => item.id === entry.id);
		if (installed?.source !== "manual" && installed?.catalogId) {
			return getAvatarFromSource(installed.source, installed.catalogId);
		}
		const catalog = mcpMarket.catalog.find((item) => item.id === entry.id);
		if (catalog) {
			return getAvatarFromSource(catalog.source, catalog.catalogId) ?? getAvatarUrl(catalog.sourceUrl);
		}
		return null;
	}

	const installed = installedSkills.find((item) => item.name.toLowerCase() === entry.id.toLowerCase());
	if (installed?.maintainer) {
		return `https://github.com/${installed.maintainer.split("/")[0]}.png?size=40`;
	}
	const catalog = sk.catalog.find((item) => item.name.toLowerCase() === entry.id.toLowerCase());
	const maintainer = catalog?.maintainer;
	if (maintainer) return `https://github.com/${maintainer.split("/")[0]}.png?size=40`;
	return null;
}

function handleClick(): void {
	nav.activeTab = "skills";
}
</script>

<div class="spotlights-panel sig-panel">
	<div class="spotlights-header sig-panel-header">
		<span class="spotlights-title">MOST USED SKILLS & SERVERS</span>
		<span class="spotlights-count">LAST 30 DAYS</span>
	</div>

	{#if !loaded && spotlights.length === 0}
		<div class="empty-state">LOADING USAGE...</div>
	{:else if spotlights.length === 0}
		<div class="empty-state">NO TRACKED USAGE YET</div>
	{:else}
		<div class="spotlights-grid">
			{#each spotlights as entry (spotlightId(entry))}
				{@const avatar = spotlightAvatar(entry)}
				{@const id = spotlightId(entry)}
				<button type="button" class="spotlight-card" onclick={handleClick}>
					<div class="spotlight-top">
						<div
							class="spotlight-icon"
							style="background: {avatar && !avatarErrors.has(id) ? 'transparent' : getMonogramBg(entry.name)};"
						>
							{#if avatar && !avatarErrors.has(id)}
								<img
									src={avatar}
									alt={entry.name}
									class="spotlight-avatar"
									onerror={() => {
										avatarErrors.add(id);
									}}
								/>
							{:else}
								{getMonogram(entry.name)}
							{/if}
						</div>
						<div class="spotlight-meta">
							<span class="spotlight-name">{entry.name}</span>
							<span class="spotlight-badge">{spotlightBadge(entry)}</span>
						</div>
					</div>
					<p class="spotlight-desc">{entry.description}</p>
					<p class="spotlight-usage">{entry.count} uses</p>
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
		font-family: var(--font-body);
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
		font-family: var(--font-body);
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
		font-family: var(--font-body);
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
		font-family: var(--font-body);
		font-size: 8px;
		padding: 1px 4px;
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.spotlight-desc {
		font-family: var(--font-body);
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

	.spotlight-usage {
		margin: 0;
		font-family: var(--font-body);
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.empty-state {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-body);
		font-size: 9px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}
</style>

<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";

type Props = {
	item: Skill | SkillSearchResult;
	mode: "installed" | "browse";
	selected?: boolean;
	installing?: boolean;
	uninstalling?: boolean;
	onclick?: () => void;
	oninstall?: () => void;
	onuninstall?: () => void;
};

let {
	item,
	mode,
	selected = false,
	installing = false,
	uninstalling = false,
	onclick,
	oninstall,
	onuninstall,
}: Props = $props();

function isSearchResult(
	i: Skill | SkillSearchResult,
): i is SkillSearchResult {
	return "installed" in i && "fullName" in i;
}

function isSkill(i: Skill | SkillSearchResult): i is Skill {
	return "path" in i || "builtin" in i;
}

function formatStat(n: number | undefined): string {
	if (n === undefined) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
</script>

<button
	type="button"
	class="card"
	class:selected
	onclick={() => onclick?.()}
>
	<!-- Header: name + provider badge -->
	<div class="card-header">
		<span class="card-name">{item.name}</span>
		{#if isSearchResult(item) && item.provider}
			<span
				class="provider-badge"
				class:clawhub={item.provider === "clawhub"}
			>
				{item.provider}
			</span>
		{/if}
	</div>

	<!-- Description -->
	<p class="card-desc">
		{#if isSearchResult(item) && item.description}
			{item.description}
		{:else if isSkill(item) && item.description}
			{item.description}
		{:else if isSearchResult(item)}
			{item.fullName.split("@")[0]}
		{:else}
			&nbsp;
		{/if}
	</p>

	<!-- Stats row -->
	<div class="card-stats">
		{#if isSearchResult(item)}
			<span class="stat" title="Downloads">
				<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="shrink-0">
					<path d="M8 12L3 7h3V1h4v6h3L8 12zM2 14h12v1H2v-1z"/>
				</svg>
				{item.installs}
			</span>
			{#if item.stars !== undefined && item.stars > 0}
				<span class="stat" title="Stars">
					<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" class="shrink-0">
						<path d="M8 0L10 5.5L16 6L11.5 10L13 16L8 12.5L3 16L4.5 10L0 6L6 5.5L8 0Z"/>
					</svg>
					{formatStat(item.stars)}
				</span>
			{/if}
			{#if item.versions !== undefined && item.versions > 0}
				<span class="stat" title="Versions">
					v{item.versions}
				</span>
			{/if}
		{:else if isSkill(item)}
			{#if item.user_invocable}
				<span class="stat">/{item.name}</span>
			{/if}
			{#if item.builtin}
				<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">Built-in</Badge>
			{/if}
		{/if}
	</div>

	<!-- Action button -->
	<div class="card-action" onclick={(e) => e.stopPropagation()}>
		{#if mode === "browse" && isSearchResult(item)}
			{#if item.installed}
				<Button
					variant="outline"
					size="sm"
					class="w-full h-auto rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
					onclick={(e: MouseEvent) => { e.stopPropagation(); onuninstall?.(); }}
					disabled={uninstalling}
				>
					{uninstalling ? "..." : "Uninstall"}
				</Button>
			{:else}
				<Button
					variant="outline"
					size="sm"
					class="w-full h-auto rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
					onclick={(e: MouseEvent) => { e.stopPropagation(); oninstall?.(); }}
					disabled={installing}
				>
					{installing ? "..." : "Install"}
				</Button>
			{/if}
		{:else if mode === "installed" && isSkill(item) && !item.builtin}
			<Button
				variant="outline"
				size="sm"
				class="w-full h-auto rounded-none font-[family-name:var(--font-mono)] text-[9px] uppercase tracking-[0.08em] px-2 py-1 border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
				onclick={(e: MouseEvent) => { e.stopPropagation(); onuninstall?.(); }}
				disabled={uninstalling}
			>
				{uninstalling ? "..." : "Uninstall"}
			</Button>
		{/if}
	</div>
</button>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: var(--space-sm);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		cursor: pointer;
		transition: border-color 0.15s;
		text-align: left;
		min-height: 140px;
	}
	.card:hover {
		border-color: var(--sig-accent);
	}
	.card.selected {
		border-color: var(--sig-accent);
		background: var(--sig-surface);
	}

	.card-header {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.card-name {
		font-family: var(--font-display);
		font-size: 12px;
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

	.provider-badge {
		flex-shrink: 0;
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

	.card-desc {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		line-height: 1.5;
		margin: 0;
		flex: 1;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-stats {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.stat {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		font-variant-numeric: tabular-nums;
	}

	.card-action {
		margin-top: auto;
	}
</style>

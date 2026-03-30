<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";
import SkillCard from "./SkillCard.svelte";
import SkillsEmptyState from "./SkillsEmptyState.svelte";

type EmptyStateKind = "installed" | "browse" | "search";

type Props = {
	items: (Skill | SkillSearchResult)[];
	mode: "installed" | "browse";
	selectedName?: string | null;
	installing?: string | null;
	uninstalling?: string | null;
	onitemclick?: (name: string) => void;
	oninstall?: (name: string) => void;
	onuninstall?: (name: string) => void;
	emptyState?: EmptyStateKind | null;
	onemptyaction?: (action: "primary" | "secondary") => void;
	compareSelectedKeys?: string[];
	oncomparetoggle?: (key: string) => void;
	onreviewrequest?: (payload: {
		targetType: "skill";
		targetId: string;
		targetLabel: string;
	}) => void | Promise<void>;
};

let {
	items,
	mode,
	selectedName = null,
	installing = null,
	uninstalling = null,
	onitemclick,
	oninstall,
	onuninstall,
	emptyState = null,
	onemptyaction,
	compareSelectedKeys = [],
	oncomparetoggle,
	onreviewrequest,
}: Props = $props();

function isSearchResult(i: Skill | SkillSearchResult): i is SkillSearchResult {
	return "installed" in i && "fullName" in i;
}

function skillKey(i: Skill | SkillSearchResult): string {
	return isSearchResult(i) ? i.fullName : i.name;
}

const emptyActions = $derived.by(() => {
	if (emptyState === "installed") {
		return [
			{ label: "Go to Browse", onClick: () => onemptyaction?.("primary"), variant: "primary" as const },
			{ label: "Reset filters", onClick: () => onemptyaction?.("secondary") },
		];
	}
	if (emptyState === "browse") {
		return [
			{ label: "Clear provider filter", onClick: () => onemptyaction?.("primary"), variant: "primary" as const },
			{ label: "Retry catalog", onClick: () => onemptyaction?.("secondary") },
		];
	}
	if (emptyState === "search") {
		return [
			{ label: "Clear search", onClick: () => onemptyaction?.("primary"), variant: "primary" as const },
			{ label: "Browse top skills", onClick: () => onemptyaction?.("secondary") },
		];
	}
	return [];
});

// Progressive rendering: show N items initially, expand on demand
const PAGE_SIZE = 60;
let visibleCount = $state(PAGE_SIZE);

$effect(() => {
	items;
	visibleCount = PAGE_SIZE;
});

const visibleItems = $derived(items.slice(0, visibleCount));
const hasMore = $derived(visibleCount < items.length);
const remainingCount = $derived(items.length - visibleCount);
</script>

<div class="grid-container">
	{#if items.length > 0}
		<!-- Main grid -->
		<div class="grid">
			{#each visibleItems as item (skillKey(item))}
				<SkillCard
					{item}
					{mode}
					selected={selectedName === item.name}
					installing={installing === item.name}
					uninstalling={uninstalling === item.name}
					compareSelected={compareSelectedKeys.includes(skillKey(item))}
					onclick={() => onitemclick?.(item.name)}
					oninstall={() => oninstall?.(item.name)}
					onuninstall={() => onuninstall?.(item.name)}
					oncomparetoggle={() => oncomparetoggle?.(skillKey(item))}
				/>
			{/each}
		</div>

		{#if hasMore}
			<button
				type="button"
				class="show-more"
				onclick={() => (visibleCount += PAGE_SIZE)}
			>
				Show more ({remainingCount} remaining)
			</button>
		{/if}
	{:else}
		{#if emptyState}
			<SkillsEmptyState kind={emptyState} actions={emptyActions} />
		{:else}
			<div class="empty">No results found.</div>
		{/if}
	{/if}
</div>

<style>
	.grid-container {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-sm);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		background: transparent;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--space-sm);
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
		transition:
			border-color 0.15s,
			color 0.15s;
	}

	.show-more:hover {
		border-color: var(--sig-accent);
		color: var(--sig-text-bright);
	}

	.empty {
		padding: var(--space-lg);
		text-align: center;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--sig-text-muted);
	}
</style>

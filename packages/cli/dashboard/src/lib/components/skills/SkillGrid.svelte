<script lang="ts">
import type { Skill, SkillSearchResult } from "$lib/api";
import SkillCard from "./SkillCard.svelte";

type Props = {
	items: (Skill | SkillSearchResult)[];
	mode: "installed" | "browse";
	selectedName?: string | null;
	installing?: string | null;
	uninstalling?: string | null;
	onitemclick?: (name: string) => void;
	oninstall?: (name: string) => void;
	onuninstall?: (name: string) => void;
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
}: Props = $props();

function isSearchResult(i: Skill | SkillSearchResult): i is SkillSearchResult {
	return "installed" in i && "fullName" in i;
}

// Featured items: top 6 with installsRaw > 0, only in browse mode
let featuredItems = $derived.by(() => {
	if (mode !== "browse" || items.length === 0) return [];
	return items
		.filter((i): i is SkillSearchResult => isSearchResult(i) && (i.installsRaw ?? 0) > 0)
		.slice(0, 6);
});

let showFeatured = $derived(mode === "browse" && featuredItems.length > 0);
</script>

<div class="grid-container">
	{#if items.length > 0}
		<!-- Trending featured row -->
		{#if showFeatured}
			<div class="section-label">TRENDING</div>
			<div class="featured-row">
				{#each featuredItems as item (`${'fullName' in item ? item.fullName : item.name}-featured`)}
					<div class="featured-card-wrapper">
						<SkillCard
							{item}
							{mode}
							featured={true}
							selected={selectedName === item.name}
							installing={installing === item.name}
							uninstalling={uninstalling === item.name}
							onclick={() => onitemclick?.(item.name)}
							oninstall={() => oninstall?.(item.name)}
							onuninstall={() => onuninstall?.(item.name)}
						/>
					</div>
				{/each}
			</div>
			<div class="section-label">ALL SKILLS</div>
		{/if}

		<!-- Main grid -->
		<div class="grid">
			{#each items as item (`${'fullName' in item ? item.fullName : item.name}`)}
				<SkillCard
					{item}
					{mode}
					selected={selectedName === item.name}
					installing={installing === item.name}
					uninstalling={uninstalling === item.name}
					onclick={() => onitemclick?.(item.name)}
					oninstall={() => oninstall?.(item.name)}
					onuninstall={() => onuninstall?.(item.name)}
				/>
			{/each}
		</div>
	{:else}
		<div class="empty">
			{#if mode === "installed"}
				No skills installed. Browse the marketplace to find skills.
			{:else}
				No results found.
			{/if}
		</div>
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
	}

	.section-label {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
		padding: 2px 0;
	}

	.featured-row {
		display: flex;
		flex-direction: row;
		overflow-x: auto;
		gap: var(--space-sm);
		padding-bottom: 4px;
	}

	.featured-card-wrapper {
		min-width: 260px;
		max-width: 280px;
		flex-shrink: 0;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--space-sm);
	}

	.empty {
		padding: var(--space-lg);
		text-align: center;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--sig-text-muted);
	}
</style>

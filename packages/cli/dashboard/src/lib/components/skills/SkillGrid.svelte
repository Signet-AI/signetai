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
</script>

<div class="grid-container">
	{#if items.length > 0}
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

<script lang="ts">
import type { TabId } from "$lib/stores/navigation.svelte";

interface TabItem {
	readonly id: TabId;
	readonly label: string;
}

interface Props {
	group: "memory" | "engine" | "cortex";
	tabs: ReadonlyArray<TabItem>;
	activeTab: TabId;
	onselect: (tab: TabId, index: number) => void;
}

const tabBtn = "px-3 py-1 text-[11px] font-medium uppercase tracking-[0.06em] rounded-md transition-all duration-150 border-none cursor-pointer";
const tabActive = `${tabBtn} bg-[var(--sig-highlight-muted)] text-[var(--sig-highlight-text)] shadow-[inset_0_0_0_1px_var(--sig-highlight-dim)]`;
const tabInactive = `${tabBtn} bg-transparent text-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)] hover:text-[var(--sig-text-bright)]`;

const { group, tabs, activeTab, onselect }: Props = $props();

function dataAttrs(tabId: TabId): Record<string, string> {
	return { [`data-${group}-tab`]: tabId };
}
</script>

<div class="flex items-center gap-px border border-[var(--sig-border)] rounded-lg p-px bg-[var(--sig-surface)]">
	{#each tabs as tab, index}
		<button
			type="button"
			{...dataAttrs(tab.id)}
			class={activeTab === tab.id ? tabActive : tabInactive}
			onclick={() => onselect(tab.id, index)}
		>{tab.label}</button>
	{/each}
</div>

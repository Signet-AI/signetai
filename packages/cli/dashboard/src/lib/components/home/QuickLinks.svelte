<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import { type TabId, setTab } from "$lib/stores/navigation.svelte";
import Activity from "@lucide/svelte/icons/activity";
import Brain from "@lucide/svelte/icons/brain";
import Cog from "@lucide/svelte/icons/cog";
import ListChecks from "@lucide/svelte/icons/list-checks";
import Network from "@lucide/svelte/icons/network";
import Orbit from "@lucide/svelte/icons/orbit";
import Store from "@lucide/svelte/icons/store";

interface QuickLink {
	label: string;
	tab: TabId;
	icon: typeof Brain;
}

const links: QuickLink[] = [
	{ label: "Memory", tab: "memory", icon: Brain },
	{ label: "Knowledge", tab: "knowledge", icon: Network },
	{ label: "Constellation", tab: "embeddings", icon: Orbit },
	{ label: "Pipeline", tab: "pipeline", icon: Activity },
	{ label: "Settings", tab: "settings", icon: Cog },
	{ label: "Marketplace", tab: "skills", icon: Store },
	{ label: "Tasks", tab: "tasks", icon: ListChecks },
];
</script>

<div class="quick-links">
	{#each links as link (link.tab)}
		<Button
			variant="ghost"
			size="sm"
			class="link-btn"
			onclick={() => setTab(link.tab)}
		>
			<link.icon class="size-3.5" />
			<span class="link-label">{link.label}</span>
		</Button>
	{/each}
</div>

<style>
	.quick-links {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
		padding: var(--space-xs) 0;
	}

	:global(.link-btn) {
		gap: 4px !important;
		height: 28px !important;
		padding: 0 8px !important;
	}

	.link-label {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
</style>

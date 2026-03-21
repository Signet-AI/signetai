<script lang="ts">
	import type { TabId } from "$lib/stores/navigation.svelte";
	import type { Memory, MemoryStats, Harness, DaemonStatus } from "$lib/api";
	import { nav } from "$lib/stores/navigation.svelte";
	import { focusCortexTab } from "$lib/stores/tab-group-focus.svelte";
	import PageBanner from "$lib/components/layout/PageBanner.svelte";
	import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
	import { CORTEX_TAB_ITEMS } from "$lib/components/layout/page-headers";

	interface Props {
		activeTab: TabId;
		memories: Memory[];
		memoryStats: MemoryStats;
		harnesses: Harness[];
		daemonStatus: DaemonStatus | null;
		onopenglobalsimilar: (memory: Memory) => void;
		ontimelinegeneratedforchange: (value: string) => void;
	}

	const {
		activeTab,
		memories,
		onopenglobalsimilar,
		ontimelinegeneratedforchange,
	}: Props = $props();

	// Memory sub-tab state — persisted in URL hash fragment
	type MemorySection = "index" | "timeline" | "knowledge" | "constellation";
	const MEMORY_SECTIONS: readonly MemorySection[] = ["index", "timeline", "knowledge", "constellation"];
	const MEMORY_SECTION_SET = new Set<string>(MEMORY_SECTIONS);

	function readMemorySectionFromHash(): MemorySection {
		const hash = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
		// Check for cortex-memory/constellation style hashes
		const parts = hash.split("/");
		if (parts[0] === "cortex-memory" && parts[1] && MEMORY_SECTION_SET.has(parts[1])) {
			return parts[1] as MemorySection;
		}
		// Check legacy memory/constellation
		if (parts[0] === "memory" && parts[1] && MEMORY_SECTION_SET.has(parts[1])) {
			return parts[1] as MemorySection;
		}
		return "index";
	}

	let activeMemory = $state<MemorySection>(readMemorySectionFromHash());

	// Sync hash when sub-tab changes
	$effect(() => {
		const section = activeMemory;
		if (typeof window === "undefined") return;
		if (activeTab !== "cortex-memory") return;
		const target = section === "index" ? "cortex-memory" : `cortex-memory/${section}`;
		if (window.location.hash !== `#${target}`) {
			window.history.replaceState(null, "", `#${target}`);
		}
	});

	const memSections = [
		{ id: "index" as const, title: "Index" },
		{ id: "timeline" as const, title: "Timeline" },
		{ id: "knowledge" as const, title: "Knowledge" },
		{ id: "constellation" as const, title: "Constellation" },
	];

	const titleMap: Record<string, string> = {
		"cortex-memory": "Memory",
		"cortex-apps": "Apps",
		"cortex-tasks": "Tasks",
		"cortex-troubleshooter": "Troubleshooter",
	};

	const bannerTitle = $derived(titleMap[activeTab] ?? "Cortex");

	const subBtn = "px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.06em] rounded-md transition-colors duration-150 border-none cursor-pointer whitespace-nowrap";
	const subActive = `${subBtn} text-[var(--sig-highlight)] bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_90%)] border border-[color-mix(in_srgb,var(--sig-highlight),transparent_85%)]`;
	const subInactive = `${subBtn} bg-transparent text-[var(--sig-text-muted)] hover:text-[var(--sig-highlight)] hover:bg-[color-mix(in_srgb,var(--sig-highlight),var(--sig-bg)_94%)]`;
</script>

<div class="cortex-tab">
	<PageBanner title={bannerTitle}>
		<TabGroupBar
			group="cortex"
			tabs={CORTEX_TAB_ITEMS}
			activeTab={nav.activeTab}
			onselect={(_tab, index) => focusCortexTab(index)}
		/>
	</PageBanner>

	{#if activeTab === "cortex-memory"}
		<!-- Memory sub-tab bar (replaces the internal PageBanner of memory components) -->
		<header class="sub-bar">
			<div class="sub-group">
				{#each memSections as sec (sec.id)}
					<button
						class={activeMemory === sec.id ? subActive : subInactive}
						onclick={() => (activeMemory = sec.id)}
					>
						{sec.title}
					</button>
				{/each}
			</div>
		</header>

		<!-- Memory content — wrapper hides the internal PageBanner from nested tabs -->
		<div class="cortex-content cortex-memory-embed">
			{#if activeMemory === "index"}
				{#await import("$lib/components/tabs/MemoryTab.svelte")}
					<div class="cortex-loading">Loading memory index...</div>
				{:then mod}
					<mod.default {memories} />
				{:catch err}
					<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
				{/await}
			{:else if activeMemory === "timeline"}
				{#await import("$lib/components/tabs/TimelineTab.svelte")}
					<div class="cortex-loading">Loading timeline...</div>
				{:then mod}
					<mod.default {ontimelinegeneratedforchange} />
				{:catch err}
					<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
				{/await}
			{:else if activeMemory === "knowledge"}
				{#await import("$lib/components/tabs/KnowledgeTab.svelte")}
					<div class="cortex-loading">Loading knowledge graph...</div>
				{:then mod}
					<mod.default />
				{:catch err}
					<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
				{/await}
			{:else if activeMemory === "constellation"}
				{#await import("$lib/components/tabs/EmbeddingsTab.svelte")}
					<div class="cortex-loading">Loading constellation...</div>
				{:then mod}
					<mod.default {onopenglobalsimilar} />
				{:catch err}
					<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
				{/await}
			{/if}
		</div>
	{:else if activeTab === "cortex-apps"}
		<div class="cortex-content">
			{#await import("$lib/components/tabs/OsTab.svelte")}
				<div class="cortex-loading">Loading apps...</div>
			{:then mod}
				<mod.default />
			{:catch err}
				<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
			{/await}
		</div>
	{:else if activeTab === "cortex-tasks"}
		<div class="cortex-content">
			{#await import("$lib/components/cortex/CortexTasksPanel.svelte")}
				<div class="cortex-loading">Loading tasks...</div>
			{:then mod}
				<mod.default />
			{:catch err}
				<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
			{/await}
		</div>
	{:else if activeTab === "cortex-troubleshooter"}
		<div class="cortex-content">
			{#await import("$lib/components/cortex/TroubleshooterPanel.svelte")}
				<div class="cortex-loading">Loading troubleshooter...</div>
			{:then mod}
				<mod.default />
			{:catch err}
				<div class="cortex-error">Failed to load: {err?.message ?? "unknown"}</div>
			{/await}
		</div>
	{/if}
</div>

<style>
	.cortex-tab {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.sub-bar {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2px var(--space-md) var(--space-sm);
		background: transparent;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.sub-group {
		display: flex;
		align-items: center;
		gap: 2px;
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		border-radius: 0.5rem;
		padding: 1px;
	}

	.cortex-content {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	/* Hide the internal PageBanner rendered by memory sub-tab components */
	.cortex-memory-embed :global(.banner) {
		display: none;
	}

	.cortex-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.cortex-error {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-danger);
	}
</style>

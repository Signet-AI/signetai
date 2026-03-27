<script lang="ts">
	import type { TabId } from "$lib/stores/navigation.svelte";
	import type { Memory, MemoryStats, Harness, DaemonStatus } from "$lib/api";
	import UnifiedMemoryTab from "$lib/components/tabs/UnifiedMemoryTab.svelte";

	interface Props {
		activeTab: TabId;
		memories: Memory[];
		agentId: string;
		memoryStats: MemoryStats;
		harnesses: Harness[];
		daemonStatus: DaemonStatus | null;
		onopenglobalsimilar: (memory: Memory) => void;
		ontimelinegeneratedforchange: (value: string) => void;
	}

	const {
		activeTab,
		memories,
		agentId,
		onopenglobalsimilar,
		ontimelinegeneratedforchange,
	}: Props = $props();
</script>

<div class="cortex-tab">
	{#if activeTab === "cortex-memory"}
		<div class="cortex-content">
			<UnifiedMemoryTab {memories} {agentId} {onopenglobalsimilar} />
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

	.cortex-content {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
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

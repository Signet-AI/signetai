<script lang="ts">
import type { TabId } from "$lib/stores/navigation.svelte";
import type {
	ConfigFile,
	DaemonStatus,
	Harness,
	Identity,
	Memory,
	MemoryStats,
} from "$lib/api";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { fade } from "svelte/transition";

interface Props {
	activeTab: TabId;
	identity: Identity;
	configFiles: ConfigFile[];
	memoryStats: MemoryStats;
	harnesses: Harness[];
	daemonStatus: DaemonStatus | null;
	displayMemories: Memory[];
	onopenglobalsimilar: (memory: Memory) => void;
	ontimelinegeneratedforchange: (value: string) => void;
}

const {
	activeTab,
	identity,
	configFiles,
	memoryStats,
	harnesses,
	daemonStatus,
	displayMemories,
	onopenglobalsimilar,
	ontimelinegeneratedforchange,
}: Props = $props();
</script>

{#snippet skeletonError(error: unknown)}
	<div class="flex flex-1 items-center justify-center sig-label text-[var(--sig-danger)]">
		Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
	</div>
{/snippet}

{#snippet skeletonCards()}
	<div class="p-4 space-y-3">
		<Skeleton class="h-9 w-full" />
		<div class="flex gap-2">
			<Skeleton class="h-7 w-24" />
			<Skeleton class="h-7 w-20" />
			<Skeleton class="h-7 w-16" />
		</div>
		<div class="grid grid-cols-3 gap-3">
			{#each Array(6) as _}
				<Skeleton class="h-36 w-full" />
			{/each}
		</div>
	</div>
{/snippet}

{#snippet skeletonList()}
	<div class="p-4 space-y-2">
		<div class="flex gap-2 mb-3">
			<Skeleton class="h-8 w-28" />
			<Skeleton class="h-8 w-28" />
		</div>
		{#each Array(8) as _}
			<Skeleton class="h-8 w-full" />
		{/each}
	</div>
{/snippet}

{#snippet skeletonForm()}
	<div class="p-4 space-y-4 max-w-2xl">
		{#each Array(5) as _}
			<div class="space-y-1.5">
				<Skeleton class="h-3 w-24" />
				<Skeleton class="h-9 w-full" />
			</div>
		{/each}
	</div>
{/snippet}

{#key activeTab}
<div class="tab-transition" in:fade={{ duration: 80 }}>
{#if activeTab === "home"}
	{#await import("$lib/components/tabs/HomeTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default
			{identity}
			memories={displayMemories}
			{memoryStats}
			{harnesses}
			{daemonStatus}
		/>
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "settings"}
	{#await import("$lib/components/tabs/SettingsTab.svelte")}
		{@render skeletonForm()}
	{:then module}
		<module.default {configFiles} />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "memory"}
	{#await import("$lib/components/tabs/MemoryTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default memories={displayMemories} />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "timeline"}
	{#await import("$lib/components/tabs/TimelineTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default ontimelinegeneratedforchange={ontimelinegeneratedforchange} />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "embeddings"}
	{#await import("$lib/components/tabs/EmbeddingsTab.svelte")}
		<div class="flex flex-1 items-center justify-center">
			<Skeleton class="h-64 w-64 rounded-full" />
		</div>
	{:then module}
		<module.default onopenglobalsimilar={onopenglobalsimilar} />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "knowledge"}
	{#await import("$lib/components/tabs/KnowledgeTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "pipeline"}
	{#await import("$lib/components/tabs/PipelineTab.svelte")}
		{@render skeletonList()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "logs"}
	{#await import("$lib/components/tabs/LogsTab.svelte")}
		{@render skeletonList()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "secrets"}
	{#await import("$lib/components/tabs/SecretsTab.svelte")}
		{@render skeletonList()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "skills"}
	{#await import("$lib/components/tabs/MarketplaceTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "tasks"}
	{#await import("$lib/components/tabs/TasksTab.svelte")}
		{@render skeletonList()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "predictor"}
	{#await import("$lib/components/predictor/PredictorTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "connectors"}
	{#await import("$lib/components/tabs/ConnectorsTab.svelte")}
		{@render skeletonList()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "changelog"}
	{#await import("$lib/components/tabs/ChangelogTab.svelte")}
		{@render skeletonList()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "os"}
	{#await import("$lib/components/tabs/OsTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default />
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{:else if activeTab === "cortex-memory" || activeTab === "cortex-apps" || activeTab === "cortex-tasks" || activeTab === "cortex-troubleshooter"}
	{#await import("$lib/components/tabs/CortexTab.svelte")}
		{@render skeletonCards()}
	{:then module}
		<module.default
			{activeTab}
			memories={displayMemories}
			{memoryStats}
			{harnesses}
			{daemonStatus}
			{onopenglobalsimilar}
			{ontimelinegeneratedforchange}
		/>
	{:catch error}
		{@render skeletonError(error)}
	{/await}
{/if}
</div>
{/key}

<style>
	.tab-transition {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
</style>

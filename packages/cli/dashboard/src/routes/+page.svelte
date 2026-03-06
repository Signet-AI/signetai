<script lang="ts">
import { browser } from "$app/environment";
import { type DaemonStatus, type Memory, getStatus } from "$lib/api";
import AppSidebar from "$lib/components/app-sidebar.svelte";
import ExtensionBanner from "$lib/components/ExtensionBanner.svelte";
import GlobalCommandPalette from "$lib/components/command/GlobalCommandPalette.svelte";
import { PAGE_HEADERS } from "$lib/components/layout/page-headers";
import { Button } from "$lib/components/ui/button/index.js";
import * as Sidebar from "$lib/components/ui/sidebar/index.js";
import { Toaster } from "$lib/components/ui/sonner/index.js";
import {
	clearAll,
	clearSearchTimer,
	hasActiveFilters,
	loadWhoOptions,
	mem,
	queueMemorySearch,
} from "$lib/stores/memory.svelte";
import {
	initNavFromHash,
	isEngineGroup,
	isMemoryGroup,
	nav,
	setTab,
} from "$lib/stores/navigation.svelte";
import { openForm, ts } from "$lib/stores/tasks.svelte";
import { hasUnsavedChanges } from "$lib/stores/unsaved-changes.svelte";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import Plus from "@lucide/svelte/icons/plus";
import { onMount } from "svelte";

const activeTab = $derived(nav.activeTab);

const tabBtn = "px-3 py-1 text-[11px] font-medium uppercase tracking-[0.06em] rounded-md transition-colors duration-150 border-none cursor-pointer";
const tabActive = `${tabBtn} bg-[var(--sig-accent)] text-[var(--sig-bg)]`;
const tabInactive = `${tabBtn} bg-transparent text-[var(--sig-text-muted)] hover:bg-[var(--sig-surface-raised)] hover:text-[var(--sig-text-bright)]`;

const { data } = $props();
let daemonStatus = $state<DaemonStatus | null>(null);
let embeddingsPrefetchPromise: Promise<unknown[]> | null = null;
let timelineGeneratedFor = $state("");

// --- Theme ---
let theme = $state<"dark" | "light">("dark");

if (browser) {
	const stored = document.documentElement.dataset.theme;
	theme = stored === "light" || stored === "dark" ? stored : "dark";
}

function toggleTheme() {
	theme = theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = theme;
	localStorage.setItem("signet-theme", theme);
}

// --- Config file selection ---
let selectedFile = $state("");

$effect(() => {
	if (!selectedFile && data.configFiles?.length) {
		selectedFile = data.configFiles[0].name;
	}
});

function selectFile(name: string) {
	selectedFile = name;
	setTab("config");
}

// --- Memory display ---
const memoryDocs = $derived(data.memories ?? []);

const displayMemories = $derived(
	mem.similarSourceId ? mem.similarResults : mem.searched || hasActiveFilters() ? mem.results : memoryDocs,
);

// --- Filter reactivity ---
$effect(() => {
	const _ = mem.filterType,
		__ = mem.filterTags,
		___ = mem.filterWho,
		____ = mem.filterPinned,
		_____ = mem.filterImportanceMin,
		______ = mem.filterSince;
	if (hasActiveFilters() || mem.searched) {
		queueMemorySearch();
	}
});

// --- Embeddings bridge ---
function openGlobalSimilar(memory: Memory) {
	mem.query = memory.content;
	setTab("memory");
	queueMemorySearch();
}

function prefetchEmbeddingsTab(): void {
	if (!browser) return;
	if (embeddingsPrefetchPromise) return;

	embeddingsPrefetchPromise = Promise.all([
		import("$lib/components/tabs/EmbeddingsTab.svelte"),
		import("3d-force-graph"),
	]);
}

function handleTimelineGeneratedForChange(value: string): void {
	timelineGeneratedFor = value;
}

function formatTimelineGeneratedFor(value: string): string {
	if (!value) return "";
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return "";
	return new Date(parsed).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	});
}

// --- Cleanup ---
$effect(() => {
	return () => {
		clearSearchTimer();
	};
});

// --- Init ---
onMount(() => {
	const cleanupNav = initNavFromHash();

	getStatus().then((s) => {
		daemonStatus = s;
	});
	loadWhoOptions();

	const handleBeforeUnload = (event: BeforeUnloadEvent) => {
		if (!hasUnsavedChanges()) return;
		event.preventDefault();
		event.returnValue = "";
	};

	window.addEventListener("beforeunload", handleBeforeUnload);

	return () => {
		cleanupNav();
		window.removeEventListener("beforeunload", handleBeforeUnload);
	};
});
</script>

<svelte:head>
	<title>Signet</title>
</svelte:head>

<Sidebar.Provider>
	<AppSidebar
		identity={data.identity}
		harnesses={data.harnesses}
		memCount={data.memoryStats?.total ?? 0}
		{daemonStatus}
		{theme}
		onthemetoggle={toggleTheme}
		onprefetchembeddings={prefetchEmbeddingsTab}
	/>
	<main class="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden
		m-2 ml-0 rounded-lg border border-[var(--sig-border)] md:border-l-0
		bg-[var(--sig-surface)]">
		<header
			class="flex h-12 shrink-0 items-center justify-between
				border-b border-[var(--sig-border)] px-4"
		>
			<div class="flex items-center gap-2">
				<Sidebar.Trigger class="-ml-1" />
				<span class="sig-heading">
					{PAGE_HEADERS[activeTab].title}
				</span>
				{#if !isMemoryGroup(activeTab) && !isEngineGroup(activeTab)}
					<span class="sig-eyebrow tracking-[0.1em]">&middot;</span>
					<span class="sig-eyebrow tracking-[0.1em]">
						{PAGE_HEADERS[activeTab].eyebrow}
					</span>
				{/if}

				{#if isMemoryGroup(activeTab)}
					<span class="ml-1 w-px h-4 bg-[var(--sig-border)]"></span>
					<div class="flex items-center gap-px
						border border-[var(--sig-border)] rounded-lg p-px">
						<button
							class={activeTab === 'memory' ? tabActive : tabInactive}
							onclick={() => setTab("memory")}
						>Index</button>
						<button
							class={activeTab === 'timeline' ? tabActive : tabInactive}
							onclick={() => setTab("timeline")}
						>Timeline</button>
						<button
							class={activeTab === 'knowledge' ? tabActive : tabInactive}
							onclick={() => setTab("knowledge")}
						>Knowledge</button>
						<button
							class={activeTab === 'embeddings' ? tabActive : tabInactive}
							onclick={() => setTab("embeddings")}
						>Constellation</button>
					</div>
				{:else if isEngineGroup(activeTab)}
					<span class="ml-1 w-px h-4 bg-[var(--sig-border)]"></span>
					<div class="flex items-center gap-px
						border border-[var(--sig-border)] rounded-lg p-px">
						<button
							class={activeTab === 'settings' ? tabActive : tabInactive}
							onclick={() => setTab("settings")}
						>Settings</button>
						<button
							class={activeTab === 'pipeline' ? tabActive : tabInactive}
							onclick={() => setTab("pipeline")}
						>Pipeline</button>
						<button
							class={activeTab === 'predictor' ? tabActive : tabInactive}
							onclick={() => setTab("predictor")}
						>Predictor</button>
						<button
							class={activeTab === 'connectors' ? tabActive : tabInactive}
							onclick={() => setTab("connectors")}
						>Connectors</button>
						<button
							class={activeTab === 'logs' ? tabActive : tabInactive}
							onclick={() => setTab("logs")}
						>Logs</button>
					</div>
				{/if}
			</div>
			<div class="flex items-center gap-3">
				{#if activeTab === "memory"}
					<span class="sig-label">
						{displayMemories.length} documents
					</span>
					{#if mem.searching}
						<span class="sig-label">
							searching...
						</span>
					{/if}
					{#if mem.searched || hasActiveFilters() || mem.similarSourceId}
						<Button
							variant="ghost"
							size="sm"
							class="sig-label text-[var(--sig-accent)] hover:underline p-0 h-auto"
							onclick={clearAll}
						>
							Reset
						</Button>
					{/if}
				{:else if activeTab === "timeline"}
					<span class="sig-label">
						Era timeline
					</span>
				{:else if activeTab === "pipeline"}
					<span class="sig-label">
						Memory loop
					</span>
				{:else if activeTab === "embeddings"}
					<span class="sig-label">
						Constellation
					</span>
				{:else if activeTab === "knowledge"}
					<span class="sig-label">
						Knowledge graph
					</span>
				{:else if activeTab === "tasks"}
					<Button
						variant="outline"
						size="sm"
						class="h-7 gap-1.5 text-[11px]"
						onclick={() => openForm()}
					>
						<Plus class="size-3.5" />
						New Task
					</Button>
				{/if}
			</div>
		</header>

		<ExtensionBanner />

		<div class="flex flex-1 flex-col min-h-0 relative">
			{#snippet skeletonError(error: unknown)}
				<div class="flex flex-1 items-center justify-center sig-label text-[var(--sig-danger)]">
					Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
				</div>
			{/snippet}

			{#snippet skeletonEditor()}
				<div class="flex flex-1 min-h-0">
					<div class="w-48 border-r border-[var(--sig-border)] p-3 space-y-2">
						<Skeleton class="h-4 w-full" />
						<Skeleton class="h-4 w-3/4" />
						<Skeleton class="h-4 w-5/6" />
						<Skeleton class="h-4 w-2/3" />
					</div>
					<div class="flex-1 p-4 space-y-2">
						{#each Array(12) as _}
							<Skeleton class="h-3.5 w-full" />
						{/each}
						<Skeleton class="h-3.5 w-2/3" />
					</div>
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

			{#if activeTab === "config"}
				{#await import("$lib/components/tabs/ConfigTab.svelte")}
					{@render skeletonEditor()}
				{:then module}
					<module.default
						configFiles={data.configFiles}
						{selectedFile}
						onselectfile={selectFile}
					/>
				{:catch error}
					{@render skeletonError(error)}
				{/await}
			{:else if activeTab === "settings"}
				{#await import("$lib/components/tabs/SettingsTab.svelte")}
					{@render skeletonForm()}
				{:then module}
					<module.default configFiles={data.configFiles} />
				{:catch error}
					{@render skeletonError(error)}
				{/await}
			{:else if activeTab === "memory"}
				{#await import("$lib/components/tabs/MemoryTab.svelte")}
					{@render skeletonCards()}
				{:then module}
					<module.default memories={memoryDocs} />
				{:catch error}
					{@render skeletonError(error)}
				{/await}
			{:else if activeTab === "timeline"}
				{#await import("$lib/components/tabs/TimelineTab.svelte")}
					{@render skeletonCards()}
				{:then module}
					<module.default ontimelinegeneratedforchange={handleTimelineGeneratedForChange} />
				{:catch error}
					{@render skeletonError(error)}
				{/await}
			{:else if activeTab === "embeddings"}
				{#await import("$lib/components/tabs/EmbeddingsTab.svelte")}
					<div class="flex flex-1 items-center justify-center">
						<Skeleton class="h-64 w-64 rounded-full" />
					</div>
				{:then module}
					<module.default onopenglobalsimilar={openGlobalSimilar} />
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
				{#await import("$lib/components/tabs/PredictorTab.svelte")}
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
			{/if}
		</div>

		{#if activeTab !== "skills"}
		<div
			class="flex items-center justify-between h-[26px] px-4
				border-t border-[var(--sig-border)]
				bg-[var(--sig-surface)]
				sig-eyebrow shrink-0"
		>
			{#if activeTab === "config"}
				<span>{selectedFile}</span>
				<span class="flex items-center gap-2">
					<kbd class="px-1 py-px text-[10px] text-[var(--sig-text-muted)]
						bg-[var(--sig-surface-raised)]"
					>Cmd+S</kbd> save
				</span>
			{:else if activeTab === "settings"}
				<span>YAML settings</span>
				<span>agent.yaml</span>
			{:else if activeTab === "memory"}
				<span>{displayMemories.length} memory documents</span>
				<span>
					{#if mem.searching}
						semantic search in progress
					{:else if mem.similarSourceId}
						similarity mode
					{:else}
						hybrid search index
					{/if}
				</span>
			{:else if activeTab === "timeline"}
				<span>timeline eras</span>
				<span>
					{#if timelineGeneratedFor}
						As of {formatTimelineGeneratedFor(timelineGeneratedFor)}
					{:else}
						memory evolution view
					{/if}
				</span>
			{:else if activeTab === "pipeline"}
				<span>Pipeline</span>
				<span>memory loop v2</span>
			{:else if activeTab === "embeddings"}
				<span>Constellation</span>
				<span>UMAP</span>
			{:else if activeTab === "knowledge"}
				<span>structural graph browser</span>
				<span>entities, traversal, predictor slices</span>
			{:else if activeTab === "logs"}
				<span>Log viewer</span>
				<span>daemon logs</span>
			{:else if activeTab === "secrets"}
				<span>Secrets</span>
				<span>libsodium</span>
			{:else if activeTab === "tasks"}
				<span>{ts.tasks.length} scheduled tasks</span>
				<span>cron scheduler</span>
			{:else if activeTab === "connectors"}
				<span>platform harnesses + data sources</span>
				<span>connector health</span>
			{/if}
		</div>
		{/if}
	</main>
</Sidebar.Provider>

<GlobalCommandPalette />

<Toaster
	position="bottom-right"
	toastOptions={{
		class: "!font-[family-name:var(--font-mono)] !text-[12px] !border-[var(--sig-border-strong)] !bg-[var(--sig-surface-raised)] !text-[var(--sig-text-bright)]",
	}}
/>

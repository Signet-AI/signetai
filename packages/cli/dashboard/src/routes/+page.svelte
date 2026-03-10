<script lang="ts">
import { browser } from "$app/environment";
import { type DaemonStatus, type Memory, getStatus } from "$lib/api";
import ExtensionBanner from "$lib/components/ExtensionBanner.svelte";
import UpgradeBanner from "$lib/components/UpgradeBanner.svelte";
import AppSidebar from "$lib/components/app-sidebar.svelte";
import GlobalCommandPalette from "$lib/components/command/GlobalCommandPalette.svelte";
import PageFooter from "$lib/components/layout/PageFooter.svelte";
import TabContentLoader from "$lib/components/layout/TabContentLoader.svelte";
import * as Sidebar from "$lib/components/ui/sidebar/index.js";
import { Toaster } from "$lib/components/ui/sonner/index.js";
import { focus } from "$lib/stores/focus.svelte";
import {
	clearAll,
	clearSearchTimer,
	hasActiveFilters,
	loadWhoOptions,
	mem,
	queueMemorySearch,
} from "$lib/stores/memory.svelte";
import { type TabId, initNavFromHash, isEngineGroup, isMemoryGroup, nav, setTab } from "$lib/stores/navigation.svelte";
import {
	ENGINE_TABS,
	MEMORY_TABS,
	focusEngineTab,
	focusMemoryTab,
	handleFocusIn,
	handleGlobalKey,
	handlePageClick,
	indexOfString,
	initTabGroupEffects,
	tabFocus,
} from "$lib/stores/tab-group-focus.svelte";
import { openForm, ts } from "$lib/stores/tasks.svelte";
import { hasUnsavedChanges } from "$lib/stores/unsaved-changes.svelte";
import { onMount } from "svelte";

const activeTab = $derived(nav.activeTab);
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

// --- Memory display ---
const memoryDocs = $derived(data.memories ?? []);
const totalMemoryDocs = $derived(data.memoryStats?.total ?? memoryDocs.length);

const displayMemories = $derived(
	mem.similarSourceId ? mem.similarResults : mem.searched || hasActiveFilters() ? mem.results : memoryDocs,
);

const memoryDocumentsLabel = $derived.by(() => {
	if (mem.similarSourceId || mem.searched || hasActiveFilters()) {
		return `${displayMemories.length} documents`;
	}
	if (totalMemoryDocs > memoryDocs.length) {
		return `${memoryDocs.length} recent of ${totalMemoryDocs}`;
	}
	return `${displayMemories.length} documents`;
});

const memoryFooterLabel = $derived.by(() => {
	if (mem.similarSourceId || mem.searched || hasActiveFilters()) {
		return `${displayMemories.length} memory documents`;
	}
	if (totalMemoryDocs > memoryDocs.length) {
		return `${memoryDocs.length} recent of ${totalMemoryDocs} memory documents`;
	}
	return `${displayMemories.length} memory documents`;
});

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

// --- Tab group select handlers (delegate to store helpers) ---
function handleMemorySelect(_tab: TabId, index: number): void {
	focusMemoryTab(index);
}

function handleEngineSelect(_tab: TabId, index: number): void {
	focusEngineTab(index);
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
	const cleanupTabGroups = initTabGroupEffects();

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
		cleanupTabGroups();
		window.removeEventListener("beforeunload", handleBeforeUnload);
	};
});

// --- Sync $effects for tab group focus ---
$effect(() => {
	if (isEngineGroup(activeTab) && focus.zone === "page-content" && tabFocus.keyboardNavActive) {
		const index = indexOfString(ENGINE_TABS, activeTab);
		if (index !== -1) {
			tabFocus.engineIndex = index;
			tabFocus.engineFocus = "tabs";
			const tabButton = document.querySelector(`[data-engine-tab="${ENGINE_TABS[index]}"]`);
			if (tabButton instanceof HTMLElement) {
				tabButton.focus();
			}
		}
	}
});

$effect(() => {
	if (isMemoryGroup(activeTab) && focus.zone === "page-content" && tabFocus.keyboardNavActive) {
		const index = indexOfString(MEMORY_TABS, activeTab);
		if (index !== -1) {
			tabFocus.memoryIndex = index;
			tabFocus.memoryFocus = "tabs";
			const tabButton = document.querySelector(`[data-memory-tab="${MEMORY_TABS[index]}"]`);
			if (tabButton instanceof HTMLElement) {
				tabButton.focus();
			}
		}
	}
});
</script>

<svelte:head>
	<title>Signet</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKey} onfocusin={handleFocusIn} onclick={handlePageClick} />

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
	<main data-page-content="true" class="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden
		mr-2 rounded-br-lg border border-[var(--sig-border-strong)] border-l-0 border-t-0 border-b-0
		bg-[var(--sig-surface)]">

		<UpgradeBanner {daemonStatus} />
		<ExtensionBanner />

		<div class="flex flex-1 flex-col min-h-0 relative" data-tab-panel-active="true">
			<TabContentLoader
				{activeTab}
				identity={data.identity}
				configFiles={data.configFiles}
				memoryStats={data.memoryStats}
				harnesses={data.harnesses}
				{daemonStatus}
				{displayMemories}
				onopenglobalsimilar={openGlobalSimilar}
				ontimelinegeneratedforchange={handleTimelineGeneratedForChange}
			/>
		</div>

		<PageFooter
			{activeTab}
			{memoryFooterLabel}
			memorySearching={mem.searching}
			memorySimilarActive={!!mem.similarSourceId}
			{timelineGeneratedFor}
			taskCount={ts.tasks.length}
		/>
	</main>
</Sidebar.Provider>

<GlobalCommandPalette />

<Toaster
	position="bottom-right"
	toastOptions={{
		class: "!font-[family-name:var(--font-mono)] !text-[12px] !border-[var(--sig-border-strong)] !bg-[var(--sig-surface-raised)] !text-[var(--sig-text-bright)]",
	}}
/>

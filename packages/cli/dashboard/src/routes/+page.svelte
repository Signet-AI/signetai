<script lang="ts">
import { browser } from "$app/environment";
import { type DaemonStatus, type Memory, getStatus } from "$lib/api";
import ExtensionBanner from "$lib/components/ExtensionBanner.svelte";
import UpgradeBanner from "$lib/components/UpgradeBanner.svelte";
import AppSidebar from "$lib/components/app-sidebar.svelte";
import GlobalCommandPalette from "$lib/components/command/GlobalCommandPalette.svelte";
import PageFooter from "$lib/components/layout/PageFooter.svelte";
import TabContentLoader from "$lib/components/layout/TabContentLoader.svelte";
import WindowTitlebar from "$lib/components/layout/WindowTitlebar.svelte";
import * as Sidebar from "$lib/components/ui/sidebar/index.js";
import { Toaster } from "$lib/components/ui/sonner/index.js";
import { isDesktopShell } from "$lib/desktop-shell";
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
import { titlebar } from "$lib/stores/titlebar.svelte";
import { uiScale } from "$lib/stores/ui-scale.svelte";
import { hasUnsavedChanges } from "$lib/stores/unsaved-changes.svelte";
import { onMount } from "svelte";

const activeTab = $derived(nav.activeTab);
const { data } = $props();
const agentId = $derived.by(() => {
	if (typeof window === "undefined") return "default";
	return new URLSearchParams(window.location.search).get("agent_id") ?? "default";
});
let daemonStatus = $state<DaemonStatus | null>(null);
// biome-ignore lint/style/useConst: Svelte state is rebound by UpgradeBanner.
let bannerShowing = $state(false);
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
	const _ = mem.filterType;
	const __ = mem.filterTags;
	const ___ = mem.filterWho;
	const ____ = mem.filterPinned;
	const _____ = mem.filterImportanceMin;
	const ______ = mem.filterSince;
	if (hasActiveFilters() || mem.searched) {
		queueMemorySearch();
	}
});

// --- Embeddings bridge ---
function openGlobalSimilar(memory: Memory) {
	mem.query = memory.content;
	setTab("cortex-memory");
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

	// Ctrl+scroll wheel zoom — only in the desktop shell (web build preserves native browser zoom).
	// Modifier check is inlined so non-ctrl scrolls exit immediately, minimising the
	// cost of the { passive: false } constraint on ordinary scrolling.
	const isDesktop = isDesktopShell();
	const handleWheel = (e: WheelEvent) => {
		if (!(e.ctrlKey || e.metaKey)) return;
		e.preventDefault();
		if (e.deltaY < 0) uiScale.zoomIn();
		else if (e.deltaY > 0) uiScale.zoomOut();
	};
	if (isDesktop) {
		window.addEventListener("wheel", handleWheel, { passive: false });
	}

	return () => {
		cleanupNav();
		cleanupTabGroups();
		window.removeEventListener("beforeunload", handleBeforeUnload);
		if (isDesktop) {
			window.removeEventListener("wheel", handleWheel);
		}
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

<svelte:window
	onkeydown={(e) => {
		const isDesktop = isDesktopShell();
		if (isDesktop && uiScale.handleZoomKey(e)) return;
		handleGlobalKey(e);
	}}
	onfocusin={handleFocusIn}
	onclick={handlePageClick}
/>

<div
	class="flex flex-col h-screen overflow-hidden"
	style="--titlebar-h: {titlebar.visible ? titlebar.height : 0}px; width: var(--scaled-viewport-width, 100vw); height: var(--scaled-viewport-height, 100vh);"
>
<WindowTitlebar />

<Sidebar.Provider class="!h-full flex-1 min-h-0">
	<AppSidebar
		identity={data.identity}
		harnesses={data.harnesses}
		memCount={data.memoryStats?.total ?? 0}
		{daemonStatus}
		{theme}
		onthemetoggle={toggleTheme}
		onprefetchembeddings={prefetchEmbeddingsTab}
	/>
	<Sidebar.Trigger
		unstyled={true}
		class="mobile-sidebar-trigger fixed z-40 size-5 p-0 bg-transparent border-none shadow-none rounded-sm hover:bg-[color-mix(in_srgb,var(--sig-surface-raised)_60%,transparent)] transition-all items-center justify-center flex"
		style="top: calc(var(--titlebar-h, 0px) + var(--space-sm, 8px) + 3px + {bannerShowing ? '24px' : '0px'}); left: calc(var(--space-sm, 8px) + 1px);"
		mobileOnly={true}
	>
		<span
			class="inline-block size-3.5 shrink-0 relative
				before:absolute before:w-px before:h-full before:left-1/2
				before:bg-[var(--sig-highlight)]
				after:absolute after:w-full after:h-px after:top-1/2
				after:bg-[var(--sig-highlight)]"
			style="filter: drop-shadow(0 0 3px var(--sig-highlight));"
			aria-hidden="true"
		></span>
	</Sidebar.Trigger>
	<main data-page-content="true" class="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden
		bg-[var(--sig-bg)]">

		<UpgradeBanner {daemonStatus} bind:showing={bannerShowing} />
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
				{agentId}
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
</div>

<GlobalCommandPalette />

<Toaster
	position="bottom-right"
	toastOptions={{
		class: "!font-[family-name:var(--font-mono)] !text-[12px] !border-[var(--sig-border-strong)] !bg-[var(--sig-surface-raised)] !text-[var(--sig-text-bright)]",
	}}
/>

<style>
	@media (prefers-reduced-motion: reduce) {
		:global(.mobile-sidebar-trigger) {
			transition: none !important;
		}
	}
</style>

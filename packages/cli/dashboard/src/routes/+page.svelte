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
import {
	focus,
	returnToSidebar,
	setFocusZone,
	focusFirstPageElement,
	type SidebarFocusItem,
} from "$lib/stores/focus.svelte";
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

	// Listen for custom events from child tabs to focus tab bars
	const handleMemoryFocusTabs = () => {
		focusMemoryTab(memoryTabIndex);
	};
	const handleEngineFocusTabs = () => {
		focusEngineTab(engineTabIndex);
	};
	window.addEventListener("memory-focus-tabs", handleMemoryFocusTabs);
	window.addEventListener("engine-focus-tabs", handleEngineFocusTabs);

	return () => {
		cleanupNav();
		window.removeEventListener("beforeunload", handleBeforeUnload);
		window.removeEventListener("memory-focus-tabs", handleMemoryFocusTabs);
		window.removeEventListener("engine-focus-tabs", handleEngineFocusTabs);
	};
});

// --- Global keyboard navigation ---
let keyboardNavActive = $state(false);
let engineTabFocus = $state<"tabs" | "content">("tabs");
let engineTabIndex = $state(0);
const ENGINE_TABS = ["settings", "pipeline", "connectors", "logs"] as const;

let memoryTabFocus = $state<"tabs" | "content">("tabs");
let memoryTabIndex = $state(0);
const MEMORY_TABS = ["memory", "timeline", "embeddings"] as const;

function focusEngineTab(index: number): void {
	engineTabIndex = index;
	engineTabFocus = "tabs";
	setTab(ENGINE_TABS[index]);

	// Focus the tab button
	const tabButton = document.querySelector(`[data-engine-tab="${ENGINE_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

function focusEngineContent(): void {
	engineTabFocus = "content";
	focusFirstPageElement();
}

function focusMemoryTab(index: number): void {
	memoryTabIndex = index;
	memoryTabFocus = "tabs";
	setTab(MEMORY_TABS[index]);

	// Focus the tab button
	const tabButton = document.querySelector(`[data-memory-tab="${MEMORY_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

function focusMemoryContent(): void {
	memoryTabFocus = "content";
	focusFirstPageElement();
}

function handleGlobalKey(e: KeyboardEvent) {
	const target = e.target as HTMLElement;
	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	// Don't interfere with input fields when page has focus
	if (isInputFocused && focus.zone === "page-content") return;

	keyboardNavActive = true;

	// Handle Escape from page content to return to sidebar
	if (focus.zone === "page-content" && e.key === "Escape") {
		// If a child tab already handled Escape, don't double-handle
		if (e.defaultPrevented) return;

		// Check for open modals/dialogs first
		const modalOpen =
			ts.formOpen ||
			ts.detailOpen ||
			mem.formOpen ||
			document.querySelector('[role="dialog"][data-state="open"]');

		if (!modalOpen) {
			e.preventDefault();
			// If in Engine group and focused on content, return to tabs first
			if (isEngineGroup(activeTab) && engineTabFocus === "content") {
				focusEngineTab(engineTabIndex);
			} else if (isMemoryGroup(activeTab) && memoryTabFocus === "content") {
				focusMemoryTab(memoryTabIndex);
			} else {
				returnToSidebar();
			}
		}
	}

	// Handle Engine tab group navigation
	if (isEngineGroup(activeTab) && focus.zone === "page-content" && !isInputFocused && !e.defaultPrevented) {
		if (engineTabFocus === "tabs") {
			// Navigate between tabs
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (engineTabIndex === 0) {
					// At first tab, return to sidebar
					returnToSidebar();
				} else {
					focusEngineTab(engineTabIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusEngineTab((engineTabIndex + 1) % ENGINE_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusEngineContent();
			}
		} else if (engineTabFocus === "content") {
			// Navigate from content back to tabs
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusEngineTab(engineTabIndex);
			}
			// ArrowLeft is handled by individual tabs for internal navigation
			// but if they don't consume it, it bubbles up - we should ignore it
		}
	}

	// Handle Memory tab group navigation
	if (isMemoryGroup(activeTab) && focus.zone === "page-content" && !isInputFocused && !e.defaultPrevented) {
		if (memoryTabFocus === "tabs") {
			// Navigate between tabs
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (memoryTabIndex === 0) {
					// At first tab, return to sidebar
					returnToSidebar();
				} else {
					focusMemoryTab(memoryTabIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusMemoryTab((memoryTabIndex + 1) % MEMORY_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusMemoryContent();
			}
		} else if (memoryTabFocus === "content") {
			// Navigate from content back to tabs
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusMemoryTab(memoryTabIndex);
			}
			// ArrowRight/Left at content level are handled by individual tabs
		}
	}
}

// Initialize engine tab focus when navigating to engine group via keyboard
$effect(() => {
	if (isEngineGroup(activeTab) && focus.zone === "page-content" && keyboardNavActive) {
		const index = ENGINE_TABS.indexOf(activeTab as typeof ENGINE_TABS[number]);
		if (index !== -1) {
			engineTabIndex = index;
			engineTabFocus = "tabs";
			const tabButton = document.querySelector(`[data-engine-tab="${ENGINE_TABS[index]}"]`);
			if (tabButton instanceof HTMLElement) {
				tabButton.focus();
			}
		}
	}
});

// Initialize memory tab focus when navigating to memory group via keyboard
$effect(() => {
	if (isMemoryGroup(activeTab) && focus.zone === "page-content" && keyboardNavActive) {
		const index = MEMORY_TABS.indexOf(activeTab as typeof MEMORY_TABS[number]);
		if (index !== -1) {
			memoryTabIndex = index;
			memoryTabFocus = "tabs";
			const tabButton = document.querySelector(`[data-memory-tab="${MEMORY_TABS[index]}"]`);
			if (tabButton instanceof HTMLElement) {
				tabButton.focus();
			}
		}
	}
});

// Sync focus state when focus changes via mouse
function handleFocusIn(e: FocusEvent) {
	const target = e.target as HTMLElement;

	// Check if focus moved to sidebar
	const sidebarItem = target.closest('[data-sidebar-item]');
	if (sidebarItem) {
		const item = sidebarItem.getAttribute('data-sidebar-item') as SidebarFocusItem;
		if (item && focus.sidebarItem !== item) {
			focus.zone = 'sidebar-menu';
			focus.sidebarItem = item;
		}
		return;
	}

	// Check if focus moved to a tab button — always sync state
	const engineTab = target.closest('[data-engine-tab]');
	if (engineTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const tabName = engineTab.getAttribute('data-engine-tab') as typeof ENGINE_TABS[number];
		const index = ENGINE_TABS.indexOf(tabName);
		if (index !== -1) {
			engineTabIndex = index;
			engineTabFocus = "tabs";
		}
		return;
	}

	const memoryTab = target.closest('[data-memory-tab]');
	if (memoryTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const tabName = memoryTab.getAttribute('data-memory-tab') as typeof MEMORY_TABS[number];
		const index = MEMORY_TABS.indexOf(tabName);
		if (index !== -1) {
			memoryTabIndex = index;
			memoryTabFocus = "tabs";
		}
		return;
	}

	// Check if focus is in page content
	const pageContent = target.closest('[data-page-content="true"]');
	if (pageContent && focus.zone !== 'page-content') {
		setFocusZone('page-content');

		// Sync keyboard navigation state — set "content" if focus is on
		// a non-tab-button element (e.g. an input inside the page)
		if (isEngineGroup(activeTab)) {
			const index = ENGINE_TABS.indexOf(activeTab as typeof ENGINE_TABS[number]);
			if (index !== -1) {
				engineTabIndex = index;
				const isOnTabButton = !!target.closest('[data-engine-tab]');
				engineTabFocus = isOnTabButton ? "tabs" : "content";
			}
		} else if (isMemoryGroup(activeTab)) {
			const index = MEMORY_TABS.indexOf(activeTab as typeof MEMORY_TABS[number]);
			if (index !== -1) {
				memoryTabIndex = index;
				const isOnTabButton = !!target.closest('[data-memory-tab]');
				memoryTabFocus = isOnTabButton ? "tabs" : "content";
			}
		}
		return;
	}
}

// Handle mouse clicks to sync keyboard navigation state
function handlePageClick(e: MouseEvent) {
	keyboardNavActive = false;

	// Only handle clicks in page content area
	const pageContent = (e.target as HTMLElement).closest('[data-page-content="true"]');
	if (!pageContent) return;

	// Ensure focus zone is set to page-content
	if (focus.zone !== 'page-content') {
		setFocusZone('page-content');
	}

	// Check if click landed on a tab button — set tabs mode; otherwise content mode
	const clickedEngineTab = (e.target as HTMLElement).closest('[data-engine-tab]');
	const clickedMemoryTab = (e.target as HTMLElement).closest('[data-memory-tab]');

	if (isEngineGroup(activeTab)) {
		const index = ENGINE_TABS.indexOf(activeTab as typeof ENGINE_TABS[number]);
		if (index !== -1) {
			engineTabIndex = index;
			engineTabFocus = clickedEngineTab ? "tabs" : "content";
		}
	} else if (isMemoryGroup(activeTab)) {
		const index = MEMORY_TABS.indexOf(activeTab as typeof MEMORY_TABS[number]);
		if (index !== -1) {
			memoryTabIndex = index;
			memoryTabFocus = clickedMemoryTab ? "tabs" : "content";
		}
	}
}

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
							data-memory-tab="memory"
							class={activeTab === 'memory' ? tabActive : tabInactive}
							onclick={() => {
								memoryTabIndex = 0;
								memoryTabFocus = "tabs";
								setTab("memory");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-memory-tab="memory"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
						>Index</button>
						<button
							data-memory-tab="timeline"
							class={activeTab === 'timeline' ? tabActive : tabInactive}
							onclick={() => {
								memoryTabIndex = 1;
								memoryTabFocus = "tabs";
								setTab("timeline");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-memory-tab="timeline"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
						>Timeline</button>
						<button
							data-memory-tab="embeddings"
							class={activeTab === 'embeddings' ? tabActive : tabInactive}
							onclick={() => {
								memoryTabIndex = 2;
								memoryTabFocus = "tabs";
								setTab("embeddings");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-memory-tab="embeddings"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
						>Constellation</button>
					</div>
				{:else if isEngineGroup(activeTab)}
					<span class="ml-1 w-px h-4 bg-[var(--sig-border)]"></span>
					<div class="flex items-center gap-px
						border border-[var(--sig-border)] rounded-lg p-px">
						<button
							data-engine-tab="settings"
							class={activeTab === 'settings' ? tabActive : tabInactive}
							onclick={() => {
								engineTabIndex = 0;
								engineTabFocus = "tabs";
								setTab("settings");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-engine-tab="settings"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
						>Settings</button>
						<button
							data-engine-tab="pipeline"
							class={activeTab === 'pipeline' ? tabActive : tabInactive}
							onclick={() => {
								engineTabIndex = 1;
								engineTabFocus = "tabs";
								setTab("pipeline");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-engine-tab="pipeline"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
						>Pipeline</button>
						<button
							data-engine-tab="connectors"
							class={activeTab === 'connectors' ? tabActive : tabInactive}
							onclick={() => {
								engineTabIndex = 2;
								engineTabFocus = "tabs";
								setTab("connectors");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-engine-tab="connectors"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
						>Connectors</button>
						<button
							data-engine-tab="logs"
							class={activeTab === 'logs' ? tabActive : tabInactive}
							onclick={() => {
								engineTabIndex = 3;
								engineTabFocus = "tabs";
								setTab("logs");
								// Focus the clicked tab button
								const tabButton = document.querySelector('[data-engine-tab="logs"]');
								if (tabButton instanceof HTMLElement) {
									tabButton.focus();
								}
							}}
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

		<div class="flex flex-1 flex-col min-h-0 relative" data-tab-panel-active="true">
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

<script lang="ts">
	import { onMount } from "svelte";
	import { browser } from "$app/environment";
	import { getStatus, type DaemonStatus, type Memory } from "$lib/api";
import {
	mem,
		hasActiveFilters,
		clearAll,
		clearSearchTimer,
		queueMemorySearch,
		loadWhoOptions,
} from "$lib/stores/memory.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { hasUnsavedChanges } from "$lib/stores/unsaved-changes.svelte";
	import { sk } from "$lib/stores/skills.svelte";
	import { ts, openForm } from "$lib/stores/tasks.svelte";
	import { PAGE_HEADERS } from "$lib/components/layout/page-headers";
	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import Plus from "@lucide/svelte/icons/plus";
	import AppSidebar from "$lib/components/app-sidebar.svelte";
	import { Toaster } from "$lib/components/ui/sonner/index.js";

	let activeTab = $derived(nav.activeTab);

	let { data } = $props();
	let daemonStatus = $state<DaemonStatus | null>(null);

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
		nav.activeTab = "config";
	}

	// --- Memory display ---
	let memoryDocs = $derived(data.memories ?? []);

	let displayMemories = $derived(
		mem.similarSourceId
			? mem.similarResults
			: mem.searched || hasActiveFilters()
				? mem.results
				: memoryDocs,
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
		nav.activeTab = "memory";
		queueMemorySearch();
	}

	// --- Cleanup ---
	$effect(() => {
		return () => {
			clearSearchTimer();
		};
	});

	// --- Init ---
onMount(() => {
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
	/>
	<main class="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden
		m-2 ml-0 rounded-lg border border-[var(--sig-border)] md:border-l-0
		bg-[var(--sig-surface)]">
		<header
			class="flex h-10 shrink-0 items-center justify-between
				border-b border-[var(--sig-border)] px-4"
		>
			<div class="flex items-center gap-2">
				<Sidebar.Trigger class="-ml-1" />
				<span
					class="text-[11px] font-bold uppercase tracking-[0.1em]
						text-[var(--sig-text-bright)]
						font-[family-name:var(--font-display)]"
				>
					{PAGE_HEADERS[activeTab].title}
				</span>
				<span class="text-[10px] text-[var(--sig-text-muted)]">&middot;</span>
				<span
					class="text-[10px] uppercase tracking-[0.1em]
						text-[var(--sig-text-muted)]
						font-[family-name:var(--font-mono)]"
				>
					{PAGE_HEADERS[activeTab].eyebrow}
				</span>
			</div>
			<div class="flex items-center gap-3">
				{#if activeTab === "memory"}
					<span class="text-[11px] text-[var(--sig-text-muted)]">
						{displayMemories.length} documents
					</span>
					{#if mem.searching}
						<span class="text-[11px] text-[var(--sig-text-muted)]">
							searching...
						</span>
					{/if}
					{#if mem.searched || hasActiveFilters() || mem.similarSourceId}
						<button
							class="text-[11px] text-[var(--sig-accent)]
								bg-transparent border-none cursor-pointer
								hover:underline p-0"
							onclick={clearAll}
						>
							Reset
						</button>
					{/if}
				{:else if activeTab === "pipeline"}
					<span class="text-[11px] text-[var(--sig-text-muted)]">
						Memory loop
					</span>
				{:else if activeTab === "embeddings"}
					<span class="text-[11px] text-[var(--sig-text-muted)]">
						Constellation
					</span>
				{:else if activeTab === "skills"}
					<span class="text-[10px] text-[var(--sig-text-muted)]
						font-[family-name:var(--font-mono)]">
						{#if sk.catalogTotal}
							{sk.catalogTotal.toLocaleString()} available
							<span class="text-[var(--sig-border-strong)]">&middot;</span>
						{/if}
						{sk.installed.length} installed
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

		<div class="flex flex-1 flex-col min-h-0 relative">
			{#if activeTab === "config"}
				{#await import("$lib/components/tabs/ConfigTab.svelte") then module}
					<module.default
						configFiles={data.configFiles}
						{selectedFile}
						onselectfile={selectFile}
					/>
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "settings"}
				{#await import("$lib/components/tabs/SettingsTab.svelte") then module}
					<module.default configFiles={data.configFiles} />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "memory"}
				{#await import("$lib/components/tabs/MemoryTab.svelte") then module}
					<module.default memories={memoryDocs} />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "embeddings"}
				{#await import("$lib/components/tabs/EmbeddingsTab.svelte") then module}
					<module.default onopenglobalsimilar={openGlobalSimilar} />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "pipeline"}
				{#await import("$lib/components/tabs/PipelineTab.svelte") then module}
					<module.default />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "logs"}
				{#await import("$lib/components/tabs/LogsTab.svelte") then module}
					<module.default />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "secrets"}
				{#await import("$lib/components/tabs/SecretsTab.svelte") then module}
					<module.default />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "skills"}
				{#await import("$lib/components/tabs/SkillsTab.svelte") then module}
					<module.default />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{:else if activeTab === "tasks"}
				{#await import("$lib/components/tabs/TasksTab.svelte") then module}
					<module.default />
				{:catch error}
					<div class="flex flex-1 items-center justify-center text-[12px] text-[var(--sig-danger)] font-[family-name:var(--font-mono)]">
						Failed to load tab: {error instanceof Error ? error.message : "unknown error"}
					</div>
				{/await}
			{/if}
		</div>

		<div
			class="flex items-center justify-between h-[26px] px-4
				border-t border-[var(--sig-border)]
				bg-[var(--sig-surface)]
				text-[10px] text-[var(--sig-text-muted)]
				font-[family-name:var(--font-mono)] shrink-0"
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
			{:else if activeTab === "skills"}
				<span>{sk.installed.length} installed</span>
				<span>{sk.searching ? "searching..." : "skills.sh"}</span>
			{:else if activeTab === "tasks"}
				<span>{ts.tasks.length} scheduled tasks</span>
				<span>cron scheduler</span>
			{/if}
		</div>
	</main>
</Sidebar.Provider>

<Toaster
	position="bottom-right"
	toastOptions={{
		class: "!font-[family-name:var(--font-mono)] !text-[12px] !border-[var(--sig-border-strong)] !bg-[var(--sig-surface-raised)] !text-[var(--sig-text-bright)]",
	}}
/>

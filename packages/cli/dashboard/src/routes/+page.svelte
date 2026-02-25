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
	import { sk } from "$lib/stores/skills.svelte";
	import { ts } from "$lib/stores/tasks.svelte";
	import * as Sidebar from "$lib/components/ui/sidebar/index.js";
	import AppSidebar from "$lib/components/app-sidebar.svelte";
	import { Toaster } from "$lib/components/ui/sonner/index.js";

	let activeTab = $derived(nav.activeTab);
	import ConfigTab from "$lib/components/tabs/ConfigTab.svelte";
	import SettingsTab from "$lib/components/tabs/SettingsTab.svelte";
	import LogsTab from "$lib/components/tabs/LogsTab.svelte";
	import SecretsTab from "$lib/components/tabs/SecretsTab.svelte";
	import SkillsTab from "$lib/components/tabs/SkillsTab.svelte";
	import TasksTab from "$lib/components/tabs/TasksTab.svelte";
	import MemoryTab from "$lib/components/tabs/MemoryTab.svelte";
	import EmbeddingsTab from "$lib/components/tabs/EmbeddingsTab.svelte";
	import PipelineTab from "$lib/components/tabs/PipelineTab.svelte";

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
	let memoryDocs = $derived((data.memories ?? []) as Memory[]);

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
		m-2 ml-0 rounded-lg border border-[var(--sig-border)]
		bg-[var(--sig-surface)]">
		<header
			class="flex h-9 shrink-0 items-center justify-between
				border-b border-[var(--sig-border)] px-4"
		>
			<div class="flex items-center gap-2">
				<Sidebar.Trigger class="-ml-1" />
				<span
					class="text-[10px] font-bold uppercase tracking-[0.14em]
						text-[var(--sig-text-muted)]
						font-[family-name:var(--font-display)]"
				>
					{activeTab}
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
						Embedding graph
					</span>
				{/if}
			</div>
		</header>

		<div class="flex flex-1 flex-col min-h-0 relative">
			{#if activeTab === "config"}
				<ConfigTab
					configFiles={data.configFiles}
					{selectedFile}
					onselectfile={selectFile}
				/>
			{:else if activeTab === "settings"}
				<SettingsTab configFiles={data.configFiles} />
			{:else if activeTab === "memory"}
				<MemoryTab memories={memoryDocs} />
			{:else if activeTab === "embeddings"}
				<EmbeddingsTab onopenglobalsimilar={openGlobalSimilar} />
			{:else if activeTab === "pipeline"}
				<PipelineTab />
			{:else if activeTab === "logs"}
				<LogsTab />
			{:else if activeTab === "secrets"}
				<SecretsTab />
			{:else if activeTab === "skills"}
				<SkillsTab />
			{:else if activeTab === "tasks"}
				<TasksTab />
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
						hybrid embedding index
					{/if}
				</span>
			{:else if activeTab === "pipeline"}
				<span>Pipeline</span>
				<span>memory loop v2</span>
			{:else if activeTab === "embeddings"}
				<span>Embedding graph</span>
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

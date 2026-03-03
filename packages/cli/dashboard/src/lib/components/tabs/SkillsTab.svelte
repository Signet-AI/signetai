<script lang="ts">
import type { SkillSearchResult } from "$lib/api";
import SkillDetail from "$lib/components/skills/SkillDetail.svelte";
import SkillGrid from "$lib/components/skills/SkillGrid.svelte";
import SkillsComparePanel from "$lib/components/skills/SkillsComparePanel.svelte";
import * as Select from "$lib/components/ui/select/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import {
	type ProviderFilter,
	type SkillsView,
	clearCompare,
	closeDetail,
	doInstall,
	doUninstall,
	fetchCatalog,
	fetchInstalled,
	getFilteredCatalog,
	getFilteredResults,
	openDetail,
	resetFilters,
	setQuery,
	sk,
	toggleCompare,
} from "$lib/stores/skills.svelte";
import { onMount } from "svelte";

interface Props {
	embedded?: boolean;
}

const { embedded = false }: Props = $props();

const searchInputId = "skills-search-input";

type SkillsSort = typeof sk.sortBy;

const sortOptions: { value: SkillsSort; label: string }[] = [
	{ value: "popularity", label: "Popularity" },
	{ value: "installs", label: "Downloads" },
	{ value: "stars", label: "Stars" },
	{ value: "name", label: "Name" },
	{ value: "newest", label: "Newest" },
];

const providerOptions: { value: ProviderFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "skills.sh", label: "skills.sh" },
	{ value: "clawhub", label: "ClawHub" },
];

function parseSort(value: string): SkillsSort {
	if (value === "popularity" || value === "installs" || value === "stars" || value === "name" || value === "newest") {
		return value;
	}
	return "popularity";
}

const activeSortLabel = $derived.by(() => {
	const match = sortOptions.find((option) => option.value === sk.sortBy);
	return match?.label ?? "Popularity";
});

function switchView(v: SkillsView) {
	sk.view = v;
	if (v === "browse") fetchCatalog();
}

function handleGlobalKey(e: KeyboardEvent) {
	const target = e.target as HTMLElement;
	const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

	if (e.key === "/" && !isInput) {
		e.preventDefault();
		const searchInput = document.getElementById(searchInputId);
		if (searchInput instanceof HTMLInputElement) {
			searchInput.focus();
		}
		return;
	}
	if (e.key === "Escape") {
		if (sk.detailOpen) {
			e.preventDefault();
			closeDetail();
			return;
		}
	}
}

// Derived items based on current view + filters
const displayItems = $derived.by(() => {
	if (sk.query.trim()) {
		return getFilteredResults();
	}
	if (sk.view === "installed") {
		return sk.installed;
	}
	return getFilteredCatalog();
});

const displayMode = $derived<"installed" | "browse">(
	sk.view === "installed" && !sk.query.trim() ? "installed" : "browse",
);

const emptyState = $derived<"installed" | "browse" | "search" | null>(
	sk.query.trim() && displayItems.length === 0
		? "search"
		: sk.view === "installed" && !sk.query.trim() && displayItems.length === 0
			? "installed"
			: sk.view === "browse" && !sk.query.trim() && displayItems.length === 0
				? "browse"
				: null,
);

const compareItems = $derived.by(() => {
	const available = displayItems.filter((item): item is SkillSearchResult => "fullName" in item);
	return available.filter((item) => sk.compareSelected.includes(item.fullName));
});

function handleEmptyAction(action: "primary" | "secondary") {
	if (emptyState === "installed") {
		if (action === "primary") {
			sk.view = "browse";
			fetchCatalog();
			return;
		}
		resetFilters();
		return;
	}
	if (emptyState === "browse") {
		if (action === "primary") {
			sk.providerFilter = "all";
			return;
		}
		sk.catalogLoaded = false;
		fetchCatalog();
		return;
	}
	if (emptyState === "search") {
		if (action === "primary") {
			setQuery("");
			return;
		}
		setQuery("");
		sk.view = "browse";
		sk.providerFilter = "all";
		fetchCatalog();
	}
}

onMount(() => {
	fetchInstalled();
	fetchCatalog();
});
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="h-full flex flex-col overflow-hidden">
	{#if !embedded}
		<div
			class="shrink-0 px-[var(--space-md)] py-[var(--space-sm)]
				border-b border-[var(--sig-border)] flex flex-col gap-2"
		>
			<div class="relative">
				<input
					id={searchInputId}
					type="text"
					class="w-full px-3 py-[6px]
						border border-[var(--sig-border-strong)]
						bg-[var(--sig-surface-raised)]
						text-[var(--sig-text-bright)] text-[11px]
						font-[family-name:var(--font-mono)]
						outline-none focus:border-[var(--sig-accent)]
						pr-8"
					value={sk.query}
					oninput={(e) => setQuery(e.currentTarget.value)}
					placeholder="Search skills..."
				/>
				<kbd
					class="absolute right-2 top-1/2 -translate-y-1/2
						px-[5px] py-px text-[9px]
						text-[var(--sig-text-muted)]
						bg-[var(--sig-bg)]
						border border-[var(--sig-border)]
						pointer-events-none"
				>/</kbd>
			</div>
			<div class="flex items-center gap-3 flex-wrap">
				<a
					href="https://skills.sh"
					target="_blank"
					rel="noopener"
					class="font-[family-name:var(--font-mono)] text-[10px]
						text-[var(--sig-text-muted)]
						hover:text-[var(--sig-accent)] no-underline"
				>
					skills.sh
				</a>
				<span class="text-[var(--sig-border-strong)]">|</span>
				<a
					href="https://clawhub.ai"
					target="_blank"
					rel="noopener"
					class="font-[family-name:var(--font-mono)] text-[10px]
						text-[var(--sig-text-muted)]
						hover:text-[var(--sig-accent)] no-underline"
				>
					clawhub.ai
				</a>
				<span class="text-[var(--sig-border-strong)]">|</span>
				<a
					href="https://socket.dev/blog/socket-brings-supply-chain-security-to-skills"
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-[5px]
						font-[family-name:var(--font-mono)] text-[10px]
						text-[var(--sig-success)] no-underline
						hover:underline"
				>
					<svg width="10" height="10" viewBox="0 0 16 16" fill="none"
						class="shrink-0"
					>
						<path
							d="M8 0L10 5.5L16 6L11.5 10L13 16L8 12.5L3 16L4.5 10L0 6L6 5.5L8 0Z"
							fill="currentColor"
						/>
					</svg>
					Verified by Socket.dev
				</a>
			</div>
		</div>
	{/if}

	<!-- Tabs bar + controls -->
	<Tabs.Root value={sk.view} onValueChange={(v) => switchView(v as SkillsView)}>
		<div class="flex items-center shrink-0 border-b border-[var(--sig-border)] gap-2">
			<Tabs.List class="bg-transparent h-auto gap-0 rounded-none border-none">
				<Tabs.Trigger
					value="browse"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					Browse{sk.catalogTotal ? ` (${sk.catalogTotal.toLocaleString()})` : ""}
				</Tabs.Trigger>
				<Tabs.Trigger
					value="installed"
					class="font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text-muted)] data-[state=active]:text-[var(--sig-text-bright)] data-[state=active]:border-b-[var(--sig-text-bright)] border-b-2 border-b-transparent rounded-none bg-transparent px-[var(--space-md)] py-[var(--space-xs)] hover:text-[var(--sig-text)] data-[state=active]:shadow-none"
				>
					Installed ({sk.installed.length})
				</Tabs.Trigger>
			</Tabs.List>

			<!-- Sort + filter controls -->
			<div class="flex items-center gap-2 ml-auto pr-[var(--space-md)]">
				<!-- Sort dropdown -->
				<div class="flex items-center gap-1">
					<span class="text-[9px] font-[family-name:var(--font-mono)] text-[var(--sig-text-muted)] uppercase tracking-wider">Sort</span>
					<Select.Root type="single" value={sk.sortBy} onValueChange={(v) => { sk.sortBy = parseSort(v ?? "installs"); }}>
						<Select.Trigger class="sort-select">{activeSortLabel}</Select.Trigger>
						<Select.Content class="sort-select-content">
							{#each sortOptions as opt}
								<Select.Item value={opt.value} label={opt.label} class="sort-select-item" />
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				<!-- Provider filter chips -->
				<div class="flex items-center gap-0">
					{#each providerOptions as opt}
						<button
							type="button"
							class="filter-chip"
							class:active={sk.providerFilter === opt.value}
							onclick={() => { sk.providerFilter = opt.value; }}
						>
							{opt.label}
						</button>
					{/each}
				</div>
			</div>
		</div>
	</Tabs.Root>

	<!-- Content -->
	{#if compareItems.length > 0}
		<SkillsComparePanel
			items={compareItems}
			onRemove={(key) => toggleCompare(key)}
			onClear={clearCompare}
		/>
	{/if}

	{#if sk.searching || sk.catalogLoading || sk.loading}
		<div
			class="flex-1 flex items-center justify-center
				text-[var(--sig-text-muted)] text-[12px]"
		>
			{sk.searching ? "Searching..." : "Loading..."}
		</div>
	{:else}
		<SkillGrid
			items={displayItems}
			mode={displayMode}
			selectedName={sk.selectedName}
			installing={sk.installing}
			uninstalling={sk.uninstalling}
			onitemclick={(name) => openDetail(name)}
			oninstall={(name) => doInstall(name)}
			onuninstall={(name) => doUninstall(name)}
			emptyState={emptyState}
			onemptyaction={handleEmptyAction}
			compareSelectedKeys={sk.compareSelected}
			oncomparetoggle={toggleCompare}
		/>
	{/if}
</div>

<!-- Detail sheet -->
<SkillDetail />

<style>
	:global(.sort-select) {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		padding: 2px 8px;
		height: auto;
		min-height: 28px;
		outline: none;
		cursor: pointer;
		border-radius: 0.5rem;
	}
	:global(.sort-select:focus) {
		border-color: var(--sig-accent);
	}

	:global(.sort-select-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	:global(.sort-select-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.filter-chip {
		font-family: var(--font-mono);
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		background: transparent;
		border: 1px solid var(--sig-border);
		padding: 2px 8px;
		cursor: pointer;
		transition: all 0.1s;
	}
	.filter-chip:not(:first-child) {
		border-left: none;
	}
	.filter-chip:hover {
		color: var(--sig-text);
		background: var(--sig-surface-raised);
	}
	.filter-chip.active {
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
		border-color: var(--sig-accent);
	}
	.filter-chip.active + .filter-chip {
		border-left-color: var(--sig-accent);
	}
</style>

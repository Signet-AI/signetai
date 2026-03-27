<script lang="ts">
import PageBanner from "$lib/components/layout/PageBanner.svelte";
import TabGroupBar from "$lib/components/layout/TabGroupBar.svelte";
import { MEMORY_TAB_ITEMS } from "$lib/components/layout/page-headers";
import { focusMemoryTab } from "$lib/stores/tab-group-focus.svelte";
import type { Memory } from "$lib/api";
import {
	getConstellationOverlay,
	type ConstellationGraph,
} from "$lib/api";
import {
	mem,
	hasActiveFilters,
	queueMemorySearch,
	doSearch,
	findSimilar,
	clearAll,
	openEditForm,
	closeEditForm,
} from "$lib/stores/memory.svelte";
import { setTab, nav, isMemoryGroup } from "$lib/stores/navigation.svelte";
import { returnToSidebar } from "$lib/stores/focus.svelte";
import MemoryForm from "$lib/components/memory/MemoryForm.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { ActionLabels } from "$lib/ui/action-labels";
import * as Select from "$lib/components/ui/select/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import { Calendar } from "$lib/components/ui/calendar/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";

import CalendarIcon from "@lucide/svelte/icons/calendar";
import { getLocalTimeZone, CalendarDate, type DateValue } from "@internationalized/date";

interface Props {
	memories: Memory[];
	embedded?: boolean;
	agentId: string;
}

let { memories, embedded = false, agentId }: Props = $props();

// Delete confirmation state - tracks which memory is pending delete confirmation
let deleteConfirmId = $state<string | null>(null);

let rawDisplay = $derived(
	mem.similarSourceId
		? mem.similarResults
		: mem.searched || hasActiveFilters()
			? mem.results
			: memories,
);

// Filter out locally-deleted memories so they disappear immediately
let display = $derived(
	mem.deletedIds.size > 0
		? rawDisplay.filter((m) => !mem.deletedIds.has(m.id))
		: rawDisplay,
);

let totalCount = $derived(memories.length);
let displayCount = $derived(display.length);
let selectedId = $state<string | null>(null);
let graph = $state<ConstellationGraph | null>(null);
let graphLoading = $state(false);
let graphError = $state("");

let selectedMemory = $derived(
	selectedId ? display.find((m) => m.id === selectedId) ?? null : null,
);

$effect(() => {
	if (!selectedId) return;
	if (display.some((m) => m.id === selectedId)) return;
	selectedId = null;
});

type RelatedEntity = {
	id: string;
	name: string;
	type: string;
	mentions: number;
	aspectNames: string[];
	constraints: string[];
	dependencies: string[];
};

let relatedEntities = $derived.by((): RelatedEntity[] => {
	if (!selectedMemory || !graph) return [];
	const data = graph;
	const memId = selectedMemory.id;
	const byId = new Map(data.entities.map((entity) => [entity.id, entity.name]));
	const relevant = new Set(
		data.entities
			.filter((entity) =>
				entity.aspects.some((aspect) =>
					aspect.attributes.some((attr) => attr.memoryId === memId),
				),
			)
			.map((entity) => entity.id),
	);

	return data.entities
		.map((entity) => {
			const aspects = entity.aspects.filter((aspect) =>
				aspect.attributes.some((attr) => attr.memoryId === memId),
			);
			if (aspects.length === 0) return null;

			const constraints = Array.from(
				new Set(
					aspects.flatMap((aspect) =>
						aspect.attributes
							.filter(
								(attr) =>
									attr.memoryId === memId &&
									attr.kind === "constraint" &&
									attr.content.trim().length > 0,
							)
							.map((attr) => attr.content.trim()),
					),
				),
			);

			const deps = data.dependencies
				.filter(
					(dep) =>
						(dep.sourceEntityId === entity.id || dep.targetEntityId === entity.id) &&
						relevant.has(dep.sourceEntityId) &&
						relevant.has(dep.targetEntityId),
				)
				.map((dep) => {
					const from = byId.get(dep.sourceEntityId) ?? dep.sourceEntityId;
					const to = byId.get(dep.targetEntityId) ?? dep.targetEntityId;
					return `${from} ${dep.dependencyType} ${to}`;
				});

			return {
				id: entity.id,
				name: entity.name,
				type: entity.entityType,
				mentions: entity.mentions,
				aspectNames: aspects.map((aspect) => aspect.name),
				constraints,
				dependencies: Array.from(new Set(deps)),
			};
		})
		.filter((item): item is RelatedEntity => item !== null);
});

let relatedAspectCount = $derived(
	relatedEntities.reduce((sum, entity) => sum + entity.aspectNames.length, 0),
);
let relatedConstraintCount = $derived(
	relatedEntities.reduce((sum, entity) => sum + entity.constraints.length, 0),
);
let relatedDependencyCount = $derived(
	relatedEntities.reduce((sum, entity) => sum + entity.dependencies.length, 0),
);

async function ensureGraph(): Promise<void> {
	if (graph || graphLoading) return;
	graphLoading = true;
	graphError = "";
	try {
		graph = await getConstellationOverlay(agentId);
		if (!graph) graphError = "Ontology overlay unavailable.";
	} catch (error) {
		graphError = error instanceof Error ? error.message : "Failed to load ontology overlay.";
	} finally {
		graphLoading = false;
	}
}

function selectMemory(memory: Memory): void {
	selectedId = memory.id;
	void ensureGraph();
}

function parseMemoryTags(raw: Memory["tags"]): string[] {
	if (!raw) return [];
	if (Array.isArray(raw)) {
		return raw.filter(
			(tag) => typeof tag === "string" && tag.trim().length > 0,
		);
	}
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(tag): tag is string =>
						typeof tag === "string" && tag.trim().length > 0,
				);
			}
		} catch {
			// fallthrough
		}
	}
	return trimmed
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function memoryScoreLabel(memory: Memory): string | null {
	if (typeof memory.score !== "number") return null;
	const score = Math.round(memory.score * 100);
	const source = memory.source ?? "semantic";
	return `${source} ${score}%`;
}

function formatDate(dateStr: string): string {
	try {
		const date = new Date(dateStr);
		return date.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	} catch {
		return dateStr;
	}
}

const pillBase = "sig-eyebrow tracking-[0.08em] px-2 py-0.5 border cursor-pointer transition-colors duration-150";
const pillActive = `${pillBase} text-[var(--sig-accent)] border-[var(--sig-accent)] bg-[rgba(138,138,150,0.1)]`;
const pillInactive = `${pillBase} text-[var(--sig-text-muted)] border-[var(--sig-border-strong)] bg-transparent hover:text-[var(--sig-text)]`;

const dateTriggerClass = "sig-label text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)] border border-[var(--sig-border-strong)] rounded-lg px-2 py-1 w-[130px] inline-flex items-center justify-between gap-2 cursor-pointer";

const badgeBase = "sig-badge border-[var(--sig-border-strong)] text-[var(--sig-text)]";
const badgeAccent = "sig-badge border-[var(--sig-accent)] text-[var(--sig-accent)]";

let sincePickerOpen = $state(false);

function toCalendarDate(value: string): DateValue | undefined {
	if (!value) return undefined;
	const parts = value.split("-");
	if (parts.length !== 3) return undefined;
	const year = Number(parts[0]);
	const month = Number(parts[1]);
	const day = Number(parts[2]);
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
		return undefined;
	}
	return new CalendarDate(year, month, day);
}

function toIsoDate(value: DateValue | undefined): string {
	if (!value) return "";
	const year = String(value.year).padStart(4, "0");
	const month = String(value.month).padStart(2, "0");
	const day = String(value.day).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatIsoDate(value: string): string {
	const parsed = toCalendarDate(value);
	if (!parsed) return "Since date";
	return parsed.toDate(getLocalTimeZone()).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

// Keyboard navigation for sub-tabs and memory cards
function handleGlobalKey(e: KeyboardEvent) {
	// Only handle events when any Memory group tab is active
	if (!isMemoryGroup(nav.activeTab)) return;

	const target = e.target as HTMLElement;
	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	if (isInputFocused) return;

	// Don't intercept arrow keys if focus is on a card (or descendant) or filter - let those handlers work
	if (target.closest('.doc-card') || target.closest('.filter-row')) {
		return;
	}

	// ArrowDown from the memory tab trigger button to focus search input
	const isTabButton = target.getAttribute?.("data-memory-tab") === "memory";
	if (e.key === "ArrowDown" && isTabButton) {
		e.preventDefault();
		const searchInput = document.querySelector('.memory-search-input') as HTMLInputElement;
		if (searchInput) {
			searchInput.focus();
		}
		return;
	}
}

// Track current filter element focus for left/right navigation
function getFilterElements(): HTMLElement[] {
	const row = document.querySelector('.filter-row');
	if (!row) return [];

	// Get all interactive elements in order they appear in DOM
	return Array.from(row.querySelectorAll('button, [role="button"], input, select, [data-radix-collection-item]')) as HTMLElement[];
}

function getCurrentFilterIndex(): number {
	const elements = getFilterElements();
	const activeElement = document.activeElement as HTMLElement;
	return elements.indexOf(activeElement);
}

// Handle keyboard navigation within memory cards (2D grid)
function handleCardKeydown(e: KeyboardEvent): void {
	const cards = Array.from(document.querySelectorAll('.doc-card')) as HTMLElement[];
	const currentIndex = cards.indexOf(e.currentTarget as HTMLElement);

	if (currentIndex === -1) return; // Card not found in array

	// Get grid layout info
	const grid = document.querySelector('.memory-cards-grid');
	if (!grid) return;

	// Detect number of columns in the grid
	let columns = 1;
	const computedStyle = window.getComputedStyle(grid);
	const gridColumns = computedStyle.gridTemplateColumns;
	if (gridColumns && gridColumns !== 'none') {
		columns = gridColumns.split(' ').length;
	}

	// Calculate current row and column position
	const currentRow = Math.floor(currentIndex / columns);
	const currentCol = currentIndex % columns;
	const totalRows = Math.ceil(cards.length / columns);

	if (e.key === "ArrowDown") {
		e.preventDefault();
		e.stopPropagation();
		// Move to next row (same column position)
		const nextRow = currentRow + 1;
		const nextIndex = nextRow * columns + currentCol;

		// Only move if there's a card in that position
		if (nextIndex < cards.length) {
			cards[nextIndex].focus();
			cards[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		e.stopPropagation();
		// Move to previous row (same column position)
		if (currentRow > 0) {
			// Not in top row, move to card above
			const prevIndex = (currentRow - 1) * columns + currentCol;
			if (prevIndex >= 0 && prevIndex < cards.length) {
				cards[prevIndex].focus();
			}
		} else {
			// At top row, go to last filter element
			const filterElements = getFilterElements();
			if (filterElements.length > 0) {
				const lastFilter = filterElements[filterElements.length - 1];
				lastFilter.focus();
				lastFilter.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			} else {
				// No filters, go to search
				const searchInput = document.querySelector('.memory-search-input') as HTMLInputElement;
				if (searchInput) {
					searchInput.focus();
				}
			}
		}
	} else if (e.key === "ArrowRight") {
		e.preventDefault();
		e.stopPropagation();
		// Move to next card
		if (currentIndex < cards.length - 1) {
			cards[currentIndex + 1].focus();
		}
	} else if (e.key === "ArrowLeft") {
		e.preventDefault();
		e.stopPropagation();
		// Move to previous card
		if (currentIndex > 0) {
			cards[currentIndex - 1].focus();
		}
	} else if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		// Return focus to search input
		const searchInput = document.querySelector('.memory-search-input') as HTMLInputElement;
		if (searchInput) searchInput.focus();
	}
}

// Handle keyboard navigation for filter row
function handleFilterKeydown(e: KeyboardEvent): void {
	const elements = getFilterElements();
	const currentIndex = getCurrentFilterIndex();

	if (e.key === "ArrowRight") {
		e.preventDefault();
		e.stopPropagation();
		// Move to next filter element
		if (currentIndex < elements.length - 1) {
			elements[currentIndex + 1].focus();
		}
	} else if (e.key === "ArrowLeft") {
		e.preventDefault();
		e.stopPropagation();
		// Move to previous filter element
		if (currentIndex > 0) {
			elements[currentIndex - 1].focus();
		}
		// If at first filter, stay there (don't return to sidebar)
	} else if (e.key === "ArrowDown") {
		e.preventDefault();
		e.stopPropagation();
		// Go to first memory card
		const cards = document.querySelectorAll('.doc-card');
		if (cards.length > 0 && cards[0] instanceof HTMLElement) {
			cards[0].focus();
			// Scroll card into view if needed
			cards[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		e.stopPropagation();
		// Dispatch custom event to go to tab bar (sets memoryTabFocus = "tabs")
		window.dispatchEvent(new CustomEvent('memory-focus-tabs'));
	} else if (e.key === "Enter") {
		// Allow Enter to proceed with default behavior (opening filter)
		// Don't prevent default
	} else if (e.key === " ") {
		// For toggle buttons, allow space to work
		// Don't prevent default
	} else if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		// Return focus to the search input
		const searchInput = document.querySelector('.memory-search-input') as HTMLInputElement;
		if (searchInput) {
			searchInput.focus();
		}
	}
}

// Handle keyboard navigation for search input
function handleSearchKeydown(e: KeyboardEvent): void {
	if (e.key === "ArrowDown") {
		e.preventDefault();
		// Go to filter row (first interactive element)
		const filterElements = getFilterElements();
		if (filterElements.length > 0) {
			filterElements[0].focus();
		} else {
			// No filters, go to first card
			const firstCard = document.querySelector('.doc-card') as HTMLElement;
			if (firstCard) firstCard.focus();
		}
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		// Return to tab bar by focusing the currently active memory tab button
		const memoryTabButton = document.querySelector(`[data-memory-tab="${nav.activeTab}"]`) as HTMLElement;
		if (memoryTabButton) {
			memoryTabButton.focus();
		}
	} else if (e.key === "Escape") {
		// Clear search and refresh results
		mem.query = "";
		queueMemorySearch();
	} else if (e.key === 'Enter') {
		doSearch();
	}
}

</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
	{#if !embedded}
		<PageBanner title="Ontology">
			<TabGroupBar
				group="memory"
				tabs={MEMORY_TAB_ITEMS}
				activeTab={nav.activeTab}
				onselect={(_tab, index) => focusMemoryTab(index)}
			/>
		</PageBanner>
	{/if}
	<section class="flex flex-col flex-1 min-h-0 gap-2.5 p-3 bg-[var(--sig-bg)]">
	<Card.Root class="gap-0 py-0 border-[var(--sig-border-strong)] bg-[var(--sig-surface)] shadow-none">
		<Card.Header class="px-3 py-2 border-b border-[var(--sig-border)]">
			<div class="flex items-center justify-between">
				<span class="sig-eyebrow">Cortex Search</span>
				<span class="sig-meta">
					{#if mem.similarSourceId}
						{displayCount} similar
					{:else if mem.searched || hasActiveFilters()}
						{displayCount}/{totalCount}
					{:else}
						{totalCount}
					{/if}
				</span>
			</div>
		</Card.Header>
		<Card.Content class="p-3 space-y-2.5">
	<!-- Search bar -->
	<label class="flex items-center gap-2 px-3 py-2 rounded-lg
		border border-[var(--sig-border-strong)]
		bg-[var(--sig-surface-raised)]">
		{#if mem.debouncing || mem.searching}
			<span class="text-[var(--sig-accent)] sig-label animate-pulse">◐</span>
		{:else}
			<span class="text-[var(--sig-accent)] sig-label">◇</span>
		{/if}
		<Input
			type="text"
			class="memory-search-input flex-1 text-[12px] text-[var(--sig-text-bright)] bg-transparent
				border-none shadow-none outline-none focus-visible:ring-0
				placeholder:text-[var(--sig-text-muted)] h-auto py-0 px-0"
			bind:value={mem.query}
			oninput={queueMemorySearch}
			onkeydown={handleSearchKeydown}
			placeholder="search cortex memories..."
		/>
		{#if mem.searched || hasActiveFilters() || mem.similarSourceId}
			<Button
				variant="ghost"
				size="sm"
				class="sig-eyebrow text-[var(--sig-accent)] hover:underline whitespace-nowrap h-auto py-0 px-1"
				onclick={clearAll}
			>{ActionLabels.Clear}</Button>
		{/if}
	</label>
	<Separator class="bg-[var(--sig-border)]" />

	<!-- Filter row -->
	<div class="filter-row flex flex-wrap items-center gap-2">
		<Select.Root type="single" value={mem.filterWho} onValueChange={(v) => { mem.filterWho = v ?? ""; }}>
			<Select.Trigger
				class="font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-lg h-auto py-1 px-2 min-w-[120px] max-w-[180px]"
				onkeydown={(e) => {
					// Let navigation keys work even when select is focused
					if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
						e.stopPropagation(); // Prevent Select from handling navigation keys
						handleFilterKeydown(e);
					} else if (e.key === "Enter") {
						e.preventDefault();
						// Toggle the select dropdown
						(e.currentTarget as HTMLElement).click();
					}
				}}
			>
				{mem.filterWho || "Any source"}
			</Select.Trigger>
			<Select.Content class="bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg">
				<Select.Item value="" label="Any source" />
				{#each mem.whoOptions as w}
					<Select.Item value={w} label={w} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Input
			class="sig-label min-w-[120px] flex-1 max-w-[200px] text-[var(--sig-text-bright)]
				bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg h-auto py-1 px-2"
			placeholder="Tags"
			bind:value={mem.filterTags}
			onkeydown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					(e.currentTarget as HTMLElement).blur();
				} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
					// Only intercept vertical navigation, let Left/Right move caret
					handleFilterKeydown(e);
				}
			}}
		/>

		<Input
			type="number"
			class="sig-label w-[70px] text-[var(--sig-text-bright)]
				bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg h-auto py-1 px-2"
			min="0" max="1" step="0.1"
			bind:value={mem.filterImportanceMin}
			placeholder="imp"
			onkeydown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					(e.currentTarget as HTMLElement).blur();
				}
				// Don't intercept arrow keys — let native number input stepping and caret work
			}}
		/>

		<Popover.Root bind:open={sincePickerOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class={dateTriggerClass}
						onkeydown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								sincePickerOpen = !sincePickerOpen;
							} else if (e.key === "Escape" && sincePickerOpen) {
								e.preventDefault();
								sincePickerOpen = false;
							} else {
								handleFilterKeydown(e);
							}
						}}
					>
						<span class="truncate">{formatIsoDate(mem.filterSince)}</span>
						<CalendarIcon class="size-3 shrink-0 opacity-70" />
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content
				class="w-auto overflow-hidden p-0 bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg"
				align="start"
			>
				<Calendar
					type="single"
					captionLayout="dropdown"
					value={toCalendarDate(mem.filterSince)}
					onValueChange={(v: DateValue | undefined) => {
						mem.filterSince = toIsoDate(v);
						sincePickerOpen = false;
					}}
					class="bg-[var(--sig-surface-raised)] text-[var(--sig-text)] rounded-lg border-0 p-2"
				/>
			</Popover.Content>
		</Popover.Root>
		{#if mem.filterSince}
			<Button
				variant="outline"
				size="sm"
				class="sig-meta px-1.5 py-1 rounded-lg h-auto border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] hover:text-[var(--sig-text-bright)]"
				onclick={() => { mem.filterSince = ""; }}
				onkeydown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						mem.filterSince = "";
					} else {
						handleFilterKeydown(e);
					}
				}}
			>
				{ActionLabels.Clear}
			</Button>
		{/if}

		<Button
			variant="outline"
			size="sm"
			class={mem.filterPinned ? `${pillActive} h-auto` : `${pillInactive} h-auto`}
			onclick={() => mem.filterPinned = !mem.filterPinned}
			onkeydown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					mem.filterPinned = !mem.filterPinned;
				} else {
					handleFilterKeydown(e);
				}
			}}
		>pinned</Button>

		<!-- Type filters -->
		{#each ['fact', 'decision', 'preference', 'issue', 'learning'] as t}
			<Button
				variant="outline"
				size="sm"
				class={mem.filterType === t ? `${pillActive} h-auto` : `${pillInactive} h-auto`}
				onclick={() => mem.filterType = mem.filterType === t ? '' : t}
				onkeydown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						mem.filterType = mem.filterType === t ? '' : t;
					} else {
						handleFilterKeydown(e);
					}
				}}
			>{t}</Button>
		{/each}
	</div>
		</Card.Content>
	</Card.Root>

	<!-- Count bar -->
	<div class="flex items-center justify-between sig-eyebrow px-1">
		{#if mem.similarSourceId}
			Showing {displayCount} similar {displayCount === 1 ? 'memory' : 'memories'}
		{:else if mem.searched || hasActiveFilters()}
			Showing {displayCount} of {totalCount} {totalCount === 1 ? 'memory' : 'memories'}
		{:else}
			{totalCount} {totalCount === 1 ? 'memory' : 'memories'}
		{/if}
		<span class="sig-meta">cortex index</span>
	</div>

	<!-- Similarity mode banner -->
	{#if mem.similarSourceId && mem.similarSource}
		<div class="flex items-center justify-between gap-3
			px-3 py-1.5 border border-dashed rounded-lg
			border-[var(--sig-border-strong)]
			sig-label text-[var(--sig-text)] bg-[var(--sig-surface)]">
			<span class="truncate">
				Similar to: {(mem.similarSource.content ?? '').slice(0, 100)}
				{(mem.similarSource.content ?? '').length > 100 ? '...' : ''}
			</span>
			<Button
				variant="ghost"
				size="sm"
				class="sig-label text-[var(--sig-accent)] hover:underline shrink-0 h-auto py-0 px-1"
				onclick={() => {
					mem.similarSourceId = null;
					mem.similarSource = null;
					mem.similarResults = [];
				}}
			>Back</Button>
		</div>
	{/if}

	{#if selectedMemory}
		<Card.Root class="gap-0 py-0 border-[var(--sig-border-strong)] bg-[var(--sig-surface)] shadow-none">
			<Card.Header class="px-3 py-2 border-b border-[var(--sig-border)] gap-1">
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="sig-eyebrow">Ontology Context</span>
						<Badge variant="outline" class={badgeBase}>{selectedMemory.who || 'unknown'}</Badge>
						{#if selectedMemory.type}
							<Badge variant="outline" class={badgeBase}>{selectedMemory.type}</Badge>
						{/if}
					</div>
					<span class="sig-meta">selected memory</span>
				</div>
			</Card.Header>
			<Card.Content class="px-3 py-2 space-y-2">
				{#if graphLoading}
					<div class="sig-meta">Loading ontology overlay...</div>
				{:else if graphError}
					<div class="sig-meta text-[var(--sig-danger)]">{graphError}</div>
				{:else if relatedEntities.length === 0}
					<div class="sig-meta">No linked entities found for this memory yet.</div>
				{:else}
					<div class="flex items-center gap-1.5 flex-wrap">
						<Badge variant="outline" class={badgeBase}>{relatedEntities.length} entities</Badge>
						<Badge variant="outline" class={badgeBase}>{relatedAspectCount} aspects</Badge>
						<Badge variant="outline" class={badgeBase}>{relatedConstraintCount} constraints</Badge>
						<Badge variant="outline" class={badgeBase}>{relatedDependencyCount} dependencies</Badge>
					</div>
					<div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
						{#each relatedEntities as entity (entity.id)}
							<div class="rounded-md border border-[var(--sig-border)] bg-[var(--sig-surface-raised)] p-2 space-y-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="sig-label text-[var(--sig-text-bright)]">{entity.name}</span>
									<span class="sig-meta">{entity.type}</span>
								</div>
								<div class="sig-meta">mentions {entity.mentions}</div>
								<div class="sig-meta">aspects: {entity.aspectNames.join(", ")}</div>
								{#if entity.constraints.length > 0}
									<div class="space-y-1">
										<div class="sig-meta text-[var(--sig-text-bright)]">constraints</div>
										{#each entity.constraints.slice(0, 3) as constraint}
											<div class="sig-meta">• {constraint}</div>
										{/each}
									</div>
								{/if}
								{#if entity.dependencies.length > 0}
									<div class="space-y-1">
										<div class="sig-meta text-[var(--sig-text-bright)]">dependencies</div>
										{#each entity.dependencies.slice(0, 3) as dep}
											<div class="sig-meta">• {dep}</div>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="sig-meta px-1">Select a memory card to inspect entities, aspects, dependencies, and constraints.</div>
	{/if}

	<!-- Memory cards grid -->
	<div class="memory-cards-grid flex-1 min-h-0 overflow-y-auto
		grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))]
		auto-rows-min gap-3 content-start pr-0.5">
		{#if mem.loadingSimilar}
			<div class="col-span-full py-8 text-center text-[12px]
				text-[var(--sig-text-muted)] rounded-lg
				border border-dashed border-[var(--sig-border-strong)]">
				Finding similar memories...
			</div>
		{:else}
			{#each display as memory}
				{@const tags = parseMemoryTags(memory.tags)}
				{@const scoreLabel = memoryScoreLabel(memory)}

			<Card.Root
				role="group"
				tabindex={0}
				onfocus={() => selectMemory(memory)}
				onclick={() => selectMemory(memory)}
				onkeydown={handleCardKeydown}
				class="doc-card gap-0 py-0 border-[var(--sig-border-strong)]
				bg-[var(--sig-surface)] rounded-lg shadow-none
				transition-colors duration-150 hover:border-[var(--sig-text-muted)]
				focus-visible:outline focus-visible:outline-2
				focus-visible:outline-[var(--sig-accent)]
				focus-visible:outline-offset-2"
			>
				<Card.Header class="px-3 py-2 border-b border-[var(--sig-border)] gap-1">
					<div class="flex justify-between items-start gap-2">
						<div class="flex items-center flex-wrap gap-1">
							<Badge variant="outline" class={`${badgeAccent} tracking-[0.05em]`}>{memory.who || 'unknown'}</Badge>
							{#if memory.type}
								<Badge variant="outline" class={`${badgeBase} tracking-[0.04em]`}>{memory.type}</Badge>
							{/if}
							{#if memory.pinned}
								<Badge variant="outline" class="{badgeBase} tracking-[0.04em] text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.06)]">pinned</Badge>
							{/if}
						</div>
						<span class="sig-meta shrink-0">{formatDate(memory.created_at)}</span>
					</div>
				</Card.Header>

				<Card.Content class="px-3 py-2">
					<p class="m-0 text-[var(--sig-text-bright)]
						leading-[1.6] text-[12px] whitespace-pre-wrap
						break-words overflow-hidden line-clamp-4">
						{memory.content}
					</p>
				</Card.Content>

				<Card.Footer class="px-3 py-2 border-t border-[var(--sig-border)] flex-wrap gap-1.5">
					<Badge variant="outline" class={`${badgeBase} tracking-[0.04em]`}>imp {Math.round((memory.importance ?? 0) * 100)}%</Badge>

					{#if scoreLabel}
						<Badge variant="outline" class="{badgeBase} tracking-[0.04em] text-[var(--sig-accent)]">{scoreLabel}</Badge>
					{/if}

					{#if tags.length > 0}
						<div class="flex items-center flex-wrap gap-1 w-full">
							{#each tags.slice(0, 5) as tag}
								<Badge variant="outline" class={`${badgeBase} tracking-[0.04em]`}>#{tag}</Badge>
							{/each}
						</div>
					{/if}

					{#if memory.id}
						<Button
							variant="outline"
							size="sm"
							class="sig-badge py-px px-[6px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-accent)]"
							onclick={() => openEditForm(memory.id, "edit")}
							title="Edit memory"
						>edit</Button>
						{#if deleteConfirmId === memory.id}
							<Button
								variant="outline"
								size="sm"
								class="sig-badge py-px px-[6px] h-auto border-red-500 text-red-400 hover:bg-red-500 hover:text-white"
								onclick={() => { openEditForm(memory.id, "delete"); deleteConfirmId = null; }}
								title="Confirm delete"
							>confirm</Button>
							<Button
								variant="outline"
								size="sm"
								class="sig-badge py-px px-[6px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]"
								onclick={() => deleteConfirmId = null}
								title="Cancel delete"
							>cancel</Button>
						{:else}
							<Button
								variant="outline"
								size="sm"
								class="sig-badge py-px px-[6px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-red-400"
								onclick={() => deleteConfirmId = memory.id}
								title="Delete memory"
							>delete</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							class="ml-auto sig-badge py-px px-[6px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-accent)]"
							onclick={() => findSimilar(memory.id, memory)}
							title="Find similar"
						>similar</Button>
					{/if}
				</Card.Footer>
			</Card.Root>
			{:else}
				<div class="col-span-full py-8 text-center text-[12px]
					text-[var(--sig-text-muted)] rounded-lg
					border border-dashed border-[var(--sig-border-strong)]">
					{mem.similarSourceId
						? 'No similar memories found.'
						: mem.searched || hasActiveFilters()
							? 'No memories matched your search.'
							: 'No memories available yet.'}
				</div>
			{/each}
		{/if}
	</div>
	</section>

	<MemoryForm
		open={mem.formOpen}
		editingId={mem.editingId}
		mode={mem.editMode}
		memories={display}
		onclose={closeEditForm}
	/>
</div>

<style>
	.doc-card:focus {
		border-color: var(--sig-text-muted);
		outline: 2px solid var(--sig-accent);
		outline-offset: 2px;
	}

	/* Remove outline when clicking (mouse users) but keep for keyboard */
	.doc-card:focus:not(:focus-visible) {
		outline: none;
	}
</style>

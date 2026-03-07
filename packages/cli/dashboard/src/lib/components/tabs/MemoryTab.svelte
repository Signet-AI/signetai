<script lang="ts">
import type { Memory } from "$lib/api";
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

import CalendarIcon from "@lucide/svelte/icons/calendar";
import { getLocalTimeZone, CalendarDate, type DateValue } from "@internationalized/date";

interface Props {
	memories: Memory[];
}

let { memories }: Props = $props();

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
	<section class="flex flex-col flex-1 min-h-0 gap-2.5 p-3 bg-[var(--sig-bg)]">
	<!-- Search bar -->
	<label class="flex items-center gap-2 px-3 py-1.5
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
			placeholder="Search across memories..."
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

		<button
			class={mem.filterPinned ? pillActive : pillInactive}
			onclick={() => mem.filterPinned = !mem.filterPinned}
			onkeydown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					mem.filterPinned = !mem.filterPinned;
				} else {
					handleFilterKeydown(e);
				}
			}}
		>pinned</button>

		<!-- Type filters -->
		{#each ['fact', 'decision', 'preference', 'issue', 'learning'] as t}
			<button
				class={mem.filterType === t ? pillActive : pillInactive}
				onclick={() => mem.filterType = mem.filterType === t ? '' : t}
				onkeydown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						mem.filterType = mem.filterType === t ? '' : t;
					} else {
						handleFilterKeydown(e);
					}
				}}
			>{t}</button>
		{/each}
	</div>

	<!-- Count bar -->
	<div class="flex items-center sig-eyebrow">
		{#if mem.similarSourceId}
			Showing {displayCount} similar {displayCount === 1 ? 'memory' : 'memories'}
		{:else if mem.searched || hasActiveFilters()}
			Showing {displayCount} of {totalCount} {totalCount === 1 ? 'memory' : 'memories'}
		{:else}
			{totalCount} {totalCount === 1 ? 'memory' : 'memories'}
		{/if}
	</div>

	<!-- Similarity mode banner -->
	{#if mem.similarSourceId && mem.similarSource}
		<div class="flex items-center justify-between gap-3
			px-3 py-1.5 border border-dashed
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

	<!-- Memory cards grid -->
	<div class="memory-cards-grid flex-1 min-h-0 overflow-y-auto
		grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))]
		auto-rows-min gap-2.5 content-start">
		{#if mem.loadingSimilar}
			<div class="col-span-full py-8 text-center text-[12px]
				text-[var(--sig-text-muted)]
				border border-dashed border-[var(--sig-border-strong)]">
				Finding similar memories...
			</div>
		{:else}
			{#each display as memory}
				{@const tags = parseMemoryTags(memory.tags)}
				{@const scoreLabel = memoryScoreLabel(memory)}

			<div
				role="group"
				tabindex="0"
				onkeydown={handleCardKeydown}
				class="doc-card relative flex flex-col
				gap-1.5 p-3 border border-[var(--sig-border-strong)]
				border-t-2 border-t-[var(--sig-text-muted)]
				bg-[var(--sig-surface)] overflow-hidden
				transition-colors duration-150
				hover:border-[var(--sig-text-muted)]
				focus-visible:outline focus-visible:outline-2
				focus-visible:outline-[var(--sig-accent)]
				focus-visible:outline-offset-2"
			>

					<header class="flex justify-between items-start gap-1.5">
						<div class="flex items-center flex-wrap gap-1">
							<Badge variant="outline" class={badgeAccent}>{memory.who || 'unknown'}</Badge>
							{#if memory.type}
								<Badge variant="outline" class={badgeBase}>{memory.type}</Badge>
							{/if}
							{#if memory.pinned}
								<Badge variant="outline" class="{badgeBase} text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.06)]">pinned</Badge>
							{/if}
						</div>
						<span class="sig-meta shrink-0">
							{formatDate(memory.created_at)}
						</span>
					</header>

					<p class="m-0 text-[var(--sig-text-bright)]
						leading-[1.5] text-[11px] whitespace-pre-wrap
						break-words overflow-hidden line-clamp-4">
						{memory.content}
					</p>

					{#if tags.length > 0}
						<div class="flex flex-wrap gap-1">
							{#each tags.slice(0, 5) as tag}
								<Badge variant="outline" class={badgeBase}>#{tag}</Badge>
							{/each}
						</div>
					{/if}

					<footer class="flex items-center gap-1.5 mt-auto pt-1">
						<Badge variant="outline" class={badgeBase}>imp {Math.round((memory.importance ?? 0) * 100)}%</Badge>

						{#if scoreLabel}
							<Badge variant="outline" class="{badgeBase} text-[var(--sig-accent)]">{scoreLabel}</Badge>
						{/if}

					{#if memory.id}
						<Button
							variant="outline"
							size="sm"
							class="sig-badge py-px px-[5px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-accent)]"
							onclick={() => openEditForm(memory.id, "edit")}
							title="Edit memory"
						>edit</Button>
						{#if deleteConfirmId === memory.id}
							<!-- Inline delete confirmation -->
							<Button
								variant="outline"
								size="sm"
								class="sig-badge py-px px-[5px] h-auto border-red-500 text-red-400 hover:bg-red-500 hover:text-white"
								onclick={() => { openEditForm(memory.id, "delete"); deleteConfirmId = null; }}
								title="Confirm delete"
							>confirm</Button>
							<Button
								variant="outline"
								size="sm"
								class="sig-badge py-px px-[5px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text-bright)]"
								onclick={() => deleteConfirmId = null}
								title="Cancel delete"
							>cancel</Button>
						{:else}
							<Button
								variant="outline"
								size="sm"
								class="sig-badge py-px px-[5px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-red-400"
								onclick={() => deleteConfirmId = memory.id}
								title="Delete memory"
							>delete</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							class="ml-auto sig-badge py-px px-[5px] h-auto border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] hover:text-[var(--sig-accent)]"
							onclick={() => findSimilar(memory.id, memory)}
							title="Find similar"
						>similar</Button>
					{/if}
					</footer>
				</div>
			{:else}
				<div class="col-span-full py-8 text-center text-[12px]
					text-[var(--sig-text-muted)]
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
	.doc-card::before,
	.doc-card::after {
		content: '';
		position: absolute;
		width: 5px;
		height: 5px;
		border-color: var(--sig-border-strong);
		border-style: solid;
		pointer-events: none;
		transition: border-color 150ms;
	}

	.doc-card::before {
		top: -1px;
		left: -1px;
		border-width: 1px 0 0 1px;
	}

	.doc-card::after {
		bottom: -1px;
		right: -1px;
		border-width: 0 1px 1px 0;
	}

	.doc-card:hover::before,
	.doc-card:hover::after,
	.doc-card:focus::before,
	.doc-card:focus::after {
		border-color: var(--sig-text-muted);
	}

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

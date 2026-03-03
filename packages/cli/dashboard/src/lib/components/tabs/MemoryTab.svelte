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
</script>

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
			class="flex-1 text-[12px] text-[var(--sig-text-bright)] bg-transparent
				border-none shadow-none outline-none focus-visible:ring-0
				placeholder:text-[var(--sig-text-muted)] h-auto py-0 px-0"
			bind:value={mem.query}
			oninput={queueMemorySearch}
			onkeydown={(e) => e.key === 'Enter' && doSearch()}
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
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" value={mem.filterWho} onValueChange={(v) => { mem.filterWho = v ?? ""; }}>
			<Select.Trigger class="font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-lg h-auto py-1 px-2 min-w-[120px] max-w-[180px]">
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
		/>

		<Input
			type="number"
			class="sig-label w-[70px] text-[var(--sig-text-bright)]
				bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg h-auto py-1 px-2"
			min="0" max="1" step="0.1"
			bind:value={mem.filterImportanceMin}
			placeholder="imp"
		/>

		<Popover.Root bind:open={sincePickerOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button {...props} class={dateTriggerClass}>
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
			>
				{ActionLabels.Clear}
			</Button>
		{/if}

		<button
			class={mem.filterPinned ? pillActive : pillInactive}
			onclick={() => mem.filterPinned = !mem.filterPinned}
		>pinned</button>

		<!-- Type filters -->
		{#each ['fact', 'decision', 'preference', 'issue', 'learning'] as t}
			<button
				class={mem.filterType === t ? pillActive : pillInactive}
				onclick={() => mem.filterType = mem.filterType === t ? '' : t}
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
	<div class="flex-1 min-h-0 overflow-y-auto
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

			<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
			<article
				class="doc-card relative flex flex-col
				gap-1.5 p-3 border border-[var(--sig-border-strong)]
				border-t-2 border-t-[var(--sig-text-muted)]
				bg-[var(--sig-surface)] overflow-hidden
				transition-colors duration-150
				hover:border-[var(--sig-text-muted)]"
				tabindex="0"
				aria-label="Memory from {memory.who || 'unknown'}: {memory.content.slice(0, 80)}{memory.content.length > 80 ? '...' : ''}"
				onkeydown={(e) => {
					if (!memory.id) return;
					// Enter or Space: Edit memory (or confirm delete if pending)
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (deleteConfirmId === memory.id) {
							openEditForm(memory.id, "delete");
							deleteConfirmId = null;
						} else {
							openEditForm(memory.id, "edit");
						}
					}
					// Escape: Cancel pending delete confirmation
					if (e.key === 'Escape' && deleteConfirmId === memory.id) {
						e.preventDefault();
						deleteConfirmId = null;
					}
					// Delete or Backspace: Show delete confirmation (or confirm if already pending)
					if (e.key === 'Delete' || e.key === 'Backspace') {
						e.preventDefault();
						if (deleteConfirmId === memory.id) {
							openEditForm(memory.id, "delete");
							deleteConfirmId = null;
						} else {
							deleteConfirmId = memory.id;
						}
					}
					// 's' key: Find similar
					if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
						e.preventDefault();
						findSimilar(memory.id, memory);
					}
				}}>

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
				</article>
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

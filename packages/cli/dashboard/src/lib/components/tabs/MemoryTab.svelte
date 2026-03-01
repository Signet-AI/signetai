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

const pillBase = "text-[10px] font-[family-name:var(--font-mono)] uppercase tracking-[0.08em] px-2 py-0.5 border cursor-pointer transition-colors duration-150";
const pillActive = `${pillBase} text-[var(--sig-accent)] border-[var(--sig-accent)] bg-[rgba(138,138,150,0.1)]`;
const pillInactive = `${pillBase} text-[var(--sig-text-muted)] border-[var(--sig-border-strong)] bg-transparent hover:text-[var(--sig-text)]`;

const inputClass = "text-[11px] font-[family-name:var(--font-mono)] text-[var(--sig-text-bright)] bg-[var(--sig-surface-raised)] border border-[var(--sig-border-strong)] rounded-none px-2 py-1 outline-none placeholder:text-[var(--sig-text-muted)]";
const dateTriggerClass = `${inputClass} w-[130px] inline-flex items-center justify-between gap-2 cursor-pointer`;
const dateClearClass = "text-[9px] px-1.5 py-1 border border-[var(--sig-border-strong)] rounded-none text-[var(--sig-text-muted)] bg-[var(--sig-surface-raised)] hover:text-[var(--sig-text-bright)]";

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
		<span class="text-[var(--sig-accent)] text-[11px]">&#9671;</span>
		<input
			type="text"
			class="flex-1 text-[12px] font-[family-name:var(--font-mono)]
				text-[var(--sig-text-bright)] bg-transparent
				border-none outline-none
				placeholder:text-[var(--sig-text-muted)]"
			bind:value={mem.query}
			oninput={queueMemorySearch}
			onkeydown={(e) => e.key === 'Enter' && doSearch()}
			placeholder="Search across memories..."
		/>
		{#if mem.searched || hasActiveFilters() || mem.similarSourceId}
			<button
				class="text-[10px] text-[var(--sig-accent)]
					bg-transparent border-none cursor-pointer
					hover:underline whitespace-nowrap"
				onclick={clearAll}
			>{ActionLabels.Clear}</button>
		{/if}
	</label>

	<!-- Filter row -->
	<div class="flex flex-wrap items-center gap-2">
		<Select.Root type="single" value={mem.filterWho} onValueChange={(v) => { mem.filterWho = v ?? ""; }}>
			<Select.Trigger class="font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-none h-auto py-1 px-2 min-w-[120px] max-w-[180px]">
				{mem.filterWho || "Any source"}
			</Select.Trigger>
			<Select.Content class="bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-none">
				<Select.Item value="" label="Any source" />
				{#each mem.whoOptions as w}
					<Select.Item value={w} label={w} />
				{/each}
			</Select.Content>
		</Select.Root>

		<input
			class="{inputClass} min-w-[120px] flex-1 max-w-[200px]"
			placeholder="Tags"
			bind:value={mem.filterTags}
		/>

		<input
			type="number"
			class="{inputClass} w-[70px]"
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
				class="w-auto overflow-hidden p-0 bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-none"
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
					class="bg-[var(--sig-surface-raised)] text-[var(--sig-text)] rounded-none border-0 p-2"
				/>
			</Popover.Content>
		</Popover.Root>
		{#if mem.filterSince}
			<button class={dateClearClass} onclick={() => { mem.filterSince = ""; }}>
				{ActionLabels.Clear}
			</button>
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

	<!-- Similarity mode banner -->
	{#if mem.similarSourceId && mem.similarSource}
		<div class="flex items-center justify-between gap-3
			px-3 py-1.5 border border-dashed
			border-[var(--sig-border-strong)]
			text-[11px] font-[family-name:var(--font-mono)]
			text-[var(--sig-text)] bg-[var(--sig-surface)]">
			<span class="truncate">
				Similar to: {(mem.similarSource.content ?? '').slice(0, 100)}
				{(mem.similarSource.content ?? '').length > 100 ? '...' : ''}
			</span>
			<button
				class="text-[11px] text-[var(--sig-accent)]
					bg-transparent border-none cursor-pointer
					hover:underline shrink-0"
				onclick={() => {
					mem.similarSourceId = null;
					mem.similarSource = null;
					mem.similarResults = [];
				}}
			>Back</button>
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

				<article class="doc-card relative flex flex-col
					gap-1.5 p-3 border border-[var(--sig-border-strong)]
					border-t-2 border-t-[var(--sig-text-muted)]
					bg-[var(--sig-surface)] overflow-hidden
					transition-colors duration-150
					hover:border-[var(--sig-text-muted)]">

					<header class="flex justify-between items-start gap-1.5">
						<div class="flex items-center flex-wrap gap-1">
							<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border-[var(--sig-accent)] text-[var(--sig-accent)]">{memory.who || 'unknown'}</Badge>
							{#if memory.type}
								<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border-[var(--sig-border-strong)] text-[var(--sig-text)]">{memory.type}</Badge>
							{/if}
							{#if memory.pinned}
								<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] bg-[rgba(255,255,255,0.06)]">pinned</Badge>
							{/if}
						</div>
						<span class="font-[family-name:var(--font-mono)]
							text-[9px] text-[var(--sig-text-muted)]
							whitespace-nowrap shrink-0">
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
								<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border-[var(--sig-border-strong)] text-[var(--sig-text)]">#{tag}</Badge>
							{/each}
						</div>
					{/if}

					<footer class="flex items-center gap-1.5 mt-auto pt-1">
						<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border-[var(--sig-border-strong)] text-[var(--sig-text)]">imp {Math.round((memory.importance ?? 0) * 100)}%</Badge>

						{#if scoreLabel}
							<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border-[var(--sig-border-strong)] text-[var(--sig-accent)]">{scoreLabel}</Badge>
						{/if}

					{#if memory.id}
						<button
							class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] cursor-pointer hover:text-[var(--sig-accent)] transition-colors duration-100 bg-transparent"
							onclick={() => openEditForm(memory.id, "edit")}
							title="Edit memory"
						>edit</button>
						<button
							class="rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] cursor-pointer hover:text-red-400 transition-colors duration-100 bg-transparent"
							onclick={() => openEditForm(memory.id, "delete")}
							title="Delete memory"
						>delete</button>
						<button
							class="ml-auto rounded-none font-[family-name:var(--font-mono)] text-[9px] py-px px-[5px] border border-[var(--sig-border-strong)] text-[var(--sig-text-muted)] cursor-pointer hover:text-[var(--sig-accent)] transition-colors duration-100 bg-transparent"
							onclick={() => findSimilar(memory.id, memory)}
							title="Find similar"
						>similar</button>
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
	.doc-card:hover::after {
		border-color: var(--sig-text-muted);
	}
</style>

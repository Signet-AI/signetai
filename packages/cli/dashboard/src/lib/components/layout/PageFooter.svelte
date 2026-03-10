<script lang="ts">
import type { TabId } from "$lib/stores/navigation.svelte";
import { PAGE_FOOTERS } from "./page-headers";

interface Props {
	activeTab: TabId;
	memoryFooterLabel: string;
	memorySearching: boolean;
	memorySimilarActive: boolean;
	timelineGeneratedFor: string;
	taskCount: number;
}

const { activeTab, memoryFooterLabel, memorySearching, memorySimilarActive, timelineGeneratedFor, taskCount }: Props =
	$props();

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

const staticFooter = $derived(PAGE_FOOTERS[activeTab]);
</script>

{#if activeTab !== "skills"}
<div
	class="flex items-center justify-between h-[26px] px-4
		bg-[var(--sig-bg)]
		sig-eyebrow shrink-0"
>
	{#if activeTab === "settings"}
		<span>Settings</span>
		<span class="flex items-center gap-2">
			<kbd class="px-1 py-px text-[10px] text-[var(--sig-text-muted)]
				bg-[var(--sig-surface-raised)]"
			>Ctrl+S</kbd> save
		</span>
	{:else if activeTab === "memory"}
		<span>{memoryFooterLabel}</span>
		<span>
			{#if memorySearching}
				semantic search in progress
			{:else if memorySimilarActive}
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
	{:else if activeTab === "tasks"}
		<span>{taskCount} scheduled tasks</span>
		<span>cron scheduler</span>
	{:else if staticFooter}
		<span>{staticFooter.left}</span>
		<span>{staticFooter.right}</span>
	{/if}
</div>
{/if}

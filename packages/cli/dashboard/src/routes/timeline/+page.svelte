<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import type { EraMarker, TimeBucket } from "$lib/stores/timeline.svelte";
import {
	detectEras,
	loadEras,
	loadTimeline,
	setRange,
	timeline,
} from "$lib/stores/timeline.svelte";
import TimelineCanvas from "$lib/components/timeline/TimelineCanvas.svelte";
import TimelineScrubber from "$lib/components/timeline/TimelineScrubber.svelte";
import Loader from "@lucide/svelte/icons/loader";
import Sparkles from "@lucide/svelte/icons/sparkles";
import { onMount } from "svelte";

let detectingEras = $state(false);

onMount(async () => {
	await Promise.all([loadTimeline(), loadEras()]);
});

async function handleRangeChange(start: string, end: string): Promise<void> {
	setRange(start, end);
	await loadTimeline();
}

async function handleDetectEras(): Promise<void> {
	detectingEras = true;
	try {
		await detectEras();
	} catch (error) {
		console.error("Failed to detect eras:", error);
	} finally {
		detectingEras = false;
	}
}

function handleBucketClick(bucket: TimeBucket): void {
	console.log("Bucket clicked:", bucket);
	// Could navigate to memory view filtered by date
}

function handleEraClick(era: EraMarker): void {
	console.log("Era clicked:", era);
	// Could show era details or zoom to era range
}

const totalMemories = $derived(
	timeline.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
);
</script>

<svelte:head>
	<title>Timeline | Signet</title>
</svelte:head>

<div class="flex flex-col h-screen bg-[var(--sig-surface)]">
	<header class="flex items-center justify-between px-4 py-3 border-b border-[var(--sig-border)]">
		<div class="flex items-center gap-4">
			<h1 class="text-sm font-bold uppercase tracking-[0.06em] text-[var(--sig-text-bright)]">
				Timeline
			</h1>
			<TimelineScrubber
				start={timeline.selectedRange.start}
				end={timeline.selectedRange.end}
				onrangechange={handleRangeChange}
			/>
		</div>

		<div class="flex items-center gap-3">
			{#if timeline.buckets.length > 0}
				<span class="text-xs text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
					{totalMemories} memories
				</span>
			{/if}

			<Button
				variant="outline"
				size="sm"
				class="h-7 text-[11px] gap-1.5"
				onclick={handleDetectEras}
				disabled={detectingEras || timeline.loading}
			>
				{#if detectingEras}
					<Loader class="size-3 animate-spin" />
				{:else}
					<Sparkles class="size-3" />
				{/if}
				Detect Eras
			</Button>
		</div>
	</header>

	<div class="flex-1 relative">
		{#if timeline.loading}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-surface)]">
				<div class="flex flex-col items-center gap-3">
					<Loader class="size-6 animate-spin text-[var(--sig-accent)]" />
					<span class="text-xs text-[var(--sig-text-muted)]">Loading timeline...</span>
				</div>
			</div>
		{:else if timeline.buckets.length === 0}
			<div class="absolute inset-0 flex items-center justify-center bg-[var(--sig-surface)]">
				<div class="text-center">
					<p class="text-sm text-[var(--sig-text-muted)] mb-2">No memories in selected range</p>
					<p class="text-xs text-[var(--sig-text-dim)]">Try adjusting the date range</p>
				</div>
			</div>
		{:else}
			<TimelineCanvas
				buckets={timeline.buckets}
				eras={timeline.eras}
				onbucketclick={handleBucketClick}
				oneraclick={handleEraClick}
			/>
		{/if}
	</div>
</div>

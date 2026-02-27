<script lang="ts">
	import { onMount } from "svelte";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import PipelineGraph from "$lib/components/pipeline/PipelineGraph.svelte";
	import PipelineDetailSheet from "$lib/components/pipeline/PipelineDetailSheet.svelte";
	import {
		pipeline,
		connectSSE,
		disconnectSSE,
		startPolling,
		stopPolling,
		selectNode,
	} from "$lib/components/pipeline/pipeline-store.svelte";
	import { PIPELINE_NODES, type LogEntry } from "$lib/components/pipeline/pipeline-types";
	import PageHero from "$lib/components/layout/PageHero.svelte";
	import { PAGE_HEADERS } from "$lib/components/layout/page-headers";

	function handleSelectNode(id: string) {
		selectNode(pipeline.selectedNodeId === id ? null : id);
	}

	let feedViewport: HTMLElement | null = $state(null);
	let autoScroll = $state(true);

	// Auto-scroll feed
	$effect(() => {
		const _ = pipeline.feed.length;
		if (autoScroll && feedViewport) {
			requestAnimationFrame(() => {
				feedViewport?.scrollTo({ top: feedViewport.scrollHeight, behavior: "smooth" });
			});
		}
	});

	onMount(() => {
		connectSSE();
		startPolling();
		return () => {
			disconnectSSE();
			stopPolling();
		};
	});

	const modeColors: Record<string, string> = {
		"controlled-write": "border-[#4ade80] text-[#4ade80]",
		shadow: "border-[#fbbf24] text-[#fbbf24]",
		frozen: "border-[#94a3b8] text-[#94a3b8]",
		disabled: "border-[#f87171] text-[#f87171]",
		unknown: "border-[var(--sig-border)] text-[var(--sig-text-muted)]",
	};

	let modeClass = $derived(modeColors[pipeline.mode] ?? modeColors.unknown);

	// Count active nodes (had activity in last 5s)
	let activeCount = $derived(
		PIPELINE_NODES.filter((n) => {
			const ns = pipeline.nodes[n.id];
			if (!ns?.lastActivity) return false;
			return Date.now() - new Date(ns.lastActivity).getTime() < 5000;
		}).length,
	);

	function formatTime(ts: string): string {
		try {
			return new Date(ts).toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
		} catch { return ts; }
	}

	const LEVEL_COLORS: Record<string, string> = {
		error: "#f87171",
		warn: "#fbbf24",
		info: "#4ade80",
		debug: "#6b6b76",
	};

	const CATEGORY_COLORS: Record<string, string> = {
		hooks: "#4dabf7",
		"session-tracker": "#4dabf7",
		pipeline: "#da77f2",
		"summary-worker": "#da77f2",
		"document-worker": "#da77f2",
		retention: "#da77f2",
		maintenance: "#da77f2",
		memory: "#ffd43b",
		embedding: "#ffd43b",
		sync: "#ff922b",
		watcher: "#ff922b",
		harness: "#4dabf7",
		llm: "#fcc419",
	};
</script>

<div class="flex flex-col h-full overflow-hidden">
	<PageHero
		title={PAGE_HEADERS.pipeline.title}
		wordmarkLines={PAGE_HEADERS.pipeline.wordmarkLines}
		eyebrow={PAGE_HEADERS.pipeline.eyebrow}
		description={PAGE_HEADERS.pipeline.description}
	/>

	<!-- Toolbar -->
	<div class="flex items-center justify-between px-4 py-2 border-b border-[var(--sig-border)] shrink-0">
		<div class="flex items-center gap-3">
			<!-- Connection indicator -->
			<div class="flex items-center gap-1.5">
				<span
					class="inline-block w-2 h-2 rounded-full"
					class:bg-[#4ade80]={pipeline.connected}
					class:bg-[#f87171]={!pipeline.connected}
					class:animate-pulse={pipeline.connected}
				></span>
				<span class="text-[10px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
					{pipeline.connected ? "LIVE" : "DISCONNECTED"}
				</span>
			</div>

			<!-- Pipeline mode -->
			<Badge
				variant="outline"
				class="text-[9px] px-1.5 py-0 font-[family-name:var(--font-mono)] {modeClass}"
			>
				{pipeline.mode}
			</Badge>

			<!-- Active nodes count -->
			{#if activeCount > 0}
				<span class="text-[10px] text-[#4ade80] font-[family-name:var(--font-mono)]">
					{activeCount} active
				</span>
			{/if}
		</div>

		<div class="flex items-center gap-3">
			{#if pipeline.lastPoll}
				<span class="text-[9px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
					polled {formatTime(pipeline.lastPoll)}
				</span>
			{/if}
		</div>
	</div>

	<!-- Main content: graph + feed -->
	<div class="flex flex-1 min-h-0">
		<!-- Graph area -->
		<div class="flex-1 min-w-0 p-4 overflow-auto">
			<PipelineGraph onselectnode={handleSelectNode} />
		</div>

		<!-- Live feed panel -->
		<div class="w-[280px] shrink-0 border-l border-[var(--sig-border)] flex flex-col bg-[var(--sig-bg)]">
			<!-- Feed header -->
			<div class="flex items-center justify-between px-3 py-2 border-b border-[var(--sig-border)]">
				<span class="text-[10px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)] font-[family-name:var(--font-display)]">
					Live Feed
				</span>
				<span class="text-[9px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
					{pipeline.feed.length} events
				</span>
			</div>

			<!-- Feed entries -->
			<div
				bind:this={feedViewport}
				class="flex-1 overflow-y-auto px-1 py-1"
			>
				{#each pipeline.feed as entry, i (entry.timestamp + "-" + i)}
					{@const catColor = CATEGORY_COLORS[entry.category] ?? "var(--sig-text-muted)"}
					{@const levelColor = LEVEL_COLORS[entry.level] ?? "#6b6b76"}
					<div class="feed-entry px-2 py-1.5 rounded hover:bg-[var(--sig-surface-raised)] transition-colors">
						<div class="flex items-center gap-1.5">
							<!-- Time -->
							<span class="text-[9px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)] shrink-0 w-[48px]">
								{formatTime(entry.timestamp)}
							</span>
							<!-- Level dot -->
							<span
								class="inline-block w-1.5 h-1.5 rounded-full shrink-0"
								style="background-color: {levelColor}"
							></span>
							<!-- Category -->
							<span
								class="text-[9px] font-[family-name:var(--font-mono)] shrink-0"
								style="color: {catColor}"
							>
								{entry.category}
							</span>
						</div>
						<!-- Message -->
						<div class="text-[10px] text-[var(--sig-text)] font-[family-name:var(--font-mono)] mt-0.5 pl-[56px] truncate">
							{entry.message}
						</div>
						{#if entry.duration}
							<span class="text-[8px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)] pl-[56px]">
								{entry.duration}ms
							</span>
						{/if}
					</div>
				{/each}
				{#if pipeline.feed.length === 0}
					<div class="flex items-center justify-center h-full text-[11px] text-[var(--sig-text-muted)] italic">
						Waiting for events...
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

<!-- Detail sheet (portal, renders outside the layout) -->
<PipelineDetailSheet />

<style>
	.feed-entry {
		animation: feed-slide-in 0.3s ease-out;
	}
	@keyframes feed-slide-in {
		from {
			opacity: 0;
			transform: translateX(8px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>

<script lang="ts">
	import { onMount } from "svelte";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import * as Switch from "$lib/components/ui/switch/index.js";
	import * as Popover from "$lib/components/ui/popover/index.js";
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
	import { PIPELINE_NODES } from "$lib/components/pipeline/pipeline-types";


	function handleSelectNode(id: string) {
		selectNode(pipeline.selectedNodeId === id ? null : id);
	}

	let feedViewport: HTMLElement | null = $state(null);
	let autoScroll = $state(true);
	let feedExpanded = $state(false);
	let mobileFeedActionsOpen = $state(false);
	const AUTO_SCROLL_THRESHOLD_PX = 24;
	let feedAtLatest = $state(true);
	let feedWidthClass = $derived(feedExpanded ? "lg:w-[420px]" : "lg:w-[320px]");
	let feedPositionLabel = $derived(feedAtLatest ? "Latest" : "Oldest");
	let feedDensityLabel = $derived(feedExpanded ? "Expanded" : "Compact");

	function scrollFeedToBottom(behavior: ScrollBehavior = "smooth"): void {
		if (!feedViewport) return;
		feedViewport.scrollTo({ top: feedViewport.scrollHeight, behavior });
	}

	function isFeedNearBottom(): boolean {
		if (!feedViewport) return true;
		const distance =
			feedViewport.scrollHeight - feedViewport.scrollTop -
			feedViewport.clientHeight;
		return distance <= AUTO_SCROLL_THRESHOLD_PX;
	}

	function updateFeedPositionFlags(): void {
		if (!feedViewport) return;
		const overflow =
			feedViewport.scrollHeight - feedViewport.clientHeight >
			AUTO_SCROLL_THRESHOLD_PX;
		if (!overflow) return;

		if (isFeedNearBottom()) {
			feedAtLatest = true;
			return;
		}

		if (feedViewport.scrollTop <= AUTO_SCROLL_THRESHOLD_PX) {
			feedAtLatest = false;
		}
	}

	function handleFeedJumpClick(event?: Event): void {
		if (!feedViewport) return;

		if (feedAtLatest) {
			autoScroll = false;
			feedAtLatest = false;
			feedViewport.scrollTo({ top: 0, behavior: "smooth" });
		} else {
			autoScroll = true;
			feedAtLatest = true;
			scrollFeedToBottom("auto");
		}

		if (event?.currentTarget instanceof HTMLElement) {
			event.currentTarget.blur();
		}
		mobileFeedActionsOpen = false;
	}

	function handleAutoScrollChange(checked: boolean): void {
		autoScroll = checked;
		if (checked) {
			feedAtLatest = true;
			requestAnimationFrame(() => {
				scrollFeedToBottom("auto");
				updateFeedPositionFlags();
			});
		}
	}

	function handleFeedWidthToggle(event?: Event): void {
		feedExpanded = !feedExpanded;
		if (event?.currentTarget instanceof HTMLElement) {
			event.currentTarget.blur();
		}
		mobileFeedActionsOpen = false;
	}

	function getEntryDataKeySummary(data?: Record<string, unknown>): string {
		if (!data) return "";
		const keys = Object.keys(data);
		if (keys.length === 0) return "";
		const shown = keys.slice(0, 4).join(", ");
		return keys.length > 4 ? `${shown} +${keys.length - 4}` : shown;
	}

	// Auto-scroll feed
	$effect(() => {
		const _ = pipeline.feed.length;
		updateFeedPositionFlags();
		if (autoScroll && feedViewport) {
			if (!isFeedNearBottom()) return;
			requestAnimationFrame(() => {
				scrollFeedToBottom("smooth");
				updateFeedPositionFlags();
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

	const PRIORITY_DATA_KEYS = [
		"jobId",
		"memoryId",
		"sessionKey",
		"project",
		"attempt",
		"maxRetries",
		"mode",
		"provider",
		"model",
		"facts",
		"entities",
		"proposals",
		"added",
		"updated",
		"deleted",
		"deduped",
		"skippedLowConfidence",
		"blockedDestructive",
		"runId",
		"taskId",
		"path",
		"port",
		"pid",
		"error",
	] as const;

	function formatRelativeTime(ts: string): string {
		const deltaMs = Date.now() - new Date(ts).getTime();
		if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";
		const sec = Math.floor(deltaMs / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.floor(hr / 24);
		return `${day}d ago`;
	}

	function keyLabel(key: string): string {
		return key
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/[_-]+/g, " ")
			.replace(/^./, (s) => s.toUpperCase());
	}

	function formatValue(value: unknown): string {
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		if (Array.isArray(value)) return `[${value.length} items]`;
		if (typeof value === "object") return "{object}";
		return String(value);
	}

	function summarizeProcess(entry: {
		readonly category: string;
		readonly message: string;
		readonly data?: Record<string, unknown>;
	}): string {
		const msg = entry.message.toLowerCase();
		const stage = entry.category.replace(/-/g, " ");

		if (msg.includes("job failed")) {
			const attempt = entry.data?.attempt;
			return typeof attempt === "number"
				? `${stage} failed (attempt ${attempt})`
				: `${stage} failed`;
		}
		if (msg.includes("completed")) return `${stage} completed`;
		if (msg.includes("started") || msg.includes("starting")) {
			return `${stage} started`;
		}
		if (msg.includes("enqueued")) return `${stage} queued`;
		if (msg.includes("failed")) return `${stage} warning`;
		if (msg.includes("file changed")) return "watcher detected file change";
		return `${stage} event`;
	}

	function getEntryMetaRows(entry: {
		readonly level: string;
		readonly category: string;
		readonly duration?: number;
		readonly data?: Record<string, unknown>;
	}): Array<{ label: string; value: string }> {
		const rows: Array<{ label: string; value: string }> = [
			{ label: "Level", value: entry.level },
			{ label: "Category", value: entry.category },
		];

		if (entry.duration !== undefined) {
			rows.push({ label: "Duration", value: `${entry.duration} ms` });
		}

		const data = entry.data;
		if (!data) return rows;

		const used = new Set<string>();
		for (const key of PRIORITY_DATA_KEYS) {
			if (key in data) {
				rows.push({ label: keyLabel(key), value: formatValue(data[key]) });
				used.add(key);
			}
		}

		for (const key of Object.keys(data).sort()) {
			if (used.has(key)) continue;
			rows.push({ label: keyLabel(key), value: formatValue(data[key]) });
		}

		return rows;
	}

	function getEntryRawPayload(entry: {
		readonly data?: Record<string, unknown>;
		readonly error?: { name: string; message: string };
	}): string {
		const payload: Record<string, unknown> = {};
		if (entry.data) payload.data = entry.data;
		if (entry.error) payload.error = entry.error;
		if (Object.keys(payload).length === 0) return "";
		const raw = JSON.stringify(payload, null, 2);
		if (!raw) return "";
		const MAX_CHARS = 3200;
		if (raw.length <= MAX_CHARS) return raw;
		return `${raw.slice(0, MAX_CHARS)}\n...truncated`;
	}
</script>

<div class="flex flex-col h-full overflow-hidden">
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
	<div class="flex flex-1 min-h-0 flex-col lg:flex-row">
		<!-- Graph area -->
		<div class="flex-1 min-w-0 min-h-[46vh] lg:min-h-0 p-4 overflow-auto">
			<PipelineGraph onselectnode={handleSelectNode} />
		</div>

		<!-- Live feed panel -->
		<div
			class={`w-full shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--sig-border)] flex flex-col bg-[var(--sig-bg)] min-h-[220px] max-h-[40vh] lg:max-h-none ${feedWidthClass}`}
		>
			<!-- Feed header -->
			<div class="px-3 py-2 border-b border-[var(--sig-border)] space-y-2">
				<div class="flex items-center justify-between gap-2">
					<span class="text-[10px] uppercase tracking-[0.1em] text-[var(--sig-text-muted)] font-[family-name:var(--font-display)]">
						Live Feed
					</span>
					<span class="text-[9px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)]">
						{pipeline.feed.length} events
					</span>
				</div>
				<div class="flex items-center justify-between gap-2 min-w-0">
					<label class="inline-flex items-center gap-1.5 text-[10px] text-[var(--sig-text)] font-[family-name:var(--font-mono)] cursor-pointer min-w-0">
						<Switch.Root
							checked={autoScroll}
							onCheckedChange={(value: boolean) => handleAutoScrollChange(value)}
							class="scale-90"
						/>
						<span>Auto-scroll</span>
					</label>
					<div class="hidden lg:flex items-center gap-1.5 shrink-0">
						<button
							type="button"
							class="px-2 py-[3px] text-[9px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] border border-[var(--sig-border)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]"
							onclick={(event) => handleFeedJumpClick(event)}
						>
							{feedPositionLabel}
						</button>
						<button
							type="button"
							class="px-2 py-[3px] text-[9px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] border border-[var(--sig-border)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]"
							onclick={(event) => handleFeedWidthToggle(event)}
						>
							{feedDensityLabel}
						</button>
					</div>
					<div class="lg:hidden shrink-0">
						<Popover.Root bind:open={mobileFeedActionsOpen}>
							<Popover.Trigger>
								{#snippet child({ props })}
									<button
										{...props}
										type="button"
										class="px-2 py-[3px] text-[9px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] border border-[var(--sig-border)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]"
									>
										Feed actions
									</button>
								{/snippet}
							</Popover.Trigger>
							<Popover.Content
								align="end"
								side="bottom"
								class="w-[170px] p-1 bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-none"
							>
								<div class="flex flex-col gap-1">
									<button
										type="button"
										class="w-full text-left px-2 py-1 text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] border border-[var(--sig-border)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]"
										onclick={(event) => handleFeedJumpClick(event)}
									>
										{feedPositionLabel}
									</button>
									<button
										type="button"
										class="w-full text-left px-2 py-1 text-[10px] uppercase tracking-[0.08em] font-[family-name:var(--font-mono)] border border-[var(--sig-border)] text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] hover:border-[var(--sig-border-strong)]"
										onclick={(event) => handleFeedWidthToggle(event)}
									>
										{feedDensityLabel}
									</button>
								</div>
							</Popover.Content>
						</Popover.Root>
					</div>
				</div>
			</div>

			<!-- Feed entries -->
			<div
				bind:this={feedViewport}
				onscroll={updateFeedPositionFlags}
				class="flex-1 overflow-y-auto px-1 py-1"
			>
				{#each pipeline.feed as entry, i (entry.timestamp + "-" + i)}
					{@const catColor = CATEGORY_COLORS[entry.category] ?? "var(--sig-text-muted)"}
					{@const levelColor = LEVEL_COLORS[entry.level] ?? "#6b6b76"}
					{@const canExpand = entry.message.length > 72}
					{@const dataKeySummary = getEntryDataKeySummary(entry.data)}
					{@const processSummary = summarizeProcess(entry)}
					{@const metaRows = getEntryMetaRows(entry)}
					{@const rawPayload = getEntryRawPayload(entry)}
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
						{#if feedExpanded}
							<div class="mt-1 pl-[56px] inline-flex items-center gap-2 text-[8px] uppercase tracking-[0.06em] font-[family-name:var(--font-mono)]">
								<span class="px-1 py-[1px] border border-[var(--sig-border)] text-[var(--sig-text-muted)]">
									{processSummary}
								</span>
								<span class="text-[var(--sig-text-muted)]">{formatRelativeTime(entry.timestamp)}</span>
							</div>
							<div class="text-[10px] text-[var(--sig-text)] font-[family-name:var(--font-mono)] mt-0.5 pl-[56px] whitespace-pre-wrap break-words">
								{entry.message}
							</div>
							<div class="mt-1 pl-[56px] grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1 text-[8px] font-[family-name:var(--font-mono)]">
								{#each metaRows as row}
									<div class="flex items-start justify-between gap-2 border-b border-[var(--sig-border)]/30 pb-[1px]">
										<span class="text-[var(--sig-text-muted)] uppercase tracking-[0.05em]">{row.label}</span>
										<span class="text-[var(--sig-text)] break-all text-right">{row.value}</span>
									</div>
								{/each}
							</div>
							{#if dataKeySummary}
								<div class="mt-1 pl-[56px] text-[8px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)] uppercase tracking-[0.05em]">
									Data keys: {dataKeySummary}
								</div>
							{/if}
							{#if entry.error}
								<div class="mt-1 pl-[56px] text-[9px] text-[#f87171] font-[family-name:var(--font-mono)] whitespace-pre-wrap break-words">
									{entry.error.name}: {entry.error.message}
								</div>
							{/if}
							{#if rawPayload}
								<details class="mt-1 pl-[56px]">
									<summary class="cursor-pointer text-[8px] text-[var(--sig-text-muted)] uppercase tracking-[0.05em] font-[family-name:var(--font-mono)]">
										Raw payload
									</summary>
									<pre class="mt-1 p-2 border border-[var(--sig-border)] bg-[var(--sig-surface)] text-[8px] text-[var(--sig-text)] whitespace-pre-wrap break-words font-[family-name:var(--font-mono)]">{rawPayload}</pre>
								</details>
							{/if}
						{:else}
							{#if canExpand}
								<details class="mt-0.5 pl-[56px] group">
									<summary class="list-none cursor-pointer text-[10px] text-[var(--sig-text)] font-[family-name:var(--font-mono)] line-clamp-2 break-words [&::-webkit-details-marker]:hidden">
										{entry.message}
									</summary>
									<div class="mt-1 text-[10px] text-[var(--sig-text)] font-[family-name:var(--font-mono)] whitespace-pre-wrap break-words">
										{entry.message}
									</div>
								</details>
							{:else}
								<div class="text-[10px] text-[var(--sig-text)] font-[family-name:var(--font-mono)] mt-0.5 pl-[56px] whitespace-pre-wrap break-words">
									{entry.message}
								</div>
							{/if}
							{#if entry.duration}
								<span class="text-[8px] text-[var(--sig-text-muted)] font-[family-name:var(--font-mono)] pl-[56px]">
									{entry.duration}ms
								</span>
							{/if}
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

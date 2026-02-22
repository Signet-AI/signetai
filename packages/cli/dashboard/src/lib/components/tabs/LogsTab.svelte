<script lang="ts">
import { onMount } from "svelte";
import * as Select from "$lib/components/ui/select/index.js";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";

interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
	message: string;
	data?: Record<string, unknown>;
	duration?: number;
	error?: { name: string; message: string };
}

let logs = $state<LogEntry[]>([]);
let logsLoading = $state(false);
let logsError = $state("");
let logsStreaming = $state(false);
let logEventSource: EventSource | null = null;
let logLevelFilter = $state<string>("");
let logCategoryFilter = $state<string>("");
let logAutoScroll = $state(true);
let logContainer = $state<HTMLDivElement | null>(null);

const logCategories = [
	"daemon", "api", "memory", "sync", "git",
	"watcher", "embedding", "harness", "system",
];
const logLevels = ["debug", "info", "warn", "error"];

async function fetchLogs() {
	logsLoading = true;
	logsError = "";
	try {
		const params = new URLSearchParams({ limit: "200" });
		if (logLevelFilter) params.set("level", logLevelFilter);
		if (logCategoryFilter) params.set("category", logCategoryFilter);
		const res = await fetch(`/api/logs?${params}`);
		const data = await res.json();
		logs = data.logs || [];
	} catch {
		logsError = "Failed to fetch logs";
	} finally {
		logsLoading = false;
	}
}

function startLogStream() {
	if (logEventSource) logEventSource.close();
	logsStreaming = true;
	logEventSource = new EventSource("/api/logs/stream");

	logEventSource.onmessage = (event) => {
		try {
			const entry = JSON.parse(event.data);
			if (entry.type === "connected") return;
			if (logLevelFilter && entry.level !== logLevelFilter) return;
			if (logCategoryFilter && entry.category !== logCategoryFilter) return;
			logs = [...logs.slice(-499), entry];
			if (logAutoScroll && logContainer) {
				setTimeout(() => {
					logContainer?.scrollTo({
						top: logContainer.scrollHeight,
						behavior: "smooth",
					});
				}, 50);
			}
		} catch {
			// ignore parse errors
		}
	};

	logEventSource.onerror = () => {
		logsStreaming = false;
		logEventSource?.close();
		logEventSource = null;
	};
}

function stopLogStream() {
	logsStreaming = false;
	logEventSource?.close();
	logEventSource = null;
}

function toggleLogStream() {
	if (logsStreaming) stopLogStream();
	else startLogStream();
}

function formatLogTime(timestamp: string): string {
	return timestamp.split("T")[1]?.slice(0, 8) || "";
}

onMount(() => {
	fetchLogs();
	return () => {
		if (logEventSource) logEventSource.close();
	};
});
</script>

<div class="flex flex-col flex-1 min-h-0">
	<div class="flex items-center gap-[var(--space-sm)] px-[var(--space-md)] py-[var(--space-sm)] border-b border-[var(--sig-border)] shrink-0">
		<Select.Root type="single" value={logLevelFilter} onValueChange={(v) => { logLevelFilter = v ?? ""; fetchLogs(); }}>
			<Select.Trigger class="font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-none h-auto py-1 px-2 min-w-[100px]">
				{logLevelFilter || "All levels"}
			</Select.Trigger>
			<Select.Content class="bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-none">
				<Select.Item value="" label="All levels" />
				{#each logLevels as level}
					<Select.Item value={level} label={level} />
				{/each}
			</Select.Content>
		</Select.Root>
		<Select.Root type="single" value={logCategoryFilter} onValueChange={(v) => { logCategoryFilter = v ?? ""; fetchLogs(); }}>
			<Select.Trigger class="font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-none h-auto py-1 px-2 min-w-[100px]">
				{logCategoryFilter || "All categories"}
			</Select.Trigger>
			<Select.Content class="bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-none">
				<Select.Item value="" label="All categories" />
				{#each logCategories as cat}
					<Select.Item value={cat} label={cat} />
				{/each}
			</Select.Content>
		</Select.Root>
		<label class="flex items-center gap-1.5 text-[length:var(--font-size-sm)] text-[var(--sig-text)] cursor-pointer">
			<Checkbox checked={logAutoScroll} onCheckedChange={(v) => { logAutoScroll = !!v; }} class="rounded-none" />
			Auto-scroll
		</label>
		<button
			class={`flex items-center justify-center w-7 h-7 text-[var(--sig-text-muted)] bg-transparent border border-transparent cursor-pointer hover:text-[var(--sig-text)] hover:border-[var(--sig-border)] ${logsStreaming ? 'text-[var(--sig-success)]' : ''}`}
			onclick={toggleLogStream}
			title={logsStreaming ? 'Stop stream' : 'Start stream'}
		>
			{#if logsStreaming}
				<span class="text-[var(--sig-success)] text-[length:var(--font-size-sm)] font-medium [animation:pulse_2s_infinite]">● Live</span>
			{:else}
				▶
			{/if}
		</button>
	</div>

	<ScrollArea class="flex-1">
		<div
			class="px-[var(--space-md)] py-[var(--space-sm)] font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)] leading-relaxed"
			bind:this={logContainer}
		>
			{#if logsLoading}
				<div class="py-[var(--space-xl)] text-center text-[var(--sig-text-muted)] font-[family-name:var(--font-display)] text-[length:var(--font-size-base)]">Loading logs...</div>
			{:else if logsError}
				<div class="py-[var(--space-xl)] text-center text-[var(--sig-danger)] font-[family-name:var(--font-display)] text-[length:var(--font-size-base)]">{logsError}</div>
			{:else if logs.length === 0}
				<div class="py-[var(--space-xl)] text-center text-[var(--sig-text-muted)] font-[family-name:var(--font-display)] text-[length:var(--font-size-base)]">No logs found</div>
			{:else}
				{#each logs as log, i}
					<div class={`flex flex-wrap items-baseline gap-[var(--space-xs)] py-0.5 ${i < logs.length - 1 ? 'border-b border-[var(--sig-border)]' : ''}`}>
						<span class="text-[var(--sig-text-muted)] shrink-0">{formatLogTime(log.timestamp)}</span>
						<span class={`font-semibold shrink-0 min-w-[40px] ${
							log.level === 'error' ? 'text-[var(--sig-danger)]' :
							log.level === 'debug' ? 'text-[var(--sig-text-muted)]' :
							'text-[var(--sig-accent)]'
						}`}>{log.level.toUpperCase()}</span>
						<span class="text-[var(--sig-text)] shrink-0">[{log.category}]</span>
						<span class="text-[var(--sig-text-bright)]">{log.message}</span>
						{#if log.duration !== undefined}
							<span class="text-[var(--sig-text-muted)]">({log.duration}ms)</span>
						{/if}
						{#if log.data && Object.keys(log.data).length > 0}
							<span class="text-[var(--sig-text-muted)] text-[length:var(--font-size-xs)] max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap">{JSON.stringify(log.data)}</span>
						{/if}
						{#if log.error}
							<div class="w-full text-[var(--sig-danger)] pl-[60px] text-[length:var(--font-size-xs)]">{log.error.name}: {log.error.message}</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</ScrollArea>
</div>

<script lang="ts">
import { onMount } from "svelte";
import * as Select from "$lib/components/ui/select/index.js";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
import { ActionLabels } from "$lib/ui/action-labels";


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
let logViewport = $state<HTMLElement | null>(null);
let selectedLogKey = $state<string | null>(null);
let copied = $state(false);

const logCategories = [
	"daemon", "api", "memory", "sync", "git",
	"watcher", "embedding", "harness", "system",
	"hooks", "pipeline", "skills", "secrets", "auth",
	"session-tracker", "summary-worker", "document-worker", "maintenance",
	"retention", "llm",
];
const logLevels = ["debug", "info", "warn", "error"];

function getLogLevelClass(level: LogEntry["level"]): string {
	switch (level) {
		case "error":
			return "log-level--error";
		case "warn":
			return "log-level--warn";
		case "debug":
			return "log-level--debug";
		case "info":
		default:
			return "log-level--info";
	}
}

function buildLogKey(log: LogEntry, index: number): string {
	return `${log.timestamp}-${log.level}-${log.category}-${index}`;
}

function isViewingLatest(): boolean {
	if (logs.length === 0) return true;
	if (!selectedLogKey) return true;
	return selectedLogKey === buildLogKey(logs[logs.length - 1], logs.length - 1);
}

function selectLatestLog(): void {
	if (logs.length === 0) {
		selectedLogKey = null;
		return;
	}
	selectedLogKey = buildLogKey(logs[logs.length - 1], logs.length - 1);
}

function getSelectedLog(): LogEntry | null {
	if (!selectedLogKey) return logs.at(-1) ?? null;
	for (let i = 0; i < logs.length; i += 1) {
		if (buildLogKey(logs[i], i) === selectedLogKey) return logs[i];
	}
	return logs.at(-1) ?? null;
}

const selectedLog = $derived(getSelectedLog());

function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
	if (!logViewport) return;
	logViewport.scrollTo({
		top: logViewport.scrollHeight,
		behavior,
	});
}

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
		selectLatestLog();
		setTimeout(() => scrollToBottom("auto"), 0);
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
			const wasViewingLatest = isViewingLatest();
			logs = [...logs.slice(-499), entry];
			if (wasViewingLatest) selectLatestLog();
			if (logAutoScroll && wasViewingLatest) setTimeout(() => scrollToBottom(), 0);
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

function formatLogDate(timestamp: string): string {
	try {
		return new Date(timestamp).toLocaleString();
	} catch {
		return timestamp;
	}
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

interface LogSection {
	label: string;
	content: string;
}

function getReadableLogSections(log: LogEntry): LogSection[] {
	const data = log.data;
	if (!data) return [];

	const sections: LogSection[] = [];

	// New full-content fields first, fall back to old *Preview keys
	const inject = readString(data.inject) ?? readString(data.injectPreview);
	if (inject) sections.push({ label: "Inject", content: inject });

	const prompt = readString(data.prompt) ?? readString(data.promptPreview);
	if (prompt) sections.push({ label: "Prompt", content: prompt });

	const summaryPrompt = readString(data.summaryPrompt) ?? readString(data.summaryPromptPreview);
	if (summaryPrompt) sections.push({ label: "Summary Prompt", content: summaryPrompt });

	const summary = readString(data.summary) ?? readString(data.summaryPreview);
	if (summary) sections.push({ label: "Summary", content: summary });

	const transcript = readString(data.transcript) ?? readString(data.transcriptPreview);
	if (transcript) sections.push({ label: "Transcript", content: transcript });

	const factsPreview = readStringArray(data.factsPreview);
	if (factsPreview.length > 0) {
		const facts = factsPreview.map((fact) => `- ${fact}`).join("\n");
		sections.push({ label: "Facts", content: facts });
	}

	return sections;
}

function getReadableLogSnippet(log: LogEntry): string {
	const sections = getReadableLogSections(log);
	if (sections.length === 0) return "";
	const detail = sections.map((s) => s.content).join("\n\n").trim();
	if (detail.length <= 220) return detail;
	return `${detail.slice(0, 220)}...`;
}

async function copySelectedLog(): Promise<void> {
	if (!selectedLog) return;
	try {
		await navigator.clipboard.writeText(formatJson(selectedLog));
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 1200);
	} catch {
		copied = false;
	}
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
			<Checkbox checked={logAutoScroll} onCheckedChange={(value: unknown) => { logAutoScroll = value === true; }} class="rounded-none" />
			Auto-scroll
		</label>
		<button
			class="text-[11px] px-2 py-1 border border-[var(--sig-border)] text-[var(--sig-text)] hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
			onclick={fetchLogs}
			title="Reload logs"
		>
			{ActionLabels.Refresh}
		</button>
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

	<div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
		<ScrollArea class="min-h-0 border-r border-[var(--sig-border)]" viewportRef={logViewport}>
			<div class="font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)] leading-relaxed">
				{#if logsLoading}
					<div class="py-[var(--space-xl)] text-center text-[var(--sig-text-muted)] font-[family-name:var(--font-display)] text-[length:var(--font-size-base)]">Loading logs...</div>
				{:else if logsError}
					<div class="py-[var(--space-xl)] text-center text-[var(--sig-danger)] font-[family-name:var(--font-display)] text-[length:var(--font-size-base)]">{logsError}</div>
				{:else if logs.length === 0}
					<div class="py-[var(--space-xl)] text-center text-[var(--sig-text-muted)] font-[family-name:var(--font-display)] text-[length:var(--font-size-base)]">No logs found</div>
				{:else}
					{#each logs as log, i}
						<button
							type="button"
							class={`log-row ${getLogLevelClass(log.level)} w-full text-left px-[var(--space-md)] py-1.5 border-b border-[var(--sig-border)] hover:bg-[var(--sig-surface-raised)] cursor-pointer ${
								selectedLogKey === buildLogKey(log, i) ? "bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)]" : ""
							}`}
							onclick={() => {
								selectedLogKey = buildLogKey(log, i);
							}}
						>
							<div class="flex flex-wrap items-baseline gap-[var(--space-xs)]">
								<span class="text-[var(--sig-text-muted)] shrink-0">{formatLogTime(log.timestamp)}</span>
								<span class={`font-semibold shrink-0 min-w-[40px] ${getLogLevelClass(log.level)}`}>{log.level.toUpperCase()}</span>
								<span class="text-[var(--sig-text)] shrink-0">[{log.category}]</span>
								<span class="text-[var(--sig-text-bright)] break-all">{log.message}</span>
								{#if log.duration !== undefined}
									<span class="text-[var(--sig-text-muted)]">({log.duration}ms)</span>
								{/if}
							</div>
							{#if getReadableLogSnippet(log)}
								<div class="mt-1 text-[11px] text-[var(--sig-text-muted)] whitespace-pre-wrap break-words">{getReadableLogSnippet(log)}</div>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		</ScrollArea>
		<div class="min-h-0 overflow-auto p-[var(--space-md)] font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)]">
			{#if selectedLog}
				<div class="flex items-center justify-between gap-2 mb-[var(--space-sm)]">
					<div class="text-[var(--sig-text-muted)] text-[length:var(--font-size-xs)] uppercase tracking-[0.08em]">Log details</div>
					<button
						type="button"
						class="text-[10px] px-2 py-1 border border-[var(--sig-border)] text-[var(--sig-text)] hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
						onclick={copySelectedLog}
					>{copied ? "Copied" : ActionLabels.CopyJson}</button>
				</div>
				<div class="grid grid-cols-[80px_1fr] gap-y-1 gap-x-2 mb-[var(--space-sm)]">
					<div class="text-[var(--sig-text-muted)]">Time</div>
					<div class="text-[var(--sig-text-bright)] break-all">{formatLogDate(selectedLog.timestamp)}</div>
					<div class="text-[var(--sig-text-muted)]">Level</div>
					<div class={`uppercase ${getLogLevelClass(selectedLog.level)}`}>{selectedLog.level}</div>
					<div class="text-[var(--sig-text-muted)]">Category</div>
					<div class="text-[var(--sig-text-bright)]">{selectedLog.category}</div>
					<div class="text-[var(--sig-text-muted)]">Message</div>
					<div class="text-[var(--sig-text-bright)] break-all">{selectedLog.message}</div>
					{#if selectedLog.duration !== undefined}
						<div class="text-[var(--sig-text-muted)]">Duration</div>
						<div class="text-[var(--sig-text-bright)]">{selectedLog.duration}ms</div>
					{/if}
				</div>
				{@const logSections = getReadableLogSections(selectedLog)}
				{#if logSections.length > 0}
					<div class="mb-[var(--space-sm)]">
						<div class="text-[var(--sig-text-muted)] text-[length:var(--font-size-xs)] uppercase tracking-[0.08em] mb-1">Readable output</div>
						{#each logSections as section}
							{#if section.content.length > 500}
								<details class="mb-1 border border-[var(--sig-border)] bg-[var(--sig-surface)]">
									<summary class="cursor-pointer px-2 py-1 text-[10px] text-[var(--sig-text-muted)] hover:text-[var(--sig-text)] select-none">
										<span class="font-semibold text-[var(--sig-text)]">{section.label}</span>
										<span class="ml-1 opacity-60">({section.content.length.toLocaleString()} chars)</span>
										<span class="ml-1 opacity-40">{section.content.slice(0, 100).replace(/\n/g, " ")}...</span>
									</summary>
									<pre class="m-0 px-2 py-1 text-[10px] leading-relaxed whitespace-pre-wrap break-words text-[var(--sig-text)]">{section.content}</pre>
								</details>
							{:else}
								<div class="mb-1">
									<div class="text-[10px] text-[var(--sig-text-muted)] font-semibold mb-0.5">{section.label}</div>
									<pre class="m-0 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words border border-[var(--sig-border)] bg-[var(--sig-surface)] text-[var(--sig-text)]">{section.content}</pre>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
				<pre class="m-0 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-all border border-[var(--sig-border)] bg-[var(--sig-surface-raised)] text-[var(--sig-text-muted)]">{formatJson(selectedLog)}</pre>
			{:else}
				<div class="text-[var(--sig-text-muted)]">Select a log entry to inspect details.</div>
			{/if}
		</div>
	</div>
</div>

<style>
.log-row {
	position: relative;
	border-left: 2px solid transparent;
	border-left-color: var(--log-level-color, transparent);
}

.log-row::before {
	content: "";
	position: absolute;
	inset: 0;
	pointer-events: none;
	background: color-mix(in oklab, var(--log-level-color) 9%, transparent);
	opacity: 0;
	transition: opacity var(--dur) var(--ease);
}

.log-row:hover::before {
	opacity: 1;
}

.log-row.log-level--debug {
	--log-level-color: var(--sig-text-muted);
}

.log-row.log-level--info {
	--log-level-color: var(--sig-accent);
}

.log-row.log-level--warn {
	--log-level-color: var(--sig-accent-hover);
}

.log-row.log-level--error {
	--log-level-color: var(--sig-danger);
}

.log-level--debug {
	color: var(--sig-text-muted);
}

.log-level--info {
	color: var(--sig-accent);
}

.log-level--warn {
	color: var(--sig-accent-hover);
}

.log-level--error {
	color: var(--sig-danger);
}
</style>

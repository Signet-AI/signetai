<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
import { browser } from "$app/environment";
import * as Select from "$lib/components/ui/select/index.js";
import { ActionLabels } from "$lib/ui/action-labels";
import { onMount, tick } from "svelte";

interface LogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	category: string;
	message: string;
	data?: Record<string, unknown>;
	duration?: number;
	error?: { name: string; message: string };
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const LOG_LEVEL_ORDER: Record<LogEntry["level"], number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let logs = $state<LogEntry[]>([]);
let logsLoading = $state(false);
let logsError = $state("");
let logsStreaming = $state(false);
let logsReconnecting = $state(false);
let logsConnecting = $state(false);
let streamError = $state("");
let logEventSource: EventSource | null = null;
let streamEnabled = $state(true);
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let logLevelFilter = $state<string>("");
let logCategoryFilter = $state<string>("");
let logAutoScroll = $state(false);
let logAutoScrollPausedByScroll = $state(false);
let initialLoadDone = $state(false);
let logViewport = $state<HTMLElement | null>(null);
let selectedLogKey = $state<string | null>(null);
let copied = $state(false);
let autoScrollSnapFrame: number | null = null;
const BOTTOM_THRESHOLD_PX = 24;

const logCategories = [
	"daemon",
	"api",
	"memory",
	"sync",
	"git",
	"watcher",
	"embedding",
	"embedding-tracker",
	"harness",
	"system",
	"hooks",
	"pipeline",
	"skills",
	"secrets",
	"auth",
	"session-tracker",
	"summary-worker",
	"document-worker",
	"maintenance",
	"scheduler",
	"retention",
	"llm",
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
		default:
			return "log-level--info";
	}
}

function getLogCategoryClass(category: string): string {
	switch (category.toLowerCase()) {
		case "watcher":
			return "log-category--watcher";
		case "daemon":
			return "log-category--daemon";
		case "pipeline":
			return "log-category--pipeline";
		case "system":
			return "log-category--system";
		// Backwards compatibility for historical typo in old log emitters.
		case "embeding-tracker":
		case "embedding-tracker":
			return "log-category--embedding-tracker";
		case "document-worker":
			return "log-category--document-worker";
		case "maintenance":
			return "log-category--maintenance";
		case "git":
			return "log-category--git";
		// Backwards compatibility for historical typo in old log emitters.
		case "schedular":
		case "scheduler":
			return "log-category--scheduler";
		case "retention":
			return "log-category--retention";
		default:
			return "log-category--default";
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

function scrollToBottomNextFrame(behavior: ScrollBehavior = "auto"): void {
	if (autoScrollSnapFrame !== null) return;
	void tick().then(() => {
		if (autoScrollSnapFrame !== null) return;
		autoScrollSnapFrame = requestAnimationFrame(() => {
			autoScrollSnapFrame = null;
			if (!logAutoScroll) return;
			scrollToBottom(behavior);
		});
	});
}

function isNearBottom(viewport: HTMLElement | null): boolean {
	if (!viewport) return true;
	return viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - BOTTOM_THRESHOLD_PX;
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
		if (!initialLoadDone) {
			initialLoadDone = true;
			void tick().then(() => scrollToBottom("auto"));
		} else if (logAutoScroll) {
			scrollToBottomNextFrame("auto");
		}
	} catch {
		logsError = "Failed to fetch logs";
	} finally {
		logsLoading = false;
	}
}

function startLogStream() {
	if (!streamEnabled) return;

	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (logEventSource) logEventSource.close();
	logsConnecting = true;
	if (reconnectAttempt === 0) {
		logsReconnecting = false;
		streamError = "";
	}
	logEventSource = new EventSource("/api/logs/stream");

	logEventSource.onmessage = (event) => {
		try {
			const entry = JSON.parse(event.data);
			if (entry.type === "connected") {
				reconnectAttempt = 0;
				logsReconnecting = false;
				logsConnecting = false;
				logsStreaming = true;
				streamError = "";
				return;
			}
			if (logsConnecting) {
				logsConnecting = false;
				logsStreaming = true;
			}
			const entryLevelValue =
				typeof entry.level === "string"
					? LOG_LEVEL_ORDER[entry.level as LogEntry["level"]]
					: undefined;
			const filterLevelValue =
				LOG_LEVEL_ORDER[logLevelFilter as LogEntry["level"]];
			if (logLevelFilter && (entryLevelValue ?? -1) < (filterLevelValue ?? -1)) return;
			if (logCategoryFilter && entry.category !== logCategoryFilter) return;
			const wasViewingLatest = isViewingLatest();
			logs = [...logs.slice(-499), entry];
			if (wasViewingLatest) selectLatestLog();
			if (logAutoScroll) {
				scrollToBottomNextFrame("auto");
			}
		} catch {
			// ignore parse errors
		}
	};

	logEventSource.onerror = () => {
		if (!streamEnabled) return;

		logsStreaming = false;
		logsConnecting = false;
		logEventSource?.close();
		logEventSource = null;

		if (reconnectTimer !== null) return;

		const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 10), RECONNECT_MAX_MS);
		reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
		logsReconnecting = true;
		streamError = `Stream lost — reconnecting in ${delay / 1000}s`;

		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			startLogStream();
		}, delay);
	};
}

function stopLogStream(): void {
	streamEnabled = false;
	logsStreaming = false;
	logsConnecting = false;
	logsReconnecting = false;
	streamError = "";
	reconnectAttempt = 0;

	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	if (logEventSource) {
		logEventSource.close();
		logEventSource = null;
	}
}

function manualStartLogStream(): void {
	streamEnabled = true;
	reconnectAttempt = 0;
	logsReconnecting = false;
	streamError = "";
	startLogStream();
}

function toggleLogStream(): void {
	if (streamEnabled) {
		stopLogStream();
		return;
	}

	manualStartLogStream();
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
	const detail = sections
		.map((s) => s.content)
		.join("\n\n")
		.trim();
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
	manualStartLogStream();
	return () => {
		streamEnabled = false;
		if (autoScrollSnapFrame !== null) cancelAnimationFrame(autoScrollSnapFrame);
		if (reconnectTimer !== null) clearTimeout(reconnectTimer);
		if (logEventSource) logEventSource.close();
	};
});

$effect(() => {
	const viewport = logViewport;
	if (!viewport) return;

	const onScroll = () => {
		const nearBottom = isNearBottom(viewport);
		if (logAutoScroll && !nearBottom) {
			logAutoScroll = false;
			logAutoScrollPausedByScroll = true;
			return;
		}
		if (!logAutoScroll && logAutoScrollPausedByScroll && nearBottom) {
			logAutoScroll = true;
			logAutoScrollPausedByScroll = false;
		}
	};

	viewport.addEventListener("scroll", onScroll, { passive: true });
	onScroll();

	return () => {
		viewport.removeEventListener("scroll", onScroll);
	};
});
</script>

<div class="flex flex-col flex-1 min-h-0 p-[var(--space-sm)] lg:p-[var(--space-md)]">
	<div class="flex-1 min-h-0 grid grid-cols-1 gap-[var(--space-md)] lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
		<section class="min-h-0 flex flex-col rounded-lg border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] overflow-hidden">
			<div class="flex flex-wrap items-center gap-[var(--space-sm)] px-[var(--space-md)] py-[var(--space-sm)] border-b border-[var(--sig-border)] shrink-0">
				<Select.Root type="single" value={logLevelFilter} onValueChange={(v) => { logLevelFilter = v ?? ""; fetchLogs(); }}>
					<Select.Trigger class="font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-lg h-auto py-1 px-2 min-w-[100px]">
						{logLevelFilter || "All levels"}
					</Select.Trigger>
					<Select.Content class="bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg">
						<Select.Item value="" label="All levels" />
						{#each logLevels as level}
							<Select.Item value={level} label={level} />
						{/each}
					</Select.Content>
				</Select.Root>
				<Select.Root type="single" value={logCategoryFilter} onValueChange={(v) => { logCategoryFilter = v ?? ""; fetchLogs(); }}>
					<Select.Trigger class="font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)] bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] text-[var(--sig-text-bright)] rounded-lg h-auto py-1 px-2 min-w-[100px]">
						{logCategoryFilter || "All categories"}
					</Select.Trigger>
					<Select.Content class="bg-[var(--sig-surface-raised)] border-[var(--sig-border-strong)] rounded-lg">
						<Select.Item value="" label="All categories" />
						{#each logCategories as cat}
							<Select.Item value={cat} label={cat} />
						{/each}
					</Select.Content>
				</Select.Root>
				<label class="flex items-center gap-1.5 sig-label text-[var(--sig-text)] cursor-pointer">
					<Checkbox checked={logAutoScroll} onCheckedChange={(value: unknown) => {
						logAutoScroll = value === true;
						logAutoScrollPausedByScroll = false;
						if (logAutoScroll) {
							scrollToBottomNextFrame("auto");
						}
					}} class="rounded-lg" />
					Auto-scroll
				</label>
				<div class="ml-auto flex items-center gap-[var(--space-sm)] min-w-0">
					{#if streamError}
						<span class="sig-eyebrow truncate max-w-[220px]">
							{streamError}
						</span>
					{/if}
					<span class={`sig-label font-medium ${logsStreaming ? "text-[var(--sig-success)] [animation:pulse_2s_infinite]" : logsReconnecting || logsConnecting ? "text-[var(--sig-accent)] [animation:pulse_2s_infinite]" : "text-[var(--sig-danger)]"}`}>
						{#if logsStreaming}
							● Live
						{:else if logsReconnecting}
							↺ Reconnecting
						{:else if logsConnecting}
							◌ Connecting
						{:else}
							● Offline
						{/if}
					</span>
					<Button
						variant="outline"
						size="sm"
						class="sig-label px-2 py-1 h-auto hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
						onclick={toggleLogStream}
						title={streamEnabled ? "Disconnect stream" : "Reconnect stream"}
					>
						{streamEnabled ? "Disconnect" : "Reconnect"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="sig-label px-2 py-1 h-auto hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
						onclick={fetchLogs}
						title="Reload logs"
					>
						{ActionLabels.Refresh}
					</Button>
				</div>
			</div>

			<ScrollArea class="min-h-0 flex-1" bind:viewportRef={logViewport}>
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
								class={`log-row ${getLogLevelClass(log.level)} w-full text-left px-[var(--space-md)] py-1.5 border-b border-[var(--sig-border)] hover:bg-[var(--sig-surface)] cursor-pointer ${
									selectedLogKey === buildLogKey(log, i) ? "bg-[var(--sig-surface)] border-[var(--sig-border-strong)]" : ""
								}`}
								onclick={() => {
									selectedLogKey = buildLogKey(log, i);
								}}
							>
								<div class="flex flex-wrap items-baseline gap-[var(--space-xs)]">
									<span class="text-[var(--sig-text-muted)] shrink-0">{formatLogTime(log.timestamp)}</span>
									<span class={`font-semibold shrink-0 min-w-[40px] ${getLogLevelClass(log.level)}`}>{log.level.toUpperCase()}</span>
									<span class={`log-category ${getLogCategoryClass(log.category)} shrink-0`}>[{log.category}]</span>
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
		</section>

		<section class="log-details-window min-h-0 overflow-auto rounded-lg border border-[var(--sig-border-strong)] p-[var(--space-md)] font-[family-name:var(--font-mono)] text-[length:var(--font-size-sm)]">
			{#if selectedLog}
				<div class="grid grid-cols-[80px_1fr] gap-y-1 gap-x-2 mb-[var(--space-sm)]">
					<div class="text-[var(--sig-text-muted)]">Time</div>
					<div class="text-[var(--sig-text-bright)] break-all">{formatLogDate(selectedLog.timestamp)}</div>
					<div class="text-[var(--sig-text-muted)]">Level</div>
					<div class={`uppercase ${getLogLevelClass(selectedLog.level)}`}>{selectedLog.level}</div>
					<div class="text-[var(--sig-text-muted)]">Category</div>
					<div class={`log-category ${getLogCategoryClass(selectedLog.category)}`}>{selectedLog.category}</div>
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
								<details class="mb-1 border border-[var(--sig-border)] bg-[var(--sig-surface)] rounded-lg">
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
									<pre class="m-0 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words border border-[var(--sig-border)] rounded-lg bg-[var(--sig-surface)] text-[var(--sig-text)]">{section.content}</pre>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
				<div class="rounded-lg border border-[var(--sig-border)] bg-[var(--sig-surface)] overflow-hidden">
					<div class="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--sig-border)]">
						<div class="sig-eyebrow tracking-[0.08em]">Log details</div>
						<Button
							variant="outline"
							size="sm"
							class="sig-eyebrow px-2 py-1 h-auto hover:border-[var(--sig-border-strong)] hover:text-[var(--sig-text-bright)]"
							onclick={copySelectedLog}
						>{copied ? "Copied" : ActionLabels.CopyJson}</Button>
					</div>
					<pre class="m-0 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-all text-[var(--sig-text-muted)]">{formatJson(selectedLog)}</pre>
				</div>
			{:else}
				<div class="text-[var(--sig-text-muted)]">Select a log entry to inspect details.</div>
			{/if}
		</section>
	</div>
</div>

<style>
.log-row {
	position: relative;
	border-left: 2px solid transparent;
	border-left-color: var(--log-level-color, transparent);
}

.log-details-window {
	background:
		radial-gradient(
			circle at 86% -18%,
			color-mix(in srgb, var(--sig-accent) 16%, transparent),
			transparent 46%
		),
		linear-gradient(
			145deg,
			color-mix(in srgb, var(--sig-surface-raised) 90%, var(--sig-bg)) 0%,
			var(--sig-surface-raised) 72%
		);
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

.log-category {
	font-weight: 600;
}

.log-category--watcher {
	color: var(--sig-log-category-watcher);
}

.log-category--daemon {
	color: var(--sig-log-category-daemon);
}

.log-category--pipeline {
	color: var(--sig-log-category-pipeline);
}

.log-category--system {
	color: var(--sig-log-category-system);
}

.log-category--embedding-tracker {
	color: var(--sig-log-category-embedding-tracker);
}

.log-category--document-worker {
	color: var(--sig-log-category-document-worker);
}

.log-category--maintenance {
	color: var(--sig-log-category-maintenance);
}

.log-category--git {
	color: var(--sig-log-category-git);
}

.log-category--scheduler {
	color: var(--sig-log-category-scheduler);
}

.log-category--retention {
	color: var(--sig-log-category-retention);
}

.log-category--default {
	color: var(--sig-text);
}
</style>

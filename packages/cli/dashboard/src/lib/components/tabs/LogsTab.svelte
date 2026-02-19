<script lang="ts">
	import { onMount } from "svelte";

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
		if (logEventSource) {
			logEventSource.close();
		}

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
				// Ignore parse errors
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
		if (logsStreaming) {
			stopLogStream();
		} else {
			startLogStream();
		}
	}

	function clearLogs() {
		logs = [];
	}

	function formatLogTime(timestamp: string): string {
		return timestamp.split("T")[1]?.slice(0, 8) || "";
	}

	onMount(() => {
		fetchLogs();
		return () => {
			if (logEventSource) {
				logEventSource.close();
			}
		};
	});
</script>

<div class="logs-container">
	<div class="logs-filters">
		<select class="filter-select" bind:value={logLevelFilter} onchange={fetchLogs}>
			<option value="">All levels</option>
			{#each logLevels as level}
				<option value={level}>{level}</option>
			{/each}
		</select>
		<select class="filter-select" bind:value={logCategoryFilter} onchange={fetchLogs}>
			<option value="">All categories</option>
			{#each logCategories as cat}
				<option value={cat}>{cat}</option>
			{/each}
		</select>
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={logAutoScroll} />
			Auto-scroll
		</label>
		{#if logsStreaming}
			<span class="streaming-indicator">● Live</span>
		{/if}
	</div>

	<div class="logs-scroll" bind:this={logContainer}>
		{#if logsLoading}
			<div class="logs-empty">Loading logs...</div>
		{:else if logsError}
			<div class="logs-empty text-error">{logsError}</div>
		{:else if logs.length === 0}
			<div class="logs-empty">No logs found</div>
		{:else}
			{#each logs as log}
				<div class="log-entry log-{log.level}">
					<span class="log-time">{formatLogTime(log.timestamp)}</span>
					<span class="log-level">{log.level.toUpperCase()}</span>
					<span class="log-category">[{log.category}]</span>
					<span class="log-message">{log.message}</span>
					{#if log.duration !== undefined}
						<span class="log-duration">({log.duration}ms)</span>
					{/if}
					{#if log.data && Object.keys(log.data).length > 0}
						<span class="log-data">{JSON.stringify(log.data)}</span>
					{/if}
					{#if log.error}
						<div class="log-error">{log.error.name}: {log.error.message}</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

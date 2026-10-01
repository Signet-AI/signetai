import { TextPageControls, usePagination } from "@/components/dashboard/pagination";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/field";
import { Metric } from "@/components/ui/metric";
import { type LogEntry, api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { Download, Loader2, TriangleAlert, RefreshCw } from "@/components/mingcute-icons";
import { useMemo, useState } from "react";

import { GroupLabel, SettingSelect, SettingsGroup } from "./controls";
type LogLevel = "info" | "warn" | "error" | "debug";

function formatLogTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const base = d.toLocaleTimeString("en-GB", { hour12: false });
	return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatAge(seconds: number | null): string {
	if (seconds === null) return "never";
	if (seconds < 60) return `${Math.round(seconds)}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${Math.round(seconds / 3600)}h ago`;
}

export function formatTelemetryCount(count: number): string {
	return count.toLocaleString("en-US");
}

export function TelemetryHealthPanel() {
	const healthQuery = useAsync(() => api.getTelemetryHealth(), { key: "telemetry-health", intervalMs: 30_000 });
	const health = healthQuery.data;
	const status = !health ? "unavailable" : !health.enabled ? "disabled" : health.status;
	const statusClass =
		status === "healthy"
			? "text-success"
			: status === "degraded"
				? "text-[oklch(0.78_0.15_85)]"
				: "text-muted-foreground";
	return (
		<SettingsGroup>
			<div className="flex items-center justify-between gap-3">
				<GroupLabel suffix="· event collection and delivery">Telemetry delivery</GroupLabel>
				<span className={cn("text-xs font-medium", statusClass)}>{status}</span>
			</div>
			{healthQuery.loading ? (
				<div className="text-xs text-muted-foreground">Loading collector health…</div>
			) : health?.enabled ? (
				<>
					{health.droppedEventCount > 0 && (
						<div
							role="alert"
							className="mb-2 flex items-start gap-2 rounded-[var(--radius)] border border-[oklch(0.7_0.18_25/0.42)] bg-[oklch(0.7_0.18_25/0.1)] px-2 py-1.5 text-[10px] leading-snug text-slate-700 dark:text-slate-200"
						>
							<TriangleAlert className="mt-px size-3.5 shrink-0 text-[oklch(0.72_0.18_25)]" aria-hidden="true" />
							<span>
								{formatTelemetryCount(health.droppedEventCount)} local telemetry event
								{health.droppedEventCount === 1 ? " was" : "s were"} dropped and cannot be delivered later.
							</span>
						</div>
					)}
					<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
						<Metric label="Daemon activity" value={formatAge(health.lastDaemonEventAgeSec)} />
						<Metric label="Queued" value={formatTelemetryCount(health.queuedUnsentEventCount)} />
						<Metric label="Queue age" value={formatAge(health.oldestUnsentEventAgeSec)} />
						<Metric label="Last delivery" value={formatAge(health.lastSuccessfulDeliveryAgeSec)} />
						<Metric label="Recent failures" value={formatTelemetryCount(health.recentDeliveryFailureCount)} />
					</div>
					{health.status === "degraded" && health.queuedUnsentEventCount > 0 && (
						<div className="mt-1.5 text-[10px] leading-snug text-slate-600 dark:text-slate-300">
							Delivery is degraded. The oldest queued event is {formatAge(health.oldestUnsentEventAgeSec)}.
						</div>
					)}
				</>
			) : health ? (
				<div className="text-xs text-muted-foreground">Telemetry collection is disabled on this daemon.</div>
			) : (
				<div className="text-xs text-muted-foreground">Collector health is unavailable from this daemon.</div>
			)}
		</SettingsGroup>
	);
}

const PAGE_SIZE = 25;
const LEVELS = [
	{ value: "all", label: "All levels" },
	{ value: "error", label: "Errors" },
	{ value: "warn", label: "Warnings" },
	{ value: "info", label: "Info" },
	{ value: "debug", label: "Debug" },
];

export function LogsSection() {
	const [level, setLevel] = useState<LogLevel | "all">("all");
	const [query, setQuery] = useState("");
	const [snapshot, setSnapshot] = useState<LogEntry[] | null>(null);
	const paused = snapshot !== null;
	const logsQuery = useAsync(() => api.getLogs(200), {
		key: "logs:200",
		intervalMs: paused ? undefined : 5_000,
		deps: [paused],
	});
	const latest = useMemo(() => [...(logsQuery.data?.logs ?? [])].reverse(), [logsQuery.data]);
	const logs = snapshot ?? latest;
	const search = query.trim().toLowerCase();
	const filtered = logs.filter((entry) => {
		if (level !== "all" && entry.level !== level) return false;
		return (
			!search ||
			`${entry.message} ${entry.category} ${entry.level} ${JSON.stringify(entry.data ?? {})}`
				.toLowerCase()
				.includes(search)
		);
	});
	const { page: currentPage, pages, visible, setPage } = usePagination(filtered, PAGE_SIZE);

	function pauseUpdates() {
		if (!paused) setSnapshot(latest);
	}

	function exportLogs() {
		const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `signet-logs-${Date.now()}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="flex flex-col gap-3">
			<SettingsGroup>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<GroupLabel>Daemon logs</GroupLabel>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="outline"
							size="compact"
							disabled={!logsQuery.data && !paused}
							onClick={() => {
								if (paused) {
									setSnapshot(null);
									setPage(0);
								} else pauseUpdates();
							}}
						>
							{paused ? "Resume updates" : "Pause updates"}
						</Button>
						<Button
							variant="outline"
							size="compact"
							disabled={logsQuery.loading || paused}
							onClick={() => logsQuery.refresh()}
						>
							<RefreshCw className={cn("size-3.5", logsQuery.loading && "animate-spin")} /> Refresh
						</Button>
						<Button variant="outline" size="compact" disabled={filtered.length === 0} onClick={exportLogs}>
							<Download className="size-3.5" /> Export results
						</Button>
					</div>
				</div>
				<p className="settings-row-description mb-3">
					Latest 200 entries, newest first. {paused ? "Updates paused while you read." : "Updates every 5 seconds."}{" "}
					Expand an entry to read its full message and details.
				</p>
				<div className="flex flex-wrap gap-2">
					<SearchField
						className="min-w-0 flex-1 basis-[200px]"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setPage(0);
						}}
						placeholder="Search messages, categories, or details…"
						aria-label="Search logs"
					/>
					<div className="w-[140px] [&_.settings-control]:w-full">
						<SettingSelect
							value={level}
							options={LEVELS}
							onChange={(value) => {
								setLevel(value as LogLevel | "all");
								setPage(0);
							}}
						/>
					</div>
					{(query || level !== "all") && (
						<Button
							variant="ghost"
							size="compact"
							onClick={() => {
								setQuery("");
								setLevel("all");
								setPage(0);
							}}
						>
							Clear filters
						</Button>
					)}
				</div>
				<div className="my-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
					<span>
						{filtered.length} {filtered.length === 1 ? "entry" : "entries"}
						{search || level !== "all" ? ` matching · ${logs.length} loaded` : " loaded"}
					</span>
					<TextPageControls
						page={currentPage}
						pages={pages}
						onPage={(next) => {
							pauseUpdates();
							setPage(next);
						}}
					/>
				</div>
				{logsQuery.loading && !logsQuery.data && !paused ? (
					<p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" /> Loading logs…
					</p>
				) : !logsQuery.data && !paused ? (
					<p role="status" className="py-6 text-xs text-muted-foreground">
						Could not load daemon logs. Refresh to try again.
					</p>
				) : filtered.length === 0 ? (
					<p role="status" className="py-6 text-xs text-muted-foreground">
						{logs.length === 0
							? "No daemon logs yet."
							: "No entries match your filters. Try another search or clear the filters."}
					</p>
				) : (
					visible.map((entry, index) => (
						<details
							key={`${entry.timestamp}:${entry.category}:${currentPage}:${index}`}
							className="group min-w-0 border-t border-border/60"
							onToggle={(event) => {
								if (event.currentTarget.open) pauseUpdates();
							}}
						>
							<summary className="cursor-pointer list-none py-3 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
								<div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
									<time
										dateTime={entry.timestamp}
										title={new Date(entry.timestamp).toLocaleString()}
										className="font-mono"
									>
										{formatLogTime(entry.timestamp)}
									</time>
									<span
										className={cn(
											"font-medium",
											entry.level === "error" && "text-destructive",
											entry.level === "warn" && "text-[oklch(0.72_0.14_85)]",
										)}
									>
										{entry.level === "warn" ? "Warning" : entry.level.charAt(0).toUpperCase() + entry.level.slice(1)}
									</span>
									<span className="break-all">{entry.category}</span>
									<span className="ml-auto group-open:rotate-90" aria-hidden="true">
										›
									</span>
								</div>
								<p className="line-clamp-2 break-words text-[13px] leading-relaxed">{entry.message}</p>
							</summary>
							<div className="pb-4 text-xs">
								<p className="mb-2 text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</p>
								<p className="whitespace-pre-wrap break-words leading-relaxed">{entry.message}</p>
								{entry.data && Object.keys(entry.data).length > 0 && (
									<pre className="mt-3 whitespace-pre-wrap break-all rounded-[var(--radius)] bg-muted/40 p-3 font-mono text-xs leading-relaxed">
										{JSON.stringify(entry.data, null, 2)}
									</pre>
								)}
							</div>
						</details>
					))
				)}
			</SettingsGroup>
			<TelemetryHealthPanel />
		</div>
	);
}

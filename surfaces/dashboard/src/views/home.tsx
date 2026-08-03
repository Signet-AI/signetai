import { useEffect, useMemo, useState } from "react";
import { Filter, Maximize2 } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { ActivityHeatmap, KpiRow, useDateString, type DayBucket, type KpiData } from "@/components/home/kpi";
import { DailyBrief } from "@/components/home/daily-brief";
import { Panel } from "@/components/home/panel";
import { sourceLogo } from "@/components/icons";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";

export function HomeView() {
	const today = useDateString("");
	const status = useAsync(() => api.getStatus(), { intervalMs: 30000 });
	const stats = useAsync(() => api.getKnowledgeStats(), { intervalMs: 30000 }).data;
	const sourcesQuery = useAsync(() => api.getSources(), { intervalMs: 30000 });
	const fetchedSources = sourcesQuery.data?.sources;
	const [lastSources, setLastSources] = useState<typeof fetchedSources>();
	useEffect(() => {
		if (fetchedSources) setLastSources(fetchedSources);
	}, [fetchedSources]);
	const sources = fetchedSources ?? lastSources;
	const timeline = useAsync(() => api.getMemoryTimeline(new Date().getTimezoneOffset())).data;

	const kpis: KpiData[] = useMemo(() => {
		const totalMemories = timeline?.totalMemories ?? stats?.entityCount;
		return [
			{
				label: "Memories",
				value: totalMemories ? totalMemories.toLocaleString() : "—",
				sub: "today",
				trend: "+126",
				live: true,
			},
			{ label: "Ontology nodes", value: stats?.entityCount?.toLocaleString() ?? "—", sub: "indexed", live: true },
			{ label: "Agents", value: "3", sub: "2 of 3 active", ring: { value: 2 / 3, sub: "" } },
			{
				label: "Sources",
				value: sources ? String(sources.length) : "—",
				sub: `${sources?.filter((s) => s.enabled).length ?? 0} of ${sources?.length ?? 0} syncing`,
				ring: { value: sources ? sources.filter((s) => s.enabled).length / Math.max(1, sources.length) : 0, sub: "" },
			},
		];
	}, [timeline, stats?.entityCount, sources]);

	// The reference uses a full 36×7 contribution grid. Older daemons omit
	// dailyBuckets, so retain the visual shape until they are upgraded.
	const days: DayBucket[] = useMemo(() => {
		if (timeline?.dailyBuckets?.length) {
			return timeline.dailyBuckets.map((bucket) => ({ date: bucket.date, count: bucket.memoriesAdded }));
		}
		return Array.from({ length: 252 }, (_, index) => ({ date: `d${index}`, count: 0 }));
	}, [timeline]);

	return (
		<div className="flex flex-col gap-3.5">
			<div className="flex shrink-0 items-center justify-between gap-4">
				<h1 className="m-0 text-[19px] font-semibold leading-none tracking-[-0.02em]">
					Home
				</h1>
				<span className="text-[12.5px] leading-none text-muted-foreground">
					{today}
				</span>
			</div>
			<KpiRow cards={kpis}>
				<HomeControls />
			</KpiRow>

			<div className="grid grid-cols-1 items-start gap-6 pt-1 lg:grid-cols-[1.45fr_1fr]">
				<div className="flex flex-col gap-4.5">
					<DailyBrief agentId={status.data?.agentId} agentSettled={!status.loading}>
						<Surface className="group mt-4 flex flex-col px-4 pt-3.5 pb-3.25">
							<div className="mb-2 flex items-center justify-between">
								<span className="text-[12px] font-semibold tracking-tight">Activity</span>
								<span className="font-mono text-[10px] text-muted-foreground">
									{timeline?.totalMemories.toLocaleString() ?? "—"} memories · 36w
								</span>
								<div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-60">
									<span className="grid size-5.5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
										<Filter className="size-3" />
									</span>
									<span className="grid size-5.5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
										<Maximize2 className="size-3" />
									</span>
								</div>
							</div>
							<ActivityHeatmap days={days} />
						</Surface>
						<div className="mt-4 flex items-center gap-2 border-t border-border pt-3 font-mono text-[11px] text-muted-foreground">
							<span>last sync 2m ago</span>
							<span> · </span>
							<span>{status.data?.pipelineV2?.paused ? "pipeline paused" : "pipeline active"}</span>
							<div className="flex-1" />
						</div>
					</DailyBrief>
				</div>

				<div className="flex flex-col gap-4.5">
					<Panel
						title="Sources"
						meta={`${sources?.filter((s) => s.enabled).length ?? 0} connected · 24h`}
					>
						{sourcesQuery.loading ? (
							<div className="grid min-h-[210px] place-items-center">
								<span className="font-mono text-[10.5px] text-muted-foreground">Loading sources…</span>
							</div>
						) : !sources ? (
							<div className="grid min-h-[210px] place-items-center text-center">
								<div className="flex flex-col items-center gap-1.5">
									<span className="font-mono text-[10.5px] text-muted-foreground">Couldn’t load sources</span>
									<span className="text-[11px] text-muted-foreground">Check the daemon connection and try again.</span>
								</div>
							</div>
						) : sources?.length ? (
							<div className="flex flex-col">
								{sources.slice(0, 4).map((s, idx) => (
								<SourceRow
									key={s.id}
									logo={sourceLogo(s.kind)}
									name={s.name}
									acct={s.root}
									delta={s.stats?.indexed}
									last={idx === Math.min(3, sources.length - 1)}
								/>
							))}
							</div>
						) : (
							<div className="grid min-h-[210px] place-items-center text-center">
								<div className="flex flex-col items-center gap-1.5">
									<span className="font-mono text-[10.5px] text-muted-foreground">No sources connected</span>
									<span className="text-[11px] text-muted-foreground">Connect a source to begin indexing.</span>
								</div>
							</div>
						)}
					</Panel>

					<Panel title="Review suggestions" meta="3 pending">
						<div className="flex flex-col">
							{REVIEW_ROWS.map((r, idx) => (
								<ReviewRow key={idx} {...r} last={idx === REVIEW_ROWS.length - 1} />
							))}
						</div>
					</Panel>
				</div>
			</div>
		</div>
	);
}

function SourceRow({
	logo,
	name,
	acct,
	delta,
	last,
}: {
	logo: React.ReactNode;
	name: string;
	acct: string;
	delta?: number;
	last: boolean;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-[18px_1fr_auto] items-center gap-2.5 py-1.75",
				!last && "border-b border-border",
			)}
		>
			<span className="grid size-4.5 place-items-center text-foreground">{logo}</span>
			<span className="flex flex-col leading-tight">
				<span className="text-[12px] font-medium">{name}</span>
				<span className="font-mono text-[10.5px] text-[oklch(0.46_0_0)] dark:text-[oklch(0.84_0_0)]">{acct}</span>
			</span>
			<span
				className={cn(
					"font-mono text-[10.5px] text-muted-foreground",
					delta === 0 && "opacity-40",
				)}
			>
				<b className={delta === 0 ? "text-muted-foreground opacity-40" : "text-foreground"}>
					+{delta ?? 0}
				</b>
			</span>
		</div>
	);
}

function ReviewRow({
	text,
	actions,
	last,
}: {
	text: React.ReactNode;
	actions: readonly [string, string];
	last: boolean;
}) {
	return (
		<div
			className={cn(
				"grid min-h-[50px] grid-cols-[minmax(0,1fr)_168px] items-center gap-4 py-1",
				!last && "border-b border-border",
			)}
		>
			<div className="text-[12.5px] leading-[1.4] [&_b]:font-semibold">{text}</div>
			<div className="flex justify-end gap-1.5">
				{actions.map((action, index) => (
					<button
						key={action}
						type="button"
						className={cn(
							"min-w-[74px] whitespace-nowrap rounded-[var(--radius)] border px-2 py-[5px] text-[11.5px] font-medium transition-colors",
							index === 1
								? "border-primary bg-primary text-primary-foreground"
								: "border-[oklch(1_0_0/0.2)] text-muted-foreground hover:border-[oklch(1_0_0/0.34)] hover:bg-[oklch(1_0_0/0.07)] hover:text-foreground [html:not(.dark)_&]:border-[oklch(0_0_0/0.16)] [html:not(.dark)_&]:hover:border-[oklch(0_0_0/0.28)] [html:not(.dark)_&]:hover:bg-[oklch(0_0_0/0.05)]",
						)}
					>
						{action}
					</button>
				))}
			</div>
		</div>
	);
}

const REVIEW_ROWS: { text: React.ReactNode; actions: readonly [string, string] }[] = [
	{
		text: (
			<>
				<b>signet</b> and <b>dashboard</b> are the same entity across 4 sources. Merge?
			</>
		),
		actions: ["Discard", "Confirm"],
	},
	{
		text: (
			<>
				New recurring actor <b>Mira</b> detected in 12 memories — create an agent?
			</>
		),
		actions: ["Merge", "New agent"],
	},
	{
		text: (
			<>
				<b>local-first</b> and <b>hosted inference</b> appear contradictory in recent notes.
			</>
		),
		actions: ["Skip", "Link"],
	},
];

/** Page-head controls: time-range segmented control + ⌘K command trigger + refresh. */
function HomeControls() {
	const [range, setRange] = useState("14d");
	return (
		<div className="flex items-center gap-2">
			<div className="inline-flex h-7.5 overflow-hidden rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] [html:not(.dark)_&]:border-border">
				{["24h", "7d", "14d", "30d"].map((r) => (
					<button
						key={r}
						type="button"
						onClick={() => setRange(r)}
						className={cn(
							"h-full border-r border-[oklch(1_0_0/0.08)] bg-none px-2.25 font-mono text-[10.5px] last:border-r-0",
							range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{r}
					</button>
				))}
			</div>
			<button
				type="button"
				title="Command palette"
				className="inline-flex h-7.5 items-center justify-center gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] px-2.25 font-mono text-[11px] text-muted-foreground [html:not(.dark)_&]:border-border"
			>
				<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
					<circle cx="11" cy="11" r="7" />
					<path d="m21 21-4.3-4.3" />
				</svg>
				⌘K
			</button>
			<button
				type="button"
				title="Manual sync"
				aria-label="Refresh"
				className="grid size-7.5 place-items-center rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] text-muted-foreground hover:text-foreground [html:not(.dark)_&]:border-border"
			>
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
					<path d="M21 12a9 9 0 1 1-2.64-6.36" />
					<path d="M21 3v6h-6" />
				</svg>
			</button>
		</div>
	);
}

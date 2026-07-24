import { useMemo, useState } from "react";
import { Surface } from "@/components/ui/surface";
import { ActivityHeatmap, KpiRow, useDateString, type DayBucket, type KpiData } from "@/components/home/kpi";
import { DailyBrief } from "@/components/home/daily-brief";
import { Panel } from "@/components/home/panel";
import { sourceLogo } from "@/components/icons";
import { api, type SignetSource } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";

export function HomeView() {
	const today = useDateString("");
	const status = useAsync(() => api.getStatus(), { intervalMs: 30000 });
	const stats = useAsync(() => api.getKnowledgeStats(), { intervalMs: 30000 }).data;
	const { sources } = useAsync(() => api.getSources(), { intervalMs: 30000 }).data ?? {};
	const timeline = useAsync(() => api.getMemoryTimeline()).data;

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
				sub: `${sources?.filter((s) => s.enabled).length ?? 0} active`,
				ring: { value: sources ? sources.filter((s) => s.enabled).length / Math.max(1, sources.length) : 0, sub: "" },
			},
		];
	}, [timeline, stats?.entityCount, sources]);

	// Build a 5-week heatmap from the memory timeline buckets (daily granularity).
	const days: DayBucket[] = useMemo(() => {
		if (!timeline?.buckets?.length) {
			// fallback: 35 zero cells so the grid holds its shape while loading
			return Array.from({ length: 35 }, (_, i) => ({ date: `d${i}`, count: 0 }));
		}
		// Flatten buckets to per-day counts where available; otherwise synthesize
		// from the last 35 days around the buckets' memoryAdded totals.
		const out: DayBucket[] = [];
		const now = new Date();
		for (let i = 34; i >= 0; i--) {
			const d = new Date(now);
			d.setDate(now.getDate() - i);
			const key = d.toISOString().slice(0, 10);
			const bucket = timeline.buckets.find((b) => b.start.slice(0, 10) === key);
			out.push({ date: key, count: bucket?.memoriesAdded ?? 0 });
		}
		return out;
	}, [timeline]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-4">
					<h1 className="m-0 text-[19px] font-semibold leading-none tracking-[-0.02em]">Home</h1>
					<span className="text-[12.5px] leading-none text-muted-foreground">{today}</span>
				</div>
				<HomeControls />
			</div>

			<KpiRow cards={kpis} />

			<div className="grid flex-1 grid-cols-1 gap-6 pt-1 lg:grid-cols-[1.45fr_1fr]">
				<div className="flex flex-col gap-4.5">
					<DailyBrief
						insights={[
							{
								text: (
									<>
										You've been deep in the <b>dashboard rewrite (#948)</b> for three days running.
										Your stance hardened overnight —{" "}
										<b>Svelte is out, Vite + React + shadcn/ui is in.</b> You cited the Electron{" "}
										<span className="mono">app://</span> static-SPA contract as the deciding factor.
									</>
								),
								tag: "41 related memories · decision · source: #948",
							},
							{
								text: (
									<>
										<b>Mira flagged a tension twice this week:</b> you keep reaching for hosted
										inference while insisting on local-first ownership. It's worth a deliberate call
										before it becomes a habit — your own notes contradict on this 4 times.
									</>
								),
								tag: "observation · inference-routing · raised by Mira",
							},
							{
								text: (
									<>
										Your reading on <b>"infrastructure-forward positioning"</b> is converging. Six
										sources now point at the same headline territory (
										<i>persistent identity for intelligent systems</i>). This looks ready to commit
										as messaging.
									</>
								),
								tag: "convergence · 6 sources · positioning",
							},
						]}
						caption="Synthesized from 126 memories · 3 insights"
					/>

					<Surface className="mt-5 flex flex-col gap-3 px-4 pt-3.5 pb-3.25">
						<div className="flex items-center justify-between">
							<span className="text-[12px] font-semibold tracking-tight">Activity</span>
							<span className="font-mono text-[10px] text-muted-foreground">
								{timeline?.totalMemories.toLocaleString() ?? "—"} memories · 14d
							</span>
						</div>
						<ActivityHeatmap days={days} />
						<div className="flex items-center gap-2 pt-4 font-mono text-[11px] text-muted-foreground">
							<span>last sync 2m ago</span>
							<span> · </span>
							<span>{status.data?.pipelineV2?.paused ? "pipeline paused" : "pipeline active"}</span>
							<div className="flex-1" />
						</div>
					</Surface>
				</div>

				<div className="flex flex-col gap-4.5">
					<Panel
						title="Sources"
						meta={`${sources?.filter((s) => s.enabled).length ?? 0} connected · 24h`}
					>
						<div className="flex flex-col">
							{(sources ?? MOCK_SOURCES).slice(0, 4).map((s, idx) => (
								<SourceRow
									key={s.id}
									logo={sourceLogo(s.kind)}
									name={s.name}
									acct={s.root}
									delta={s.stats?.indexed}
									last={idx === Math.min(3, (sources ?? MOCK_SOURCES).length - 1)}
								/>
							))}
						</div>
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

const REVIEW_ACTIONS = ["Discard", "Confirm", "Merge", "Skip", "Link", "New agent"] as const;

function ReviewRow({
	text,
	primary,
	last,
}: {
	text: React.ReactNode;
	primary?: number;
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
				{REVIEW_ACTIONS.map((a, i) => (
					<button
						key={a}
						type="button"
						className={cn(
							"min-w-[74px] whitespace-nowrap rounded-[var(--radius)] border px-2 py-1.25 font-mono text-[11.5px] font-medium transition-colors",
							i === primary
								? "border-primary bg-primary text-primary-foreground"
								: "border-[oklch(1_0_0/0.2)] text-muted-foreground hover:border-[oklch(1_0_0/0.34)] hover:bg-[oklch(1_0_0/0.07)] hover:text-foreground",
						)}
					>
						{a}
					</button>
				))}
			</div>
		</div>
	);
}

const REVIEW_ROWS: { text: React.ReactNode; primary?: number }[] = [
	{
		text: (
			<>
				<b>signet</b> and <b>dashboard</b> are the same entity across 4 sources. Merge?
			</>
		),
		primary: 2,
	},
	{
		text: (
			<>
				New recurring actor <b>Mira</b> detected in 12 memories — create an agent?
			</>
		),
		primary: 5,
	},
	{
		text: (
			<>
				<b>local-first</b> and <b>hosted inference</b> appear contradictory in recent notes.
			</>
		),
		primary: 4,
	},
];

const MOCK_SOURCES: SignetSource[] = [];

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

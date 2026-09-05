import { DailyBrief } from "@/components/home/daily-brief";
import { HomeAgentsPanel } from "@/components/home/agents";
import { ActivityHeatmap, type DayBucket, type KpiData, KpiFooter, useDateString } from "@/components/home/kpi";
import { HomeRecentMemories } from "@/components/home/recent-memories";
import { HomeSecretsPanel } from "@/components/home/secrets";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { HomeSourcesPanel } from "@/views/sources";
import { ChevronRight, FileText } from "@/components/mingcute-icons";
import { useEffect, useMemo, useState } from "react";

export function HomeView() {
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
	const today = useDateString(new Date().toLocaleDateString("en-US"));

	const kpis: KpiData[] = useMemo(() => {
		const totalMemories = timeline?.totalMemories;
		// The dashboard is scoped to the configured agent returned by the daemon.
		// Do not present the old mockup's three-agent fixture as live state.
		const agentCount = status.data?.agentId ? 1 : 0;
		return [
			{
				label: "Memories",
				value: totalMemories?.toLocaleString() ?? "—",
				sub: "stored",
			},
			{ label: "Ontology nodes", value: stats?.entityCount?.toLocaleString() ?? "—", sub: "indexed" },
			{
				label: "Agents",
				value: String(agentCount),
				sub: `of ${agentCount} active`,
			},
			{
				label: "Sources",
				value: sources ? String(sources.filter((s) => s.enabled).length) : "—",
				sub: sources ? `of ${sources.length} syncing` : "unavailable",
			},
		];
	}, [status.data?.agentId, timeline, stats?.entityCount, sources]);

	// The reference uses a full 36×7 contribution grid. Older daemons omit
	// dailyBuckets, so retain the visual shape until they are upgraded.
	const days: DayBucket[] = useMemo(() => {
		if (timeline?.dailyBuckets?.length) {
			return timeline.dailyBuckets.map((bucket) => ({ date: bucket.date, count: bucket.memoriesAdded }));
		}
		return Array.from({ length: 252 }, (_, index) => ({ date: `d${index}`, count: 0 }));
	}, [timeline]);

	return (
		<div className="home-dashboard">
			<div className="home-workspace">
				<section className="home-today" aria-labelledby="today-title">
					<div className="home-page-heading flex justify-between gap-4">
						<div>
							<h1
								id="today-title"
								className="m-0 text-[26px] font-semibold leading-none tracking-[-0.035em] text-foreground"
							>
								Today
							</h1>
							<p className="mt-2 mb-0 text-[13px] text-muted-foreground">{today}</p>
						</div>
						<span className="hidden pb-0.5 text-[12px] italic text-muted-foreground/80 xl:block">
							A more memorable you.
						</span>
					</div>
					<DailyBrief agentId={status.data?.agentId} agentSettled={!status.loading} />
					<div className="home-brief-divider" />
					<HomeRecentMemories />
					<div className="home-activity">
						<div className="mb-3 flex items-center justify-between">
							<h2 className="m-0 text-[15px] font-semibold tracking-tight text-foreground">Activity</h2>
						</div>
						<ActivityHeatmap days={days} />
					</div>
				</section>

				<section
					className="home-system"
					aria-labelledby="system-title"
					tabIndex={0}
				>
					<div className="home-page-heading">
						<h2
							id="system-title"
							className="m-0 text-[26px] font-semibold leading-none tracking-[-0.035em] text-foreground"
						>
							System
						</h2>
						<p className="mt-2 mb-0 text-[13px] text-muted-foreground">Your knowledge, agents, and connections.</p>
					</div>
					<HomeSourcesPanel
						sources={sources}
						loading={sourcesQuery.loading && sources === undefined}
						onRefresh={sourcesQuery.refresh}
					/>
					<HomeWidgetSeparator />
					<HomeAgentsPanel activeAgentId={status.data?.agentId} />
					<HomeWidgetSeparator />
					<ReviewSuggestions />
					<HomeWidgetSeparator />
					<HomeSecretsPanel />
				</section>
			</div>

			<KpiFooter cards={kpis} />
		</div>
	);
}

function HomeWidgetSeparator() {
	return <div aria-hidden="true" className="home-system-divider" />;
}

function ReviewSuggestions() {
	const proposals = useAsync(() => api.getOntologyProposals("pending", 20), { intervalMs: 15000 });
	const items = proposals.data?.items ?? [];
	const meta = proposals.loading && proposals.data === null ? "loading…" : `${items.length} pending`;

	return (
		<section className="py-5" aria-labelledby="review-suggestions-title">
			<div className="flex items-baseline gap-2.5">
				<h2 id="review-suggestions-title" className="m-0 text-[15px] font-semibold tracking-tight text-foreground">
					Review suggestions
				</h2>
				<span className="font-mono text-[10.5px] text-muted-foreground">{meta}</span>
			</div>
			{proposals.loading && proposals.data === null ? (
				<div className="py-4 font-mono text-[10.5px] text-muted-foreground">
					<span className="font-mono text-[10.5px] text-muted-foreground">Loading review suggestions…</span>
				</div>
			) : proposals.data === null ? (
				<div className="flex items-center gap-2 py-4 text-[11px] text-muted-foreground">
					<span>Unable to load review suggestions. Check the daemon connection and try again.</span>
					<button type="button" className="home-text-action shrink-0" onClick={() => void proposals.refresh()}>
						Retry
					</button>
				</div>
			) : items.length === 0 ? (
				<div className="mt-4 flex items-center gap-3 text-muted-foreground">
					<FileText className="size-5 shrink-0" />
					<div>
						<div className="text-[12px] text-foreground">No reviews pending</div>
						<div className="mt-0.5 text-[11px]">New suggestions will appear here when they are ready for review.</div>
					</div>
					<ChevronRight className="ml-auto size-3.5" />
				</div>
			) : (
				<div className="flex flex-col">
					{items.map((proposal, index) => (
						<ReviewProposalRow
							key={proposal.id}
							proposal={proposal}
							last={index === items.length - 1}
							onSettled={proposals.refresh}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function ReviewProposalRow({
	proposal,
	last,
	onSettled,
}: {
	proposal: import("@/lib/api").OntologyProposal;
	last: boolean;
	onSettled: () => void;
}) {
	const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [secondary, primary] = proposalActions(proposal.operation);
	const text = proposal.rationale.trim() || proposalFallback(proposal.operation);

	const settle = async (action: "apply" | "reject") => {
		setBusy(action);
		setError(null);
		const result =
			action === "apply"
				? await api.applyOntologyProposal(proposal.id)
				: await api.rejectOntologyProposal(proposal.id, "Rejected from dashboard review");
		setBusy(null);
		if (!result.ok) {
			setError(result.error ?? "Unable to update this suggestion. Try again.");
			return;
		}
		onSettled();
	};

	return (
		<div
			className={cn(
				"grid min-h-[50px] grid-cols-[minmax(0,1fr)_168px] items-center gap-4 py-1",
				!last && "border-b border-border",
			)}
		>
			<div className="min-w-0 text-[12.5px] leading-[1.4]">
				<div>{text}</div>
				{error && <div className="mt-1 font-mono text-[10px] text-destructive">{error}</div>}
			</div>
			<div className="flex justify-end gap-1.5">
				<ReviewActionButton
					label={secondary}
					busy={busy === "reject"}
					disabled={busy !== null}
					onClick={() => void settle("reject")}
				/>
				<ReviewActionButton
					label={primary}
					primary
					busy={busy === "apply"}
					disabled={busy !== null}
					onClick={() => void settle("apply")}
				/>
			</div>
		</div>
	);
}

function ReviewActionButton({
	label,
	primary = false,
	busy,
	disabled,
	onClick,
}: {
	label: string;
	primary?: boolean;
	busy: boolean;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"min-w-[74px] whitespace-nowrap rounded-[var(--radius)] border px-2 py-[5px] text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				primary
					? "border-primary bg-primary text-primary-foreground"
					: "home-review-secondary-action",
			)}
		>
			{busy ? "…" : label}
		</button>
	);
}

function proposalActions(operation: string): readonly [string, string] {
	if (operation === "merge_entities" || operation === "merge_aspects") return ["Discard", "Merge"];
	if (operation === "create_link" || operation === "update_link") return ["Skip", "Link"];
	if (operation === "create_entity") return ["Discard", "Create"];
	return ["Discard", "Confirm"];
}

function proposalFallback(operation: string): string {
	if (operation === "merge_entities") return "Dreaming found entities that may be duplicates. Merge them?";
	if (operation === "merge_aspects") return "Dreaming found aspects that may describe the same domain. Merge them?";
	if (operation === "create_link" || operation === "update_link")
		return "Dreaming found a relationship that may belong in the ontology. Link them?";
	if (operation === "create_entity")
		return "Dreaming found a durable entity that may belong in the ontology. Create it?";
	return "Dreaming found an ontology change that needs your confirmation.";
}

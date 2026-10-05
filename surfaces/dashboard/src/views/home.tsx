import { PageHeading, SectionHeading } from "@/components/dashboard/heading";
import { DailyBrief } from "@/components/home/daily-brief";
import { HomeAgentsPanel } from "@/components/home/agents";
import { HomeConnectorsPanel } from "@/components/home/connectors";
import { ActivityHeatmap, type DayBucket, type KpiData, KpiFooter, useDateString } from "@/components/home/kpi";
import { HomeRecentMemories } from "@/components/home/recent-memories";
import { HomeSecretsPanel } from "@/components/home/secrets";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { HomeSourcesPanel } from "@/components/home/sources";
import { useEffect, useMemo, useState } from "react";

export function HomeView() {
	const status = useAsync(() => api.getStatus(), { key: "status", intervalMs: 30000 });
	const stats = useAsync(() => api.getKnowledgeStats(), { key: "knowledge-stats", intervalMs: 30000 }).data;
	const sourcesQuery = useAsync(() => api.getSources(), { key: "sources", intervalMs: 30000 });
	const sources = sourcesQuery.data?.sources;
	const timeline = useAsync(() => api.getMemoryTimeline(new Date().getTimezoneOffset()), {
		key: `timeline:${new Date().getTimezoneOffset()}`,
	}).data;
	const today = useDateString(new Date().toLocaleDateString("en-US"));
	const harnessesQuery = useAsync(() => api.getHarnesses(), { key: "harnesses", intervalMs: 30000 });
	const connectionRecord = harnessesQuery.data?.data?.configuredHarnesses;
	const [lastConnected, setLastConnected] = useState(false);
	const connected = harnessesQuery.data?.data ? (connectionRecord?.length ?? 0) > 0 : lastConnected;
	useEffect(() => {
		if (harnessesQuery.data?.data) setLastConnected((connectionRecord?.length ?? 0) > 0);
		else if (harnessesQuery.error && harnessesQuery.data === null) setLastConnected(false);
	}, [harnessesQuery.data, harnessesQuery.error, connectionRecord]);

	const kpis: KpiData[] = useMemo(() => {
		const totalMemories = timeline?.totalMemories;
		return [
			{
				label: "Memories",
				value: totalMemories?.toLocaleString() ?? "—",
				sub: "stored",
			},
			{ label: "Ontology nodes", value: stats?.entityCount?.toLocaleString() ?? "—", sub: "indexed" },
		];
	}, [timeline, stats?.entityCount]);
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
					<PageHeading id="today-title" title="Today" description={today} />
					{!connected && (
						<a href="#setup" className="self-start text-body underline underline-offset-4">
							Set up your memory connection
						</a>
					)}
					<DailyBrief agentId={status.data?.agentId} agentSettled={!status.loading} />
					<div className="home-brief-divider" />
					<HomeRecentMemories />
					<div className="home-activity">
						<ActivityHeatmap days={days} heading={<SectionHeading title="Activity" />} />
					</div>
				</section>

				<section className="home-system" aria-labelledby="system-title">
					<PageHeading
						id="system-title"
						title="System"
						level="h2"
						description="Your knowledge, agents, and connections."
					/>
					<HomeSourcesPanel
						sources={sources}
						loading={sourcesQuery.loading && sources === undefined}
						onRefresh={sourcesQuery.refresh}
					/>
					<HomeWidgetSeparator />
					<HomeConnectorsPanel result={harnessesQuery.data} loading={harnessesQuery.loading} />
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
	const proposals = useAsync(() => api.getOntologyProposals("pending", 20), {
		key: "proposals:pending:20",
		intervalMs: 15000,
	});
	const items = proposals.data?.items ?? [];
	const meta = proposals.loading && proposals.data === null ? "loading…" : `${items.length} pending`;

	return (
		<section aria-labelledby="review-suggestions-title">
			<SectionHeading
				id="review-suggestions-title"
				title="Review suggestions"
				meta={<span className="text-meta tabular-nums text-muted-foreground">{meta}</span>}
			/>
			{proposals.loading && proposals.data === null ? (
				<div className="py-4 text-meta tabular-nums text-muted-foreground">
					<span className="text-meta tabular-nums text-muted-foreground">Loading review suggestions…</span>
				</div>
			) : proposals.data === null ? (
				<div className="flex items-center gap-2 py-4 text-meta text-muted-foreground">
					<span>Unable to load review suggestions. Check the daemon connection and try again.</span>
					<button type="button" className="home-text-action shrink-0" onClick={() => void proposals.refresh()}>
						Retry
					</button>
				</div>
			) : items.length === 0 ? (
				<p className="mt-2 text-small text-muted-foreground">
					Nothing to review. Suggestions from dreaming will show up here.
				</p>
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
			<div className="min-w-0 text-body leading-[1.4]">
				<div>{text}</div>
				{error && <div className="mt-1 text-meta tabular-nums text-destructive">{error}</div>}
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
				"h-7 min-w-[68px] whitespace-nowrap rounded-full border px-3 text-small font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				primary ? "border-primary bg-primary text-primary-foreground" : "home-review-secondary-action",
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

import { PageHeading, SectionAction, SectionHeading, type StatusTone } from "@/components/dashboard/heading";
import { DailyBrief } from "@/components/home/daily-brief";
import { HomeAgentsPanel } from "@/components/home/agents";
import { HomeConnectorsPanel, connectorIssue } from "@/components/home/connectors";
import { ActivityHeatmap, type DayBucket, type KpiData, KpiFooter, useDateString } from "@/components/home/kpi";
import { HomeRecentMemories } from "@/components/home/recent-memories";
import { HomeSecretsPanel } from "@/components/home/secrets";
import { type HarnessConnector, type SignetSource, api } from "@/lib/api";
import { useView } from "@/lib/view-context";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { HomeSourcesPanel } from "@/components/home/sources";
import { type ReactNode, useEffect, useMemo, useState } from "react";

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
	const [sourceFocus, setSourceFocus] = useState<{ id: string; at: number } | null>(null);
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
					<NeedsAttention
						sources={sources}
						connectors={harnessesQuery.data?.error ? undefined : harnessesQuery.data?.data?.connectors}
						onShowSource={(id) => setSourceFocus({ id, at: Date.now() })}
					/>
					<div className="home-setup-list">
						<HomeSourcesPanel
							sources={sources}
							loading={sourcesQuery.loading && sources === undefined}
							onRefresh={sourcesQuery.refresh}
							focus={sourceFocus}
						/>
						<HomeConnectorsPanel result={harnessesQuery.data} loading={harnessesQuery.loading} />
						<HomeAgentsPanel activeAgentId={status.data?.agentId} />
						<HomeSecretsPanel />
					</div>
				</section>
			</div>

			<KpiFooter cards={kpis} />
		</div>
	);
}

// Only things that need the user: unhealthy sources, connectors that need sign-in, and pending suggestions.
// Renders nothing when all is well, so the setup list leads.
function NeedsAttention({
	sources,
	connectors,
	onShowSource,
}: {
	sources?: readonly SignetSource[];
	connectors?: readonly HarnessConnector[];
	onShowSource: (id: string) => void;
}) {
	const { openSettings } = useView();
	const proposals = useAsync(() => api.getOntologyProposals("pending", 20), {
		key: "proposals:pending:20",
		intervalMs: 15000,
	});
	const suggestions = proposals.data?.items ?? [];
	const sourceIssues = (sources ?? []).filter(
		(source) => source.health?.status === "unhealthy" || source.health?.status === "degraded",
	);
	const connectorIssues = (connectors ?? []).flatMap((connector) => {
		const issue = connectorIssue(connector);
		return issue ? [{ connector, issue }] : [];
	});
	const proposalsFailed = !proposals.loading && proposals.data === null;
	const count = sourceIssues.length + connectorIssues.length + suggestions.length + (proposalsFailed ? 1 : 0);
	if (count === 0) return null;

	return (
		<section className="home-attention" aria-labelledby="home-attention-title">
			<SectionHeading
				id="home-attention-title"
				title="Needs attention"
				meta={<span className="text-meta tabular-nums text-muted-foreground">{count}</span>}
			/>
			<ul className="home-attention-list">
				{sourceIssues.map((source) => (
					<AttentionItem
						key={source.id}
						tone={source.health?.status === "unhealthy" ? "error" : "warn"}
						action="Details"
						onAction={() => onShowSource(source.id)}
					>
						{source.name} is {source.health?.status}
					</AttentionItem>
				))}
				{connectorIssues.map(({ connector, issue }) => (
					<AttentionItem key={connector.id} tone={issue.tone} action="Fix" onAction={() => openSettings("connectors")}>
						{connector.displayName}: {issue.label.toLowerCase()}
					</AttentionItem>
				))}
				{proposalsFailed && (
					<AttentionItem tone="neutral" action="Retry" onAction={() => void proposals.refresh()}>
						Review suggestions could not be loaded
					</AttentionItem>
				)}
			</ul>
			{suggestions.length > 0 && (
				<div className="home-attention-suggestions">
					<h3 id="review-suggestions-title" className="m-0 text-small font-medium text-muted-foreground">
						Suggestions from dreaming · {suggestions.length}
					</h3>
					<div className="flex flex-col">
						{suggestions.map((proposal, index) => (
							<ReviewProposalRow
								key={proposal.id}
								proposal={proposal}
								last={index === suggestions.length - 1}
								onSettled={proposals.refresh}
							/>
						))}
					</div>
				</div>
			)}
		</section>
	);
}

function AttentionItem({
	tone,
	action,
	onAction,
	children,
}: {
	tone: StatusTone;
	action: string;
	onAction: () => void;
	children: ReactNode;
}) {
	return (
		<li className="home-attention-item">
			<span className="dashboard-status" data-tone={tone}>
				<span className="dashboard-status-dot" aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1 text-body">{children}</span>
			<SectionAction onClick={onAction}>{action}</SectionAction>
		</li>
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

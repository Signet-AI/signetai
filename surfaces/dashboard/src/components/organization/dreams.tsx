import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { PageHeading } from "@/components/dashboard/heading";
import { Panel } from "@/components/shell/panel";
import { MarkdownSummary } from "@/components/dreams/summary";
import { usePanelQuery } from "@/lib/use-panel-query";
import { useAgentContext } from "@/lib/agent-context";
import type { DreamPass, DreamToolCall } from "@/lib/api";
import { ClassificationBadges, type ClassificationLabel } from "@/components/shell/attribution";
import type { OrganizationAgent } from "@/lib/organization";
import { Action, Choice, OrganizationBlock, displayLabel } from "./controls";
import { EvidenceList } from "./evidence-list";
import { AuthorFilter, FilterSearch, FilterToolbar } from "./filters";
import { OrganizationResource } from "@/views/organization";

interface ReviewedPass extends DreamPass {
	readonly author?: { readonly kind: string; readonly name: string };
	readonly team?: { readonly id: string; readonly name: string } | null;
	readonly classifications?: readonly ClassificationLabel[];
}

function EvidenceValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
	if (depth > 5) return <span className="text-muted-foreground">Further details omitted.</span>;
	if (typeof value === "string" || typeof value === "number")
		return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
	if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
	if (Array.isArray(value))
		return (
			<div className="space-y-2">
				{value.slice(0, 20).map((item) => (
					<div key={JSON.stringify(item)}>
						<EvidenceValue value={item} depth={depth + 1} />
					</div>
				))}
			</div>
		);
	if (value && typeof value === "object")
		return (
			<dl className="space-y-2">
				{Object.entries(value)
					.slice(0, 30)
					.map(([key, item]) => (
						<div key={key}>
							<dt className="text-xs text-muted-foreground">{displayLabel(key)}</dt>
							<dd>
								<EvidenceValue value={item} depth={depth + 1} />
							</dd>
						</div>
					))}
			</dl>
		);
	return <span className="text-muted-foreground">Not recorded</span>;
}
export function OrganizationDreams() {
	const agentId = useAgentContext();
	const [query, setQuery] = useState("");
	const [author, setAuthor] = useState("");
	const [team, setTeam] = useState("");
	const [classification, setClassification] = useState("");
	const [selected, setSelected] = useState<ReviewedPass | null>(null);
	useEffect(() => {
		if (agentId) setSelected(null);
	}, [agentId]);
	const status = usePanelQuery<{ passes: readonly ReviewedPass[] }>(
		`/api/dream/status?agentId=${encodeURIComponent(agentId ?? "default")}`,
	);
	const agents = usePanelQuery<{ agents: readonly OrganizationAgent[] }>("/api/agents");
	const passes = status.result?.data?.passes ?? [];
	const authors = Array.from(
		new Map(passes.flatMap((pass) => (pass.author ? [[pass.author.kind, pass.author.name] as const] : []))).entries(),
	);
	const teams = Array.from(
		new Map(passes.flatMap((pass) => (pass.team ? [[pass.team.id, pass.team.name] as const] : []))).entries(),
	);
	const labels = Array.from(
		new Map(
			passes.flatMap((pass) => (pass.classifications ?? []).map((label) => [label.id, label.name] as const)),
		).entries(),
	);
	const agent = agents.result?.data?.agents.find((item) => item.id === agentId);
	const rows = (status.result?.data?.passes ?? []).filter(
		(pass) =>
			(pass.summary ?? pass.mode).toLowerCase().includes(query.toLowerCase()) &&
			(!author || pass.author?.kind === author) &&
			(!team || pass.team?.id === team) &&
			(!classification || pass.classifications?.some((label) => label.id === classification)),
	);
	return (
		<div className="dreams-page">
			<div className="dreams-content">
				<PageHeading title="Dreams" description="Passes for the selected agent." />
				<OrganizationBlock title="Passes">
					<FilterToolbar>
						<FilterSearch label="Search passes" value={query} onChange={setQuery} />
						<AuthorFilter
							value={author}
							onChange={setAuthor}
							options={[{ value: "", label: "All authors" }, ...authors.map(([value, label]) => ({ value, label }))]}
						/>
						<Choice
							inline
							label="Team"
							value={team}
							onChange={setTeam}
							options={[{ value: "", label: "All teams" }, ...teams.map(([value, label]) => ({ value, label }))]}
						/>
						<Choice
							inline
							label="Classification"
							value={classification}
							onChange={setClassification}
							options={[
								{ value: "", label: "All classifications" },
								...labels.map(([value, label]) => ({ value, label })),
							]}
						/>
					</FilterToolbar>
					{status.result?.data && (
						<p role="status" className="text-meta text-muted-foreground">
							{rows.length} {rows.length === 1 ? "pass" : "passes"}
						</p>
					)}
					<Panel
						result={status.result}
						empty={!rows.length}
						emptyMessage="No passes match these filters."
						onRetry={status.refresh}
					>
						{() => (
							<EvidenceList
								rows={rows.map((pass) => ({
									key: pass.id,
									title: `${displayLabel(pass.mode)} pass`,
									identifier: pass.id,
									kind: "dream",
									author: pass.author?.name,
									team: pass.team?.name ?? (pass.team === null ? "No team" : "Not recorded"),
									badges: (
										<>
											<Badge>{displayLabel(pass.status)}</Badge>
											{pass.classifications?.length ? (
												<ClassificationBadges
													classifications={pass.classifications}
													audienceIds={new Set(pass.classifications.map((label) => label.id))}
												/>
											) : null}
										</>
									),
									agent: agentId === "default" ? "Organization scope" : (agent?.name ?? "Selected scope"),
									onOpen: () => setSelected(pass),
								}))}
							/>
						)}
					</Panel>
				</OrganizationBlock>
				{selected && (
					<OrganizationBlock title={`${displayLabel(selected.mode)} pass`}>
						<p className="text-xs text-muted-foreground">{selected.id}</p>
						{selected.summary && <MarkdownSummary text={selected.summary} />}
						<OrganizationResource<{ items: readonly DreamToolCall[] }>
							path={`/api/dream/passes/${encodeURIComponent(selected.id)}/tools?agentId=${encodeURIComponent(agentId ?? "default")}`}
							empty={(data) => !data.items.length}
						>
							{(data) => (
								<ul className="m-0 list-none divide-y p-0">
									{data.items.map((tool) => (
										<li key={tool.id} className="py-3">
											<p className="text-small font-medium">{displayLabel(tool.toolName)}</p>
											<div className="whitespace-pre-wrap break-words text-small">
												<EvidenceValue value={tool.output ?? tool.input} />
											</div>
										</li>
									))}
								</ul>
							)}
						</OrganizationResource>
						<Action secondary onClick={() => setSelected(null)}>
							Close pass
						</Action>
					</OrganizationBlock>
				)}
			</div>
		</div>
	);
}

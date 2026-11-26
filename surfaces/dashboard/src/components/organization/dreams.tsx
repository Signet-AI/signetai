import { useState } from "react";
import { PageHeading } from "@/components/dashboard/heading";
import { Panel } from "@/components/shell/panel";
import { MarkdownSummary } from "@/components/dreams/summary";
import { usePanelQuery } from "@/lib/use-panel-query";
import { useAgentContext } from "@/lib/agent-context";
import type { DreamPass, DreamToolCall } from "@/lib/api";
import type { OrganizationAgent, OrganizationGroup } from "@/lib/organization";
import { Action, Choice, OrganizationBlock, TextField, displayLabel } from "./controls";
import { EvidenceList } from "./evidence-list";
import { OrganizationResource } from "@/views/organization";

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
	const [selected, setSelected] = useState<DreamPass | null>(null);
	const status = usePanelQuery<{ passes: readonly DreamPass[] }>(
		`/api/dream/status?agentId=${encodeURIComponent(agentId ?? "default")}`,
	);
	const agents = usePanelQuery<{ agents: readonly OrganizationAgent[] }>("/api/agents");
	const groups = usePanelQuery<{ groups: readonly OrganizationGroup[] }>("/api/org/groups");
	const agent = agents.result?.data?.agents.find((item) => item.id === agentId);
	const rows = (status.result?.data?.passes ?? []).filter(
		(pass) =>
			(pass.summary ?? pass.mode).toLowerCase().includes(query.toLowerCase()) &&
			(!team || agent?.ownerGroupId === team),
	);
	return (
		<div className="dreams-page">
			<div className="dreams-content">
				<PageHeading title="Dreams" description="Audience-scoped passes for the selected agent." />
				<OrganizationBlock title="Passes">
					<TextField label="Search passes" value={query} onChange={setQuery} />
					<Choice
						label="Author"
						value={author}
						onChange={setAuthor}
						options={[
							{ value: "", label: "All authors" },
							{ value: "dreaming", label: "Dreaming" },
						]}
					/>
					<Choice
						label="Team"
						value={team}
						onChange={setTeam}
						options={[
							{ value: "", label: "All teams" },
							...(groups.result?.data?.groups ?? []).map((group) => ({ value: group.id, label: group.name })),
						]}
					/>
					<p className="settings-row-description">
						Dreaming authors every pass. Classification access is enforced by the instance; per-pass classification
						labels are not exposed by this API.
					</p>
					<Panel
						result={status.result}
						empty={!rows.length}
						emptyMessage="No readable passes match these filters."
						onRetry={status.refresh}
					>
						{() => (
							<EvidenceList
								rows={rows.map((pass) => ({
									key: pass.id,
									title: `${displayLabel(pass.mode)} pass — ${displayLabel(pass.status)}`,
									identifier: pass.id,
									kind: "dream",
									author: "Dreaming",
									agent: agent?.name ?? "Selected agent",
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

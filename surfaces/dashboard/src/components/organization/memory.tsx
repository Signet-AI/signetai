import { useEffect, useState } from "react";
import { usePanelQuery } from "@/lib/use-panel-query";
import { useAgentContext } from "@/lib/agent-context";
import { useWhoami } from "@/lib/session";
import { Panel } from "@/components/shell/panel";
import { ClassificationBadges, type ClassificationLabel } from "@/components/shell/attribution";
import type { OrganizationAgent, OrganizationClassification, OrganizationGroup } from "@/lib/organization";
import { Action, Choice, OrganizationBlock, TextField, agentDisplayName } from "./controls";
import { EvidenceList } from "./evidence-list";
import { ClassifyAction } from "./classifications";
import { UserLookup, type LookupPerson } from "./user-lookup";

interface MemoryRow {
	readonly id: string;
	readonly content: string;
	readonly authorUserId?: string;
	readonly agent_id: string;
	readonly type?: string;
	readonly classifications?: readonly ClassificationLabel[];
}
export function OrganizationMemory() {
	const whoami = useWhoami();
	const agentId = useAgentContext();
	const [offset, setOffset] = useState(0),
		[query, setQuery] = useState(""),
		[author, setAuthor] = useState(""),
		[team, setTeam] = useState(""),
		[classification, setClassification] = useState("");
	const [person, setPerson] = useState<LookupPerson | null>(null);
	const [selected, setSelected] = useState<MemoryRow | null>(null);
	useEffect(() => {
		if (agentId) {
			setOffset(0);
			setSelected(null);
		}
	}, [agentId]);
	const params = new URLSearchParams({
		limit: "100",
		offset: String(offset),
		agentId: agentId ?? whoami?.agents.defaultRead ?? "",
	});
	for (const [key, value] of Object.entries({ author, team, classification })) if (value) params.set(key, value);
	const memories = usePanelQuery<{ memories: readonly MemoryRow[]; stats: { readonly total: number } }>(
		whoami ? `/api/memories?${params}` : null,
	);
	const agents = usePanelQuery<{ agents: readonly OrganizationAgent[] }>(whoami ? "/api/agents" : null);
	const groups = usePanelQuery<{ groups: readonly OrganizationGroup[] }>(whoami ? "/api/org/groups" : null);
	const definitions = usePanelQuery<readonly OrganizationClassification[]>(whoami ? "/api/classifications" : null);
	if (!whoami) return null;
	const change = (setter: (value: string) => void) => (value: string) => {
		setter(value);
		setOffset(0);
		setSelected(null);
	};
	const rows = memories.result?.data?.memories ?? [];
	const visible = rows.filter((row) => row.content.toLowerCase().includes(query.toLowerCase()));
	const personName = (id: string) =>
		id === whoami.user.id ? whoami.user.displayName : person?.id === id ? person.displayName : "Another person";
	const audienceIds = new Set(
		(definitions.result?.data ?? [])
			.filter((definition) =>
				definition.audience?.some((principal) =>
					principal.kind === "user"
						? principal.id === whoami.user.id
						: whoami.user.groups.some((group) => group.id === principal.id),
				),
			)
			.map((definition) => definition.id),
	);
	const authorOptions = Array.from(
		new Set([
			whoami.user.id,
			...rows.flatMap((row) => (row.authorUserId ? [row.authorUserId] : [])),
			...(person ? [person.id] : []),
		]),
	).map((id) => ({ value: id, label: personName(id) }));
	return (
		<OrganizationBlock title="Memory">
			<div className="flex flex-col gap-3">
				<TextField label="Search this page" value={query} onChange={setQuery} />
				{(whoami.user.role === "admin" || whoami.user.compliance) && (
					<UserLookup
						label="Find an author"
						onSelect={(value) => {
							setPerson(value);
							change(setAuthor)(value.id);
						}}
					/>
				)}
				<Choice
					label="Author"
					value={author}
					onChange={change(setAuthor)}
					options={[{ value: "", label: "All authors" }, ...authorOptions]}
				/>
				<Choice
					label="Team"
					value={team}
					onChange={change(setTeam)}
					options={[
						{ value: "", label: "All teams" },
						...(groups.result?.data?.groups ?? []).map((group) => ({ value: group.id, label: group.name })),
					]}
				/>
				<Choice
					label="Classification"
					value={classification}
					onChange={change(setClassification)}
					options={[
						{ value: "", label: "All readable memory" },
						...(definitions.result?.data ?? [])
							.filter((definition) => audienceIds.has(definition.id))
							.map((definition) => ({ value: definition.id, label: definition.name })),
					]}
				/>
			</div>
			<p className="settings-row-description">
				Author, team, and classification filters apply across readable memory before pagination. Text search narrows
				this page only.
			</p>
			<Panel result={memories.result} onRetry={memories.refresh}>
				{(data) => (
					<p role="status" className="settings-row-description">
						{data.stats.total} corpus matches
					</p>
				)}
			</Panel>
			<Panel
				result={memories.result}
				empty={!visible.length}
				emptyMessage={
					query ? "No memory on this page matches the text search." : "No readable memory matches these filters."
				}
				onRetry={memories.refresh}
			>
				{() => (
					<EvidenceList
						rows={visible.map((row) => ({
							key: row.id,
							title: row.content.slice(0, 180),
							kind: row.type ?? "memory",
							agent: agentDisplayName(agents.result?.data?.agents.find((agent) => agent.id === row.agent_id)),
							author: row.authorUserId ? personName(row.authorUserId) : undefined,
							badges: row.classifications?.length ? (
								<ClassificationBadges
									classifications={row.classifications}
									audienceIds={new Set(row.classifications.map((label) => label.id))}
								/>
							) : undefined,
							onOpen: () => setSelected(row),
						}))}
					/>
				)}
			</Panel>
			<div className="flex gap-2">
				<Action
					secondary
					disabled={!offset}
					onClick={() => {
						setOffset(Math.max(0, offset - 100));
						setSelected(null);
					}}
				>
					Previous page
				</Action>
				<Action
					secondary
					disabled={offset + 100 >= (memories.result?.data?.stats.total ?? 0)}
					onClick={() => {
						setOffset(offset + 100);
						setSelected(null);
					}}
				>
					Next page
				</Action>
			</div>
			{selected && (
				<OrganizationBlock title="Memory detail">
					<p className="whitespace-pre-wrap break-words text-small">{selected.content}</p>
					<ClassifyAction target={{ kind: "memory", id: selected.id, agentId: selected.agent_id }} />
					<Action secondary onClick={() => setSelected(null)}>
						Close memory
					</Action>
				</OrganizationBlock>
			)}
		</OrganizationBlock>
	);
}

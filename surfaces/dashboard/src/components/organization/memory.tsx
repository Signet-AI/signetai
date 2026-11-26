import { useState } from "react";
import { usePanelQuery } from "@/lib/use-panel-query";
import { useAgentContext } from "@/lib/agent-context";
import { useWhoami } from "@/lib/session";
import { Panel } from "@/components/shell/panel";
import { ClassificationBadges } from "@/components/shell/attribution";
import type {
	OrganizationAgent,
	OrganizationClassification,
	OrganizationGroup,
	OrganizationUserRow,
} from "@/lib/organization";
import { Action, Choice, OrganizationBlock, TextField, agentDisplayName } from "./controls";
import { EvidenceList } from "./evidence-list";
import { ClassifyAction } from "./classifications";

interface MemoryRow {
	readonly id: string;
	readonly content: string;
	readonly authorUserId?: string;
	readonly agent_id: string;
	readonly type?: string;
}
interface AssignmentPage {
	readonly items: readonly {
		target_kind: string;
		target_id: string;
		agent_id: string;
		memory?: { id: string; content: string } | null;
	}[];
	readonly nextCursor: string | null;
}
export function OrganizationMemory() {
	const whoami = useWhoami();
	const agentId = useAgentContext();
	const [offset, setOffset] = useState(0);
	const [query, setQuery] = useState("");
	const [author, setAuthor] = useState("");
	const [team, setTeam] = useState("");
	const [classification, setClassification] = useState("");
	const [cursor, setCursor] = useState("");
	const [history, setHistory] = useState<readonly string[]>([]);
	const [selected, setSelected] = useState<MemoryRow | null>(null);
	const memories = usePanelQuery<{ memories: readonly MemoryRow[]; total: number }>(
		whoami
			? `/api/memories?limit=100&offset=${offset}&agentId=${encodeURIComponent(agentId ?? whoami.agents.defaultRead)}`
			: null,
	);
	const agents = usePanelQuery<{ agents: readonly OrganizationAgent[] }>(whoami ? "/api/agents" : null);
	const groups = usePanelQuery<{ groups: readonly OrganizationGroup[] }>(whoami ? "/api/org/groups" : null);
	const people = usePanelQuery<{ users: readonly OrganizationUserRow[] }>(
		whoami?.user.role === "admin" ? "/api/org/users" : null,
	);
	const definitions = usePanelQuery<readonly OrganizationClassification[]>(whoami ? "/api/classifications" : null);
	const assignments = usePanelQuery<AssignmentPage>(
		classification
			? `/api/classifications/${encodeURIComponent(classification)}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
			: null,
	);
	if (!whoami) return null;
	const audienceIds = new Set(
		(definitions.result?.data ?? [])
			.filter(
				(definition) =>
					!whoami.user.compliance ||
					definition.audience?.some((principal) =>
						principal.kind === "user"
							? principal.id === whoami.user.id
							: whoami.user.groups.some((group) => group.id === principal.id),
					),
			)
			.map((definition) => definition.id),
	);
	const rows: readonly MemoryRow[] = classification
		? (assignments.result?.data?.items ?? []).flatMap((item) =>
				item.target_kind === "memory" && item.memory ? [{ ...item.memory, agent_id: item.agent_id }] : [],
			)
		: (memories.result?.data?.memories ?? []);
	const filtered = rows.filter(
		(row) =>
			row.content.toLowerCase().includes(query.toLowerCase()) &&
			(!author || row.authorUserId === author) &&
			(!team || agents.result?.data?.agents.some((agent) => agent.id === row.agent_id && agent.ownerGroupId === team)),
	);
	const result = classification ? assignments.result : memories.result;
	const personName = (id: string) =>
		id === whoami.user.id
			? whoami.user.displayName
			: (people.result?.data?.users.find((person) => person.id === id)?.display_name ?? "Another person");
	return (
		<OrganizationBlock title="Memory">
			<div className="flex flex-col gap-3">
				<TextField label="Search this page" value={query} onChange={setQuery} />
				<Choice
					label="Author"
					value={author}
					onChange={setAuthor}
					options={[
						{ value: "", label: "All authors" },
						...Array.from(new Set(rows.flatMap((row) => (row.authorUserId ? [row.authorUserId] : [])))).map((id) => ({
							value: id,
							label: personName(id),
						})),
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
				<Choice
					label="Classification"
					value={classification}
					onChange={(value) => {
						setClassification(value);
						setCursor("");
						setHistory([]);
						setSelected(null);
					}}
					options={[
						{ value: "", label: "All readable memory" },
						...(definitions.result?.data ?? [])
							.filter((definition) => audienceIds.has(definition.id))
							.map((definition) => ({ value: definition.id, label: definition.name })),
					]}
				/>
			</div>
			<p className="settings-row-description">
				Author, team, and text filters apply to the current page. Classification results use the daemon's
				audience-scoped material pages.
			</p>
			<Panel<unknown>
				result={result}
				empty={filtered.length === 0}
				emptyMessage="No readable memory matches these filters."
				onRetry={classification ? assignments.refresh : memories.refresh}
			>
				{() => (
					<EvidenceList
						rows={filtered.map((row) => ({
							key: row.id,
							title: row.content.slice(0, 180),
							kind: row.type ?? "memory",
							agent: agentDisplayName(agents.result?.data?.agents.find((agent) => agent.id === row.agent_id)),
							author: row.authorUserId ? personName(row.authorUserId) : undefined,
							badges: classification ? (
								<ClassificationBadges
									classifications={(definitions.result?.data ?? []).filter(
										(definition) => definition.id === classification,
									)}
									audienceIds={audienceIds}
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
					disabled={classification ? !history.length : offset === 0}
					onClick={() => {
						if (classification) {
							setCursor(history.at(-1) ?? "");
							setHistory(history.slice(0, -1));
						} else setOffset(Math.max(0, offset - 100));
					}}
				>
					Previous page
				</Action>
				<Action
					secondary
					disabled={
						classification ? !assignments.result?.data?.nextCursor : offset + 100 >= (memories.result?.data?.total ?? 0)
					}
					onClick={() => {
						if (classification) {
							const next = assignments.result?.data?.nextCursor;
							if (next) {
								setHistory([...history, cursor]);
								setCursor(next);
							}
						} else setOffset(offset + 100);
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

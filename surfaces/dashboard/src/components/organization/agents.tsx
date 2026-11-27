import { useState } from "react";
import { displayLabel, agentDisplayName } from "./controls";
import { getJSONResult } from "@/lib/api";
import type { OrganizationAgent, OrganizationGroup, OrganizationUser } from "@/lib/organization";
import {
	Action,
	Choice,
	Message,
	OrganizationBlock,
	OrganizationTable,
	TextField,
	cellClass,
	rowClass,
} from "./controls";
import { ClassifyAction } from "./classifications";

export function AgentsContent({
	agents,
	groups,
	users,
	refresh,
}: {
	agents: readonly OrganizationAgent[];
	groups: readonly OrganizationGroup[];
	users: readonly OrganizationUser[];
	refresh: () => void;
}) {
	const [selected, setSelected] = useState<OrganizationAgent | null>(null);
	const [name, setName] = useState("");
	const [groupId, setGroupId] = useState("");
	const [newOwner, setNewOwner] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const save = async (agent: OrganizationAgent | null, archive = false) => {
		setBusy(true);
		const result = await getJSONResult(agent ? `/api/agents/${encodeURIComponent(agent.id)}` : "/api/agents", {
			method: agent ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				agent
					? archive
						? { archived: true }
						: agent.kind === "team"
							? { ownerGroupId: newOwner }
							: { ownerUserId: newOwner }
					: { name, kind: "team", ownerGroupId: groupId },
			),
		});
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setSelected(null);
			setName("");
			refresh();
		}
	};
	const owner = (agent: OrganizationAgent) =>
		agent.kind === "organization"
			? "Organization"
			: (users.find((user) => user.id === agent.ownerUserId)?.displayName ??
				groups.find((group) => group.id === agent.ownerGroupId)?.name ??
				(agent.ownerUserId ? "Person" : agent.ownerGroupId ? "Team" : "Unassigned"));
	const writeAccess = (agent: OrganizationAgent) =>
		agent.archivedAt
			? "Nobody"
			: agent.kind === "organization"
				? agent.id === "default"
					? "Every active user"
					: "Administrator · explicit target only"
				: agent.kind === "team"
					? "Team members"
					: agent.kind === "personal"
						? "Owner only"
						: "Administrators";
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock title="Organization agents">
				<div className="hidden md:block">
					<OrganizationTable columns={["Agent", "Kind", "Owner", "Who may act as it", "Actions"]}>
						{agents.map((agent) => (
							<tr key={agent.id} className={rowClass}>
								<td className={cellClass}>
									<Action
										secondary
										onClick={() => {
											setSelected(agent);
											setNewOwner("");
										}}
									>
										{agentDisplayName(agent)}
									</Action>
								</td>
								<td className={cellClass}>
									{displayLabel(agent.kind)}
									{agent.archivedAt ? " · archived" : ""}
								</td>
								<td className={cellClass}>{owner(agent)}</td>
								<td className={cellClass}>{writeAccess(agent)}</td>
								<td className={cellClass}>
									{!agent.archivedAt && agent.id !== "default" && (
										<Action
											secondary
											disabled={busy}
											onClick={() => {
												setSelected(agent);
												setNewOwner("");
											}}
										>
											Manage…
										</Action>
									)}
								</td>
							</tr>
						))}
					</OrganizationTable>
				</div>
				<div className="flex min-w-0 flex-col gap-3 md:hidden">
					{agents.map((agent) => (
						<article
							key={agent.id}
							aria-label={agentDisplayName(agent)}
							className="flex min-w-0 flex-col gap-3 rounded-lg border p-4 text-small"
						>
							<h3 className="break-words font-medium">{agentDisplayName(agent)}</h3>
							<dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
								<dt className="text-muted-foreground">Owner</dt>
								<dd className="break-words">{owner(agent)}</dd>
								<dt className="text-muted-foreground">Write access</dt>
								<dd className="break-words">{writeAccess(agent)}</dd>
								<dt className="text-muted-foreground">Kind</dt>
								<dd>
									{displayLabel(agent.kind)}
									{agent.archivedAt ? " · archived" : ""}
								</dd>
							</dl>
							<Action
								secondary
								disabled={busy}
								onClick={() => {
									setSelected(agent);
									setNewOwner("");
								}}
							>
								View agent
							</Action>
						</article>
					))}
				</div>
			</OrganizationBlock>
			{selected && (
				<OrganizationBlock
					title={agentDisplayName(selected)}
					description={`Owner: ${owner(selected)}. ${selected.canActAs ? "You may act as this agent." : "You cannot act as this agent."}`}
				>
					<ClassifyAction target={{ kind: "agent", id: selected.id, agentId: selected.id }} />
					{selected.kind !== "organization" && !selected.archivedAt && (
						<>
							<Choice
								label="Transfer ownership to"
								value={newOwner}
								onChange={setNewOwner}
								options={[
									{ value: "", label: "Select new owner" },
									...(selected.kind === "team"
										? groups.map((group) => ({ value: group.id, label: group.name }))
										: users
												.filter((user) => user.status === "active")
												.map((user) => ({ value: user.id, label: user.displayName }))),
								]}
							/>
							<Action disabled={busy || !newOwner} onClick={() => void save(selected)}>
								Transfer ownership
							</Action>
							<Action
								secondary
								disabled={busy}
								onClick={() => {
									if (window.confirm(`Archive ${selected.name}? Nobody will be able to act as this agent.`))
										void save(selected, true);
								}}
							>
								Archive agent
							</Action>
						</>
					)}
					<Action secondary onClick={() => setSelected(null)}>
						Close agent
					</Action>
				</OrganizationBlock>
			)}
			<OrganizationBlock
				title="Create a team or shared agent"
				description="A shared agent belongs to a team. Its keys are issued separately with explicit permissions and expiry."
			>
				<TextField label="Agent name" value={name} onChange={setName} />
				<Choice
					label="Owner team"
					value={groupId}
					onChange={setGroupId}
					options={[
						{ value: "", label: "Select owner team" },
						...groups.map((group) => ({ value: group.id, label: group.name })),
					]}
				/>
				<Action disabled={busy || !name.trim() || !groupId} onClick={() => void save(null)}>
					Create agent
				</Action>
			</OrganizationBlock>
			<Message error={error} />
		</div>
	);
}

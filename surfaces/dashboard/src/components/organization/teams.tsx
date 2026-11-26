import { useState } from "react";
import { displayLabel } from "./controls";
import { getJSONResult } from "@/lib/api";
import type {
	OrganizationAgent,
	OrganizationClassification,
	OrganizationGroup,
	OrganizationMember,
} from "@/lib/organization";
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

export function SharedKeyForm({
	agents,
	permissions,
}: {
	agents: readonly OrganizationAgent[];
	permissions: readonly string[];
}) {
	const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
	const [name, setName] = useState("");
	const [expiresAt, setExpiresAt] = useState("");
	const [scope, setScope] = useState<readonly string[]>(["recall"].filter((value) => permissions.includes(value)));
	const [secret, setSecret] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const issue = async () => {
		setBusy(true);
		setSecret(null);
		const result = await getJSONResult<{ secret: string }>("/api/auth/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				kind: "shared",
				name,
				agentId,
				permissions: scope,
				expiresAt: new Date(expiresAt).toISOString(),
			}),
		});
		setBusy(false);
		setError(result.error);
		setSecret(result.data?.secret ?? null);
	};
	return (
		<OrganizationBlock
			title="Issue a shared-agent key"
			description="For bots and CI. Only administrators and team owners can issue these keys."
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField label="Key name" value={name} onChange={setName} />
				<Choice
					label="Shared agent"
					value={agentId}
					onChange={setAgentId}
					options={[
						{ value: "", label: "Select an agent" },
						...agents.map((agent) => ({ value: agent.id, label: agent.name })),
					]}
				/>
				<TextField label="Key expiry" type="datetime-local" value={expiresAt} onChange={setExpiresAt} />
			</div>
			<fieldset className="flex flex-wrap gap-3">
				<legend className="text-small">Permissions</legend>
				{permissions.map((permission) => (
					<label key={permission} className="flex items-center gap-2 text-small">
						<input
							type="checkbox"
							checked={scope.includes(permission)}
							onChange={(event) =>
								setScope(event.target.checked ? [...scope, permission] : scope.filter((value) => value !== permission))
							}
						/>
						{permission}
					</label>
				))}
			</fieldset>
			<Action
				disabled={busy || !name.trim() || !agentId || !expiresAt || scope.length === 0}
				onClick={() => void issue()}
			>
				Issue key
			</Action>
			<Message error={error} />
			{secret && (
				<div role="status" className="flex flex-col gap-2">
					<p>Copy this key now. It will not be shown again.</p>
					<code className="break-all select-all">{secret}</code>
					<Action
						secondary
						onClick={() => {
							void navigator.clipboard.writeText(secret).catch(() => setError("Copy failed. Select the key manually."));
						}}
					>
						Copy key
					</Action>
					<Action secondary onClick={() => setSecret(null)}>
						Done
					</Action>
				</div>
			)}
		</OrganizationBlock>
	);
}

export function TeamDirectory({
	groups,
	onSelect,
}: {
	groups: readonly OrganizationGroup[];
	onSelect: (id: string) => void;
}) {
	return (
		<OrganizationBlock title="Team directory">
			<OrganizationTable columns={["Team", "Description", "Membership"]}>
				{groups.map((group) => (
					<tr key={group.id} className={rowClass}>
						<td className={cellClass}>
							<Action secondary onClick={() => onSelect(group.id)}>
								{group.name}
							</Action>
						</td>
						<td className={cellClass}>{group.description ?? "—"}</td>
						<td className={cellClass}>
							{group.managed_by === "idp" ? "Managed by your identity provider" : "Managed in Signet"}
						</td>
					</tr>
				))}
			</OrganizationTable>
		</OrganizationBlock>
	);
}
export function TeamContent({
	group,
	agents,
	classifications,
	canManage,
	admin,
	permissions,
	refresh,
}: {
	group: OrganizationGroup & { readonly members: readonly OrganizationMember[] };
	agents: readonly OrganizationAgent[];
	classifications: readonly OrganizationClassification[];
	canManage: boolean;
	admin: boolean;
	permissions: readonly string[];
	refresh: () => void;
}) {
	const [userId, setUserId] = useState("");
	const [role, setRole] = useState("member");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const editable = canManage && group.managed_by !== "idp";
	const member = async (id: string, add: boolean) => {
		setBusy(true);
		const result = await getJSONResult(
			`/api/org/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(id)}`,
			{
				method: add ? "PUT" : "DELETE",
				headers: { "Content-Type": "application/json" },
				body: add ? JSON.stringify({ role }) : undefined,
			},
		);
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setUserId("");
			refresh();
		}
	};
	const teamAgents = agents.filter((agent) => agent.ownerGroupId === group.id);
	const owned = classifications.filter((classification) =>
		classification.audience?.some((principal) => principal.kind === "group" && principal.id === group.id),
	);
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock title={group.name} description={group.description ?? undefined}>
				{group.managed_by === "idp" && (
					<p className="settings-row-description">
						Membership is managed by your identity provider. Manual changes are unavailable.
					</p>
				)}
				<OrganizationTable columns={["Person", "Role", "Actions"]}>
					{group.members.map((item) => (
						<tr key={item.id} className={rowClass}>
							<td className={cellClass}>
								{item.display_name} · {item.username}
							</td>
							<td className={cellClass}>{displayLabel(item.role)}</td>
							<td className={cellClass}>
								{editable && (
									<Action secondary disabled={busy} onClick={() => void member(item.id, false)}>
										Remove
									</Action>
								)}
							</td>
						</tr>
					))}
				</OrganizationTable>
				{editable && (
					<>
						<div className="grid gap-3 sm:grid-cols-2">
							<TextField label="User ID" value={userId} onChange={setUserId} />
							<Choice
								label="Membership role"
								value={role}
								onChange={setRole}
								options={[
									{ value: "member", label: "Member" },
									{ value: "owner", label: "Owner" },
								]}
							/>
						</div>
						<Action disabled={busy || !userId.trim()} onClick={() => void member(userId, true)}>
							Add member
						</Action>
					</>
				)}
				<Message error={error} />
			</OrganizationBlock>
			<OrganizationBlock title="Team agents">
				<ul className="text-small">
					{teamAgents.map((agent) => (
						<li key={agent.id}>
							{agent.name} ·{" "}
							{agent.archivedAt
								? "Archived"
								: agent.canActAs
									? "You may act as this agent"
									: "Team members may act as this agent"}
						</li>
					))}
				</ul>
			</OrganizationBlock>
			{canManage && (
				<SharedKeyForm agents={teamAgents.filter((agent) => !agent.archivedAt)} permissions={permissions} />
			)}
			<OrganizationBlock title="Team classifications">
				<ul className="text-small">
					{owned.map((classification) => (
						<li key={classification.id}>{classification.name}</li>
					))}
				</ul>
				{!owned.length && <p className="settings-row-description">No team audience definitions are available.</p>}
			</OrganizationBlock>
			{admin && (
				<p className="settings-row-description">
					Identity-provider group mappings are configured in Organization → Authentication.
				</p>
			)}
		</div>
	);
}
export function CreateTeam({ refresh }: { refresh: () => void }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const create = async () => {
		setBusy(true);
		const result = await getJSONResult("/api/org/groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, description }),
		});
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setName("");
			setDescription("");
			refresh();
		}
	};
	return (
		<OrganizationBlock title="Create a team">
			<TextField label="Team name" value={name} onChange={setName} />
			<TextField label="Team description" value={description} onChange={setDescription} />
			<Action disabled={busy || !name.trim()} onClick={() => void create()}>
				Create team
			</Action>
			<Message error={error} />
		</OrganizationBlock>
	);
}

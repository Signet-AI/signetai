import { type ReactNode, useEffect, useRef, useState } from "react";
import { OrganizationUpgrade } from "@/components/organization/upgrade";
import { AgentsContent } from "@/components/organization/agents";
import { AuthenticationContent } from "@/components/organization/authentication";
import { ClassificationsContent } from "@/components/organization/classifications";
import { Action, Choice, TextField, displayLabel } from "@/components/organization/controls";
import { type AuditPage, AuditContent, HealthContent, KeysContent } from "@/components/organization/operations";
import { CreateTeam, TeamContent, TeamDirectory } from "@/components/organization/teams";
import { AccessContent, type EffectiveAccess, RolesMatrix, UsersContent } from "@/components/organization/users";
import { Panel } from "@/components/shell/panel";
import {
	ORGANIZATION_ROLES,
	type OrganizationAgent,
	type OrganizationClassification,
	type OrganizationGroup,
	type OrganizationKey,
	type OrganizationMember,
	type OrganizationSettings,
	type OrganizationUserRow,
	organizationUser,
} from "@/lib/organization";
import { UserLookup } from "@/components/organization/user-lookup";
import { useSession, useWhoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";
import { useAgentContext } from "@/lib/agent-context";

export const ORGANIZATION_NAV = [
	{ id: "teams", label: "My teams", group: "Teams" },
	{ id: "users", label: "Users", group: "Organization" },
	{ id: "org-teams", label: "Teams", group: "Organization" },
	{ id: "org-agents", label: "Agents", group: "Organization" },
	{ id: "roles", label: "Roles and permissions", group: "Organization" },
	{ id: "access", label: "Effective access", group: "Organization" },
	{ id: "org-keys", label: "All API keys", group: "Organization" },
	{ id: "authentication", label: "Authentication", group: "Organization" },
	{ id: "audit", label: "Audit log", group: "Organization" },
	{ id: "health", label: "Instance health", group: "Organization" },
	{ id: "classifications", label: "Classifications", group: "Compliance" },
] as const;
export type OrganizationSectionId = (typeof ORGANIZATION_NAV)[number]["id"];

export function OrganizationResource<T>({
	path,
	empty,
	children,
}: {
	path: string;
	empty?: (data: T) => boolean;
	children: (data: T, refresh: () => void) => ReactNode;
}) {
	const agentId = useAgentContext();
	const resource = usePanelQuery<T>(path);
	const previousAgent = useRef(agentId);
	useEffect(() => {
		if (agentId && agentId !== previousAgent.current) {
			previousAgent.current = agentId;
			resource.refresh();
		}
	}, [agentId, resource.refresh]);
	return (
		<Panel result={resource.result} onRetry={resource.refresh}>
			{(data) => (
				<>
					{empty?.(data) && (
						<Panel result={resource.result} empty emptyMessage="No matching records.">
							{() => null}
						</Panel>
					)}
					{children(data, () => void resource.refresh())}
				</>
			)}
		</Panel>
	);
}

export function OrganizationSection({ section }: { section: OrganizationSectionId }) {
	const session = useSession();
	const whoami = useWhoami();
	if (!whoami) return null;
	const admin = whoami.user.role === "admin";
	const allowed =
		section === "teams" ||
		section === "classifications" ||
		(section === "access" || section === "audit" ? admin || whoami.user.compliance : admin);
	if (!allowed)
		return <Panel result={{ data: null, error: "Requires the admin role.", status: 403 }}>{() => null}</Panel>;
	const permissions = session.kind === "signed-in" ? (session.permissions ?? []) : [];
	if (section === "roles") return <RolesMatrix />;
	if (section === "users") return <UsersSection />;
	if (section === "teams" || section === "org-teams")
		return (
			<TeamsSection
				admin={section === "org-teams"}
				groupIds={whoami.user.groups.map((group) => group.id)}
				ownedIds={whoami.user.groups.filter((group) => group.role === "owner").map((group) => group.id)}
				permissions={permissions}
				instanceAdmin={admin}
			/>
		);
	if (section === "org-agents")
		return (
			<OrganizationResource<{ agents: readonly OrganizationAgent[] }>
				path="/api/agents"
				empty={(data) => !data.agents.length}
			>
				{(data, refresh) => (
					<div className="flex flex-col gap-6">
						<OrganizationUpgrade onUpdated={refresh} />
						<OrganizationResource<{ groups: readonly OrganizationGroup[] }> path="/api/org/groups">
							{(groups) => (
								<OrganizationResource<{ users: readonly OrganizationUserRow[] }> path="/api/org/users">
									{(users) => (
										<AgentsContent
											agents={data.agents}
											groups={groups.groups}
											users={users.users.map(organizationUser)}
											refresh={refresh}
										/>
									)}
								</OrganizationResource>
							)}
						</OrganizationResource>
					</div>
				)}
			</OrganizationResource>
		);
	if (section === "access") return <AccessSection />;
	if (section === "authentication")
		return (
			<OrganizationResource<OrganizationSettings> path="/api/org/settings">
				{(settings, refresh) => (
					<OrganizationResource<{ groups: readonly OrganizationGroup[] }> path="/api/org/groups">
						{(groups) => (
							<AuthenticationContent
								key={JSON.stringify(settings)}
								settings={settings}
								groups={groups.groups}
								refresh={refresh}
							/>
						)}
					</OrganizationResource>
				)}
			</OrganizationResource>
		);
	if (section === "org-keys") return <KeysSection permissions={permissions} />;
	if (section === "audit") return <AuditSection admin={admin} />;
	if (section === "health")
		return (
			<OrganizationResource<Record<string, unknown>> path="/api/status">
				{(status) => <HealthContent status={status} />}
			</OrganizationResource>
		);
	return (
		<OrganizationResource<readonly OrganizationClassification[]>
			path="/api/classifications"
			empty={(data) => !data.length}
		>
			{(data, refresh) => (
				<ClassificationsContent classifications={data} canManage={whoami.user.compliance} refresh={refresh} />
			)}
		</OrganizationResource>
	);
}

function UsersSection() {
	const [q, setQ] = useState("");
	const [status, setStatus] = useState("");
	const [role, setRole] = useState("");
	const [group, setGroup] = useState("");
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries({ q, status, role, group })) if (value) query.set(key, value);
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3">
				<TextField label="Search people" value={q} onChange={setQ} />
				<Choice
					label="User status"
					value={status}
					onChange={setStatus}
					options={[
						{ value: "", label: "All statuses" },
						{ value: "active", label: "Active" },
						{ value: "deactivated", label: "Deactivated" },
					]}
				/>
				<Choice
					label="User role"
					value={role}
					onChange={setRole}
					options={[
						{ value: "", label: "All roles" },
						...ORGANIZATION_ROLES.map((value) => ({ value, label: displayLabel(value) })),
					]}
				/>
				<OrganizationResource<{ groups: readonly OrganizationGroup[] }> path="/api/org/groups">
					{(data) => (
						<Choice
							label="Team"
							value={group}
							onChange={setGroup}
							options={[
								{ value: "", label: "All teams" },
								...data.groups.map((team) => ({ value: team.id, label: team.name })),
							]}
						/>
					)}
				</OrganizationResource>
			</div>
			<OrganizationResource<{ users: readonly OrganizationUserRow[] }>
				path={`/api/org/users?${query}`}
				empty={(data) => !data.users.length}
			>
				{(data, refresh) => <UsersContent users={data.users.map(organizationUser)} refresh={refresh} />}
			</OrganizationResource>
		</div>
	);
}
function TeamsSection({
	admin,
	groupIds,
	ownedIds,
	permissions,
	instanceAdmin,
}: {
	admin: boolean;
	groupIds: readonly string[];
	ownedIds: readonly string[];
	permissions: readonly string[];
	instanceAdmin: boolean;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	return (
		<OrganizationResource<{ groups: readonly OrganizationGroup[] }> path="/api/org/groups">
			{(data, refresh) => (
				<div className="flex flex-col gap-6">
					{selected ? (
						<>
							<Action secondary onClick={() => setSelected(null)}>
								Back to team directory
							</Action>
							<OrganizationResource<OrganizationGroup & { members: readonly OrganizationMember[] }>
								path={`/api/org/groups/${encodeURIComponent(selected)}`}
							>
								{(group, reload) => (
									<OrganizationResource<{ agents: readonly OrganizationAgent[] }> path="/api/agents">
										{(agents) => (
											<OrganizationResource<readonly OrganizationClassification[]> path="/api/classifications">
												{(classifications) => (
													<TeamContent
														group={group}
														agents={agents.agents}
														classifications={classifications}
														canManage={instanceAdmin || ownedIds.includes(group.id)}
														admin={instanceAdmin}
														permissions={permissions}
														refresh={reload}
													/>
												)}
											</OrganizationResource>
										)}
									</OrganizationResource>
								)}
							</OrganizationResource>
						</>
					) : (
						<TeamDirectory
							groups={data.groups.filter((group) => admin || groupIds.includes(group.id))}
							onSelect={setSelected}
						/>
					)}
					{admin && <CreateTeam refresh={refresh} />}
				</div>
			)}
		</OrganizationResource>
	);
}
function AccessSection() {
	const [selected, setSelected] = useState("");
	return (
		<div className="flex flex-col gap-6">
			<UserLookup
				label="Find a person"
				onSelect={(person) => setSelected(person.id)}
				onSearch={() => setSelected("")}
			/>
			{selected && (
				<OrganizationResource<EffectiveAccess> path={`/api/org/access/${encodeURIComponent(selected)}`}>
					{(access) => (
						<OrganizationResource<{ groups: readonly OrganizationGroup[] }> path="/api/org/groups">
							{(groups) => (
								<OrganizationResource<{ agents: readonly OrganizationAgent[] }> path="/api/agents">
									{(agents) => <AccessContent access={access} groups={groups.groups} agents={agents.agents} />}
								</OrganizationResource>
							)}
						</OrganizationResource>
					)}
				</OrganizationResource>
			)}
		</div>
	);
}
function KeysSection({ permissions }: { permissions: readonly string[] }) {
	const [filters, setFilters] = useState<Readonly<Record<string, string>>>({});
	const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)));
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3">
				{["userId", "deviceId", "harness", "agentId"].map((key) => (
					<TextField
						key={key}
						label={`Key ${key} filter`}
						value={filters[key] ?? ""}
						onChange={(value) => setFilters({ ...filters, [key]: value })}
					/>
				))}
			</div>
			<OrganizationResource<{ keys: readonly OrganizationKey[] }>
				path={`/api/org/keys?${query}`}
				empty={(data) => !data.keys.length}
			>
				{(data) => (
					<OrganizationResource<{ agents: readonly OrganizationAgent[] }> path="/api/agents">
						{(agents) => <KeysContent keys={data.keys} agents={agents.agents} permissions={permissions} />}
					</OrganizationResource>
				)}
			</OrganizationResource>
		</div>
	);
}
function AuditSection({ admin }: { admin: boolean }) {
	const [filters, setFilters] = useState<Readonly<Record<string, string>>>({});
	const [cursor, setCursor] = useState("");
	const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)));
	const pageQuery = new URLSearchParams(query);
	if (cursor) pageQuery.set("cursor", cursor);
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3">
				{[
					{ key: "actor", label: "Actor user ID" },
					{ key: "action", label: "Audit action" },
					{ key: "targetKind", label: "Target kind" },
					{ key: "targetId", label: "Target ID" },
					{ key: "since", label: "Since (ISO UTC)" },
					{ key: "until", label: "Until (ISO UTC)" },
				].map(({ key, label }) => (
					<TextField
						key={key}
						label={label}
						value={filters[key] ?? ""}
						onChange={(value) => {
							setFilters({ ...filters, [key]: value });
							setCursor("");
						}}
					/>
				))}
			</div>
			{cursor && (
				<Action secondary onClick={() => setCursor("")}>
					First page
				</Action>
			)}
			<OrganizationResource<AuditPage> path={`/api/org/audit?${pageQuery}`} empty={(data) => !data.events.length}>
				{(page, refresh) =>
					admin ? (
						<OrganizationResource<OrganizationSettings> path="/api/org/settings">
							{(settings) => (
								<AuditContent
									page={page}
									query={query.toString()}
									onNext={setCursor}
									retention={settings.auditRetentionDays}
									admin
									refresh={refresh}
								/>
							)}
						</OrganizationResource>
					) : (
						<AuditContent
							page={page}
							query={query.toString()}
							onNext={setCursor}
							retention={null}
							admin={false}
							refresh={refresh}
						/>
					)
				}
			</OrganizationResource>
		</div>
	);
}

import { useState } from "react";
import { Panel } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displayLabel, agentDisplayName } from "./controls";
import { getJSONResult } from "@/lib/api";
import {
	ORGANIZATION_PERMISSIONS,
	ORGANIZATION_ROLES,
	type OffboardingPlan,
	type OrganizationUser,
	type OrganizationGroup,
	type OrganizationAgent,
	offboardingRequest,
	rolePermissions,
} from "@/lib/organization";
import {
	Action,
	Choice,
	DateValue,
	Message,
	OrganizationBlock,
	OrganizationTable,
	TextField,
	cellClass,
	rowClass,
} from "./controls";
import { TrackedJob } from "./job";

export function OffboardingImpact({ plan }: { plan: OffboardingPlan }) {
	const labels: Readonly<Record<string, string>> = {
		memories: "Memories",
		transcripts: "Transcripts",
		keys: "API keys",
		apiKeys: "API keys",
		sessions: "Active sessions",
		artifacts: "Source files",
		documents: "Documents",
		claims: "Derived claims",
	};
	return (
		<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-small">
			{Object.entries(plan.counts).map(([kind, count]) => (
				<div key={kind} className="contents">
					<dt className="text-muted-foreground">{labels[kind] ?? displayLabel(kind)}</dt>
					<dd className="text-right tabular-nums">{count.toLocaleString()}</dd>
				</div>
			))}
		</dl>
	);
}
export function OffboardingWizard({
	user,
	users,
	onClose,
}: {
	user: OrganizationUser;
	users: readonly OrganizationUser[];
	onClose: () => void;
}) {
	const [step, setStep] = useState(1);
	const [mode, setMode] = useState("keep");
	const [transferTo, setTransferTo] = useState("");
	const [typed, setTyped] = useState("");
	const [plan, setPlan] = useState<OffboardingPlan | null>(null);
	const [jobId, setJobId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const path = `/api/org/users/${encodeURIComponent(user.id)}/deactivate`;
	const preview = async () => {
		setBusy(true);
		setError(null);
		const result = await getJSONResult<{ plan: OffboardingPlan }>(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode, ...(mode === "transfer" ? { transferTo } : {}), dryRun: true }),
		});
		setBusy(false);
		setError(result.error);
		setPlan(result.data?.plan ?? null);
		if (result.data) setStep(2);
	};
	const confirm = async () => {
		const body = offboardingRequest(plan, user.displayName, typed);
		if (!body) return;
		setBusy(true);
		setError(null);
		const result = await getJSONResult<{ jobId: string }>(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		setBusy(false);
		setError(result.error);
		setJobId(result.data?.jobId ?? null);
	};
	const destination = users.find((person) => person.id === transferTo)?.displayName ?? "the selected person";
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto [&>*]:min-w-0">
				<DialogHeader>
					<DialogTitle>Offboard {user.displayName}</DialogTitle>
					<DialogDescription>
						{jobId
							? "Follow the offboarding job to its durable result."
							: `Step ${step} of 3 · ${step === 1 ? "Material handling" : step === 2 ? "Impact preview" : "Confirm offboarding"}`}
					</DialogDescription>
				</DialogHeader>
				{jobId ? (
					<TrackedJob id={jobId} />
				) : (
					<>
						{step === 1 && (
							<div className="flex flex-col gap-4">
								<p className="text-small text-muted-foreground">
									Authorship is preserved when ownership is transferred. All active sessions and API keys will be
									revoked.
								</p>
								<Choice
									label="Material handling"
									value={mode}
									onChange={(value) => {
										setMode(value);
										setPlan(null);
									}}
									options={[
										{ value: "keep", label: "Keep evidence and ownership" },
										{ value: "transfer", label: "Transfer agent ownership" },
										{ value: "purge", label: "Purge authored material" },
									]}
								/>
								{mode === "transfer" && (
									<Choice
										label="New agent owner"
										value={transferTo}
										onChange={setTransferTo}
										options={[
											{ value: "", label: "Select a person" },
											...users
												.filter((person) => person.id !== user.id && person.status === "active")
												.map((person) => ({ value: person.id, label: person.displayName })),
										]}
									/>
								)}
							</div>
						)}
						{step === 2 && plan && (
							<div className="flex flex-col gap-4">
								<OffboardingImpact plan={plan} />
								{plan.ownedAgents && (
									<div>
										<p className="text-small text-muted-foreground">Agent ownership after offboarding</p>
										<ul className="m-0 list-none space-y-2 p-0 text-small">
											{plan.ownedAgents.map((agent) => (
												<li key={agent.id} className="flex flex-wrap justify-between gap-2">
													<span>{agent.name}</span>
													<span>{agent.transferTo?.displayName ?? "Unchanged"}</span>
												</li>
											))}
										</ul>
									</div>
								)}
								<p className="text-small">
									{mode === "transfer"
										? `Personal agents transfer to ${destination}. Authorship stays with ${user.displayName}.`
										: mode === "purge"
											? "Authored evidence and its derived state will be purged. Existing agent ownership is unchanged."
											: "Evidence and agent ownership stay in place. The deactivated person can no longer act as their agents."}{" "}
									API keys and active sessions are revoked, never transferred.
								</p>
							</div>
						)}
						{step === 3 && (
							<div className="flex flex-col gap-4">
								<p className="text-small">
									Offboarding prevents {user.displayName} from signing in. Revoked keys and sessions cannot be restored.
								</p>
								<TextField label={`Type ${user.displayName} to confirm`} value={typed} onChange={setTyped} />
							</div>
						)}
					</>
				)}
				<Message error={error} />
				<DialogFooter>
					<Action
						secondary
						disabled={busy}
						onClick={() => {
							if (step > 1 && !jobId) setStep(step - 1);
							else onClose();
						}}
					>
						{jobId ? "Close" : step > 1 ? "Back" : "Cancel"}
					</Action>
					{!jobId &&
						(step === 1 ? (
							<Action disabled={busy || (mode === "transfer" && !transferTo)} onClick={() => void preview()}>
								Preview offboarding
							</Action>
						) : step === 2 ? (
							<Action onClick={() => setStep(3)}>Continue</Action>
						) : (
							<Action
								destructive
								disabled={busy || !offboardingRequest(plan, user.displayName, typed)}
								onClick={() => void confirm()}
							>
								Offboard {user.displayName}
							</Action>
						))}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function UserActions({
	user,
	busy,
	onRole,
	onOffboard,
	onReactivate,
}: {
	user: OrganizationUser;
	busy: boolean;
	onRole: () => void;
	onOffboard: () => void;
	onReactivate: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="compact" aria-label={`Actions for ${user.displayName}`} disabled={busy}>
					⋯
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={onRole}>Change role…</DropdownMenuItem>
				{user.status === "active" ? (
					<DropdownMenuItem variant="destructive" onSelect={onOffboard}>
						Offboard…
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem onSelect={onReactivate}>Reactivate</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
export function UsersContent({ users, refresh }: { users: readonly OrganizationUser[]; refresh: () => void }) {
	const [selected, setSelected] = useState<OrganizationUser | null>(null);
	const [roleUser, setRoleUser] = useState<OrganizationUser | null>(null);
	const [nextRole, setNextRole] = useState("member");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	const [invite, setInvite] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const update = async (user: OrganizationUser, newRole?: string) => {
		setBusy(true);
		const result = await getJSONResult(`/api/org/users/${encodeURIComponent(user.id)}${newRole ? "" : "/reactivate"}`, {
			method: newRole ? "PATCH" : "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(newRole ? { role: newRole } : {}),
		});
		setBusy(false);
		setError(result.error);
		if (result.data) {
			setRoleUser(null);
			refresh();
		}
	};
	const createInvite = async () => {
		setBusy(true);
		setInvite(null);
		const result = await getJSONResult<{ inviteUrl: string }>("/api/org/invites", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: email || undefined, role, groupIds: [] }),
		});
		setBusy(false);
		setError(result.error);
		setInvite(result.data?.inviteUrl ?? null);
	};
	const actions = (user: OrganizationUser) => (
		<UserActions
			user={user}
			busy={busy}
			onRole={() => {
				setRoleUser(user);
				setNextRole(user.role);
			}}
			onOffboard={() => setSelected(user)}
			onReactivate={() => void update(user)}
		/>
	);
	return (
		<div className="flex flex-col gap-6">
			<Message error={error} />
			{selected && (
				<OffboardingWizard
					user={selected}
					users={users}
					onClose={() => {
						setSelected(null);
						refresh();
					}}
				/>
			)}
			<OrganizationBlock title="People">
				<div className="hidden sm:block">
					<OrganizationTable columns={["Person", "Role", "Status", "Last active", ""]}>
						{users.map((user) => (
							<tr key={user.id} className={rowClass}>
								<td className={cellClass}>
									<div>{user.displayName}</div>
									<div className="text-muted-foreground">{[user.username, user.email].filter(Boolean).join(" · ")}</div>
								</td>
								<td className={cellClass}>{displayLabel(user.role)}</td>
								<td className={cellClass}>
									{displayLabel(user.status)}
									{user.compliance ? " · Compliance" : ""}
								</td>
								<td className={cellClass}>
									<DateValue value={user.lastActiveAt} />
								</td>
								<td className={cellClass}>{actions(user)}</td>
							</tr>
						))}
					</OrganizationTable>
				</div>
				<ul className="m-0 list-none divide-y p-0 sm:hidden">
					{users.map((user) => (
						<li key={user.id} className="py-4">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<p className="m-0 font-medium">{user.displayName}</p>
									<p className="m-0 break-words text-small text-muted-foreground">
										{[user.username, user.email].filter(Boolean).join(" · ")}
									</p>
								</div>
								{actions(user)}
							</div>
							<dl className="mt-3 grid grid-cols-2 gap-2 text-small">
								<dt className="text-muted-foreground">Role</dt>
								<dd>{displayLabel(user.role)}</dd>
								<dt className="text-muted-foreground">Status</dt>
								<dd>
									{displayLabel(user.status)}
									{user.compliance ? " · Compliance" : ""}
								</dd>
								<dt className="text-muted-foreground">Last active</dt>
								<dd>
									<DateValue value={user.lastActiveAt} />
								</dd>
							</dl>
						</li>
					))}
				</ul>
			</OrganizationBlock>
			<ConfirmationDialog
				open={roleUser !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setRoleUser(null);
				}}
				title={`Change ${roleUser?.displayName ?? "user"}'s role`}
				description={`Change from ${displayLabel(roleUser?.role ?? "")} to ${displayLabel(nextRole)}. This changes their organization permissions.`}
				actions={
					<>
						<Action secondary disabled={busy} onClick={() => setRoleUser(null)}>
							Cancel
						</Action>
						<Action
							disabled={busy || nextRole === roleUser?.role}
							onClick={() => {
								if (roleUser) void update(roleUser, nextRole);
							}}
						>
							Confirm role change
						</Action>
					</>
				}
			>
				<Choice
					label="New role"
					value={nextRole}
					onChange={setNextRole}
					options={ORGANIZATION_ROLES.map((value) => ({ value, label: displayLabel(value) }))}
				/>
			</ConfirmationDialog>
			<OrganizationBlock title="Invite a person">
				<TextField label="Email" type="email" value={email} onChange={setEmail} />
				<Choice
					label="Invitation role"
					value={role}
					onChange={setRole}
					options={ORGANIZATION_ROLES.map((value) => ({ value, label: displayLabel(value) }))}
				/>
				<Action disabled={busy} onClick={() => void createInvite()}>
					Create invitation
				</Action>
				{invite && (
					<div role="status" className="flex flex-col gap-2">
						<p>This invitation is shown once. Copy it now.</p>
						<code className="break-all select-all">{invite}</code>
						<Action
							secondary
							onClick={() => {
								void navigator.clipboard
									.writeText(invite)
									.catch(() => setError("Copy failed. Select the invitation manually."));
							}}
						>
							Copy invitation
						</Action>
						<Action secondary onClick={() => setInvite(null)}>
							Dismiss invitation
						</Action>
					</div>
				)}
			</OrganizationBlock>
		</div>
	);
}

export function RolesMatrix() {
	return (
		<OrganizationBlock
			title="Built-in roles"
			description="Read-only. Compliance adds classify and audit; it never grants access to content outside an audience."
		>
			<OrganizationTable columns={["Permission", ...ORGANIZATION_ROLES.map(displayLabel)]}>
				{ORGANIZATION_PERMISSIONS.map((permission) => (
					<tr key={permission} className={rowClass}>
						<th scope="row" className={cellClass}>
							{displayLabel(permission)}
						</th>
						{ORGANIZATION_ROLES.map((role) => (
							<td key={role} className={cellClass}>
								{rolePermissions(role).includes(permission) ? "Granted" : "—"}
							</td>
						))}
					</tr>
				))}
			</OrganizationTable>
		</OrganizationBlock>
	);
}

export interface EffectiveAccess {
	readonly user: OrganizationUser;
	readonly role: string;
	readonly permissions: readonly string[];
	readonly groups: readonly string[];
	readonly actAs: readonly { agentId: string; kind: string; why: string }[];
	readonly readableClassifications: readonly { id: string; name: string; why?: string }[];
}
export function AccessContent({
	access,
	groups = [],
	agents = [],
}: {
	access: EffectiveAccess;
	groups?: readonly OrganizationGroup[];
	agents?: readonly OrganizationAgent[];
}) {
	const why = (row: EffectiveAccess["actAs"][number]) => {
		if (row.why === "active user") return "Every active user can act as the organization agent";
		if (row.why === "personal owner") return "Owns this personal agent";
		if (row.why === "administrator") return "Administrator";
		if (row.why === "group membership") {
			const owner = agents.find((agent) => agent.id === row.agentId)?.ownerGroupId;
			const team = groups.find((group) => group.id === owner);
			return team ? `Member of team ${team.name}` : "Member of the owning team";
		}
		return "Access granted by the daemon";
	};
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock
				title={access.user.displayName}
				description={`Role: ${displayLabel(access.role)}. Teams: ${access.groups.map((id) => groups.find((group) => group.id === id)?.name ?? "Team").join(", ") || "None"}.`}
			>
				<p className="text-small">
					Permissions from role and compliance: {access.permissions.map(displayLabel).join(", ") || "None"}
				</p>
			</OrganizationBlock>
			<OrganizationBlock title="May act as">
				<Panel
					result={{ data: access.actAs, error: null, status: 200 }}
					empty={!access.actAs.length}
					emptyMessage="No agents available."
				>
					{(rows) => (
						<>
							<div className="hidden sm:block">
								<OrganizationTable columns={["Agent", "Kind", "Why"]}>
									{rows.map((agent) => (
										<tr key={agent.agentId} className={rowClass}>
											<td className={cellClass}>
												<div>{agentDisplayName(agents.find((item) => item.id === agent.agentId))}</div>
												<div className="break-all text-xs text-muted-foreground">{agent.agentId}</div>
											</td>
											<td className={cellClass}>{displayLabel(agent.kind)}</td>
											<td className={cellClass}>{why(agent)}</td>
										</tr>
									))}
								</OrganizationTable>
							</div>
							<ul className="m-0 list-none divide-y p-0 sm:hidden">
								{rows.map((agent) => (
									<li key={agent.agentId} className="py-4">
										<p className="m-0 text-small font-medium">
											{agentDisplayName(agents.find((item) => item.id === agent.agentId))}
										</p>
										<p className="m-0 mt-1 break-all text-xs text-muted-foreground">{agent.agentId}</p>
										<dl className="mt-3 grid grid-cols-2 gap-2 text-small">
											<dt className="text-muted-foreground">Kind</dt>
											<dd>{displayLabel(agent.kind)}</dd>
											<dt className="text-muted-foreground">Why</dt>
											<dd>{why(agent)}</dd>
										</dl>
									</li>
								))}
							</ul>
						</>
					)}
				</Panel>
			</OrganizationBlock>
			<OrganizationBlock title="Readable classifications">
				<Panel
					result={{ data: access.readableClassifications, error: null, status: 200 }}
					empty={!access.readableClassifications.length}
					emptyMessage="No readable classifications."
				>
					{(items) => (
						<ul className="m-0 list-none divide-y p-0 text-small">
							{items.map((item) => (
								<li key={item.id} className="py-3">
									{item.name}
									<span className="ml-2 text-muted-foreground">{item.why ?? "Audience membership"}</span>
								</li>
							))}
						</ul>
					)}
				</Panel>
			</OrganizationBlock>
		</div>
	);
}

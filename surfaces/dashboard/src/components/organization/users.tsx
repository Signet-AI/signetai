import { useState } from "react";
import { getJSONResult } from "@/lib/api";
import {
	ORGANIZATION_PERMISSIONS,
	ORGANIZATION_ROLES,
	type OffboardingPlan,
	type OrganizationUser,
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

export function OffboardingWizard({
	user,
	users,
	onClose,
}: {
	user: OrganizationUser;
	users: readonly OrganizationUser[];
	onClose: () => void;
}) {
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
	return (
		<OrganizationBlock
			title={`Offboard ${user.displayName}`}
			description="Sessions and keys are revoked. Authorship is preserved when agent ownership is transferred."
		>
			{jobId ? (
				<TrackedJob id={jobId} />
			) : (
				<>
					<Choice
						label="Material handling"
						value={mode}
						onChange={(value) => {
							setMode(value);
							setPlan(null);
							setTyped("");
						}}
						options={[
							{ value: "keep", label: "Keep evidence and ownership" },
							{ value: "transfer", label: "Transfer agent ownership" },
							{ value: "purge", label: "Purge authored material" },
						]}
					/>
					{mode === "transfer" && (
						<Choice
							label="Transfer to"
							value={transferTo}
							onChange={(value) => {
								setTransferTo(value);
								setPlan(null);
							}}
							options={[
								{ value: "", label: "Select an active user" },
								...users
									.filter((item) => item.id !== user.id && item.status === "active")
									.map((item) => ({ value: item.id, label: item.displayName })),
							]}
						/>
					)}
					<Action disabled={busy || (mode === "transfer" && !transferTo)} onClick={() => void preview()}>
						Preview offboarding
					</Action>
					{plan && (
						<>
							<OrganizationTable columns={["Affected material", "Readable count"]}>
								{Object.entries(plan.counts).map(([kind, count]) => (
									<tr key={kind} className={rowClass}>
										<td className={cellClass}>{kind}</td>
										<td className={cellClass}>{count}</td>
									</tr>
								))}
							</OrganizationTable>
							<TextField label={`Type ${user.displayName} to confirm`} value={typed} onChange={setTyped} />
							<Action
								disabled={busy || !offboardingRequest(plan, user.displayName, typed)}
								onClick={() => void confirm()}
							>
								Confirm offboarding
							</Action>
						</>
					)}
				</>
			)}
			<Message error={error} />
			<Action secondary onClick={onClose}>
				{jobId ? "Close" : "Cancel"}
			</Action>
		</OrganizationBlock>
	);
}

export function UsersContent({ users, refresh }: { users: readonly OrganizationUser[]; refresh: () => void }) {
	const [selected, setSelected] = useState<OrganizationUser | null>(null);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	const [invite, setInvite] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const update = async (user: OrganizationUser, nextRole?: string) => {
		setBusy(true);
		const result = await getJSONResult(
			`/api/org/users/${encodeURIComponent(user.id)}${nextRole ? "" : "/reactivate"}`,
			{
				method: nextRole ? "PATCH" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nextRole ? { role: nextRole } : {}),
			},
		);
		setBusy(false);
		setError(result.error);
		if (result.data) refresh();
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
	return (
		<div className="flex flex-col gap-6">
			<Message error={error} />
			{selected ? (
				<OffboardingWizard
					user={selected}
					users={users}
					onClose={() => {
						setSelected(null);
						refresh();
					}}
				/>
			) : (
				<>
					<OrganizationBlock title="People">
						<OrganizationTable columns={["Person", "Role", "Status", "Last active", "Actions"]}>
							{users.map((user) => (
								<tr key={user.id} className={rowClass}>
									<td className={cellClass}>
										<div>{user.displayName}</div>
										<div className="text-muted-foreground">
											{user.username} · {user.email}
										</div>
									</td>
									<td className={cellClass}>
										<Choice
											label={`Role for ${user.username}`}
											value={user.role}
											onChange={(value) => void update(user, value)}
											options={ORGANIZATION_ROLES.map((value) => ({ value, label: value }))}
										/>
									</td>
									<td className={cellClass}>
										{user.status}
										{user.compliance ? " · compliance" : ""}
									</td>
									<td className={cellClass}>
										<DateValue value={user.lastActiveAt} />
									</td>
									<td className={cellClass}>
										<Action
											secondary
											disabled={busy}
											onClick={() => (user.status === "active" ? setSelected(user) : void update(user))}
										>
											{user.status === "active" ? "Offboard…" : "Reactivate"}
										</Action>
									</td>
								</tr>
							))}
						</OrganizationTable>
					</OrganizationBlock>
					<OrganizationBlock title="Invite a person">
						<div className="grid gap-3 sm:grid-cols-2">
							<TextField label="Invitation email" type="email" value={email} onChange={setEmail} />
							<Choice
								label="Invitation role"
								value={role}
								onChange={setRole}
								options={ORGANIZATION_ROLES.map((value) => ({ value, label: value }))}
							/>
						</div>
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
				</>
			)}
		</div>
	);
}

export function RolesMatrix() {
	return (
		<OrganizationBlock
			title="Built-in roles"
			description="Read-only. Compliance adds classify and audit; it never grants access to content outside an audience."
		>
			<OrganizationTable columns={["Permission", ...ORGANIZATION_ROLES]}>
				{ORGANIZATION_PERMISSIONS.map((permission) => (
					<tr key={permission} className={rowClass}>
						<th scope="row" className={cellClass}>
							{permission}
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
export function AccessContent({ access }: { access: EffectiveAccess }) {
	return (
		<div className="flex flex-col gap-6">
			<OrganizationBlock
				title={access.user.displayName}
				description={`Role: ${access.role}. Groups: ${access.groups.join(", ") || "None"}.`}
			>
				<p className="text-small">Permissions from role and compliance: {access.permissions.join(", ") || "None"}</p>
			</OrganizationBlock>
			<OrganizationBlock title="May act as">
				<OrganizationTable columns={["Agent", "Kind", "Why"]}>
					{access.actAs.map((agent) => (
						<tr key={agent.agentId} className={rowClass}>
							<td className={cellClass}>{agent.agentId}</td>
							<td className={cellClass}>{agent.kind}</td>
							<td className={cellClass}>{agent.why}</td>
						</tr>
					))}
				</OrganizationTable>
			</OrganizationBlock>
			<OrganizationBlock title="Readable classifications">
				<ul className="text-small">
					{access.readableClassifications.map((item) => (
						<li key={item.id}>
							{item.name} · {item.why ?? "Audience membership"}
						</li>
					))}
				</ul>
			</OrganizationBlock>
		</div>
	);
}

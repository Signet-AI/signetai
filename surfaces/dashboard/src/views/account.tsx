import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Panel } from "@/components/shell/panel";
import { AuthField } from "@/components/shell/auth-entry";
import { getJSONResult } from "@/lib/api";
import { usePanelQuery } from "@/lib/use-panel-query";
import { ConnectorErrors } from "@/components/settings/connector-errors";
import { ProfileFields } from "@/components/settings/profile-fields";
import { useSession, useWhoami, refreshSession, useCan } from "@/lib/session";

const SECTIONS = ["Profile", "Sessions", "Devices and connectors", "Personal API keys", "My agents"] as const;
type Section = (typeof SECTIONS)[number];
interface KeyRecord {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly harness: string | null;
	readonly agent_id: string | null;
	readonly created_at: string;
	readonly expires_at: string | null;
	readonly last_used_at: string | null;
	readonly revoked_at: string | null;
	readonly kind: string;
}
interface PersonalAgent {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	readonly ownerUserId: string | null;
	readonly canActAs: boolean;
	readonly archivedAt: string | null;
}
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : "Not available");

async function revoke(path: string, refresh: () => void) {
	const result = await getJSONResult(path, { method: "DELETE" });
	if (result.error) toast.error(result.error);
	else refresh();
}

export function AccountView() {
	const whoami = useWhoami();
	const readSection = (): Section => (location.hash === "#account/devices" ? "Devices and connectors" : "Profile");
	const [section, setSection] = useState<Section>(readSection);
	useEffect(() => {
		const update = () => setSection(readSection());
		window.addEventListener("hashchange", update);
		return () => window.removeEventListener("hashchange", update);
	}, []);
	const [query, setQuery] = useState("");
	if (!whoami) return null;
	return (
		<section className="settings-page" aria-label="My account">
			<div className="settings-workspace">
				<nav aria-label="Account sections" className="settings-section-nav">
					<Input
						aria-label="Search account"
						placeholder="Search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<div className="settings-nav-groups">
						<section className="settings-nav-group">
							<h3 className="settings-nav-group-label">My account</h3>
							<div className="settings-group-items">
								{SECTIONS.filter((item) => item.toLowerCase().includes(query.toLowerCase())).map((item) => (
									<button
										key={item}
										type="button"
										className="settings-section-link"
										aria-current={section === item ? "page" : undefined}
										onClick={() => setSection(item)}
									>
										{item}
									</button>
								))}
							</div>
						</section>
					</div>
				</nav>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="settings-scroll">
						<div className="settings-content">
							<h2 className="settings-title">{section}</h2>
							<p className="text-small text-muted-foreground">
								{whoami.organization.name} · {location.origin}
							</p>
							{section === "Profile" ? (
								<Profile />
							) : section === "Sessions" ? (
								<Sessions />
							) : section === "Devices and connectors" ? (
								<Devices />
							) : section === "Personal API keys" ? (
								<PersonalKeys />
							) : (
								<MyAgents />
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

interface ProfileResponse {
	readonly user: { readonly id: string; readonly displayName: string; readonly email: string | null };
	readonly identityProvider: { readonly kind: string; readonly issuer: string } | null;
	readonly editableFields: readonly string[];
}

function Profile() {
	const whoami = useWhoami();
	const { result, refresh } = usePanelQuery<ProfileResponse>("/api/auth/profile");
	const [name, setName] = useState(whoami?.user.displayName ?? "");
	const email = result?.data?.user.email ?? whoami?.user.email ?? "";
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!whoami) return null;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!result?.data || result.data.identityProvider) return;
		const submitted = { displayName: name };
		setBusy(true);
		setError(null);
		const response = await getJSONResult<ProfileResponse>("/api/auth/profile", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(submitted),
		});
		if (response.error) {
			setError(response.error);
			setBusy(false);
			return;
		}
		const confirmed = await getJSONResult<ProfileResponse>("/api/auth/profile");
		if (!confirmed.data || confirmed.data.user.displayName !== submitted.displayName.trim())
			setError(confirmed.error ?? "The saved profile could not be confirmed. Refresh before retrying.");
		else {
			setName((current) =>
				current === submitted.displayName ? (confirmed.data?.user.displayName ?? current) : current,
			);
			await refreshSession();
			refresh();
			toast.success("Profile saved");
		}
		setBusy(false);
	};
	return (
		<div className="flex flex-col gap-6">
			<ProfileFields
				name={name}
				email={email}
				editableFields={result?.data?.editableFields ?? []}
				ssoManaged={Boolean(result?.data?.identityProvider) || whoami.user.ssoManaged === true}
				busy={busy}
				onNameChange={setName}
				onSubmit={(event) => void submit(event)}
			/>
			{error && (
				<p role="alert" className="text-small text-destructive">
					{error}
				</p>
			)}
			<Panel result={result} onRetry={refresh}>
				{() => (
					<dl className="grid grid-cols-[auto_1fr] gap-3 text-small">
						<dt className="text-muted-foreground">Username</dt>
						<dd>{whoami.user.username}</dd>
						<dt className="text-muted-foreground">Role</dt>
						<dd>{whoami.user.role}</dd>
					</dl>
				)}
			</Panel>
			<h2 className="text-body font-medium">Team memberships</h2>
			{whoami.user.groups.length ? (
				<ul className="m-0 list-none divide-y p-0">
					{whoami.user.groups.map((group) => (
						<li key={group.id} className="flex flex-wrap justify-between gap-2 py-3 text-small">
							<span>{group.name}</span>
							<span className="text-muted-foreground">
								{group.role}
								{group.managedBy === "idp" ? " · Managed by your identity provider" : ""}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-small text-muted-foreground">You do not belong to a team yet.</p>
			)}
		</div>
	);
}

function Sessions() {
	const whoami = useWhoami();
	const { result, refresh } = usePanelQuery<{
		sessions: readonly {
			id: string;
			kind: string;
			device_id: string | null;
			user_agent: string | null;
			last_used_at: string | null;
			access_expires_at: string;
			revoked_at: string | null;
		}[];
	}>("/api/auth/sessions");
	return (
		<Panel result={result} empty={result?.data?.sessions.length === 0} emptyMessage="No sessions." onRetry={refresh}>
			{({ sessions }) => (
				<ul className="m-0 list-none divide-y p-0">
					{sessions.map((session) => (
						<li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
							<div className="min-w-0 text-small">
								<p className="m-0 font-medium">
									{session.kind} {session.id === whoami?.credential.id && "· This browser"}
								</p>
								<p className="m-0 break-all text-muted-foreground">
									{session.user_agent ?? session.device_id ?? session.id}
								</p>
								<p className="m-0 text-muted-foreground">
									Last active {date(session.last_used_at)} · Expires {date(session.access_expires_at)}
								</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={Boolean(session.revoked_at)}
								onClick={() => void revoke(`/api/auth/sessions/${encodeURIComponent(session.id)}`, refresh)}
							>
								{session.revoked_at ? "Revoked" : "Revoke session"}
							</Button>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}

function KeyRows({ keys, refresh }: { readonly keys: readonly KeyRecord[]; readonly refresh: () => void }) {
	return (
		<ul className="m-0 list-none divide-y p-0">
			{keys.map((key) => (
				<li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
					<div className="min-w-0 text-small">
						<p className="m-0 font-medium">
							{key.name} · {key.prefix}
						</p>
						<p className="m-0 break-all text-muted-foreground">
							{key.harness ?? "Script"} · Agent {key.agent_id ?? "Your default"}
						</p>
						<p className="m-0 text-muted-foreground">
							Created {date(key.created_at)} · Expires {date(key.expires_at)} · Last used {date(key.last_used_at)}
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={Boolean(key.revoked_at)}
						onClick={() =>
							void revoke(
								`/api/auth/${key.kind === "connector" ? "connector-keys" : "api-keys"}/${encodeURIComponent(key.id)}`,
								refresh,
							)
						}
					>
						{key.revoked_at ? "Revoked" : "Revoke key"}
					</Button>
					{key.kind === "connector" && <ConnectorErrors keyId={key.id} />}
				</li>
			))}
		</ul>
	);
}

function Devices() {
	const { result, refresh } = usePanelQuery<{
		devices: readonly {
			id: string;
			name: string;
			platform: string | null;
			created_at: string;
			last_seen_at: string | null;
			revoked_at: string | null;
			keys: readonly KeyRecord[];
		}[];
	}>("/api/auth/devices");
	const commands = `signet login --url ${location.origin}\nsignet connect <harness>`;
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3 rounded-lg border p-4">
				<h2 className="m-0 text-body font-medium">Connect a harness</h2>
				<pre className="m-0 overflow-x-auto text-small">{commands}</pre>
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					onClick={() =>
						void navigator.clipboard.writeText(commands).then(
							() => toast.success("Commands copied"),
							() => toast.error("Could not copy. Select the commands and copy them manually."),
						)
					}
				>
					Copy commands
				</Button>
			</div>
			<Panel
				result={result}
				empty={result?.data?.devices.length === 0}
				emptyMessage="No devices yet. Sign in from a device to connect a harness."
				onRetry={refresh}
			>
				{({ devices }) => (
					<ul className="m-0 list-none divide-y p-0">
						{devices.map((device) => (
							<li key={device.id} className="py-4">
								<div className="flex flex-wrap items-center justify-between gap-3">
									<div className="text-small">
										<h2 className="m-0 text-body font-medium">{device.name}</h2>
										<p className="m-0 text-muted-foreground">
											{device.platform ?? "Unknown platform"} · Created {date(device.created_at)} · Last seen{" "}
											{date(device.last_seen_at)}
										</p>
									</div>
									<Button
										variant="outline"
										size="sm"
										disabled={Boolean(device.revoked_at)}
										onClick={() => void revoke(`/api/auth/devices/${encodeURIComponent(device.id)}`, refresh)}
									>
										{device.revoked_at ? "Revoked" : "Revoke device"}
									</Button>
								</div>
								<KeyRows keys={device.keys} refresh={refresh} />
							</li>
						))}
					</ul>
				)}
			</Panel>
			<p className="text-small text-muted-foreground">
				Revoking a device also revokes its sessions and connector keys. Expand a connector’s recent errors to inspect
				authentication failures from the past seven days.
			</p>
		</div>
	);
}

function PersonalKeys() {
	const session = useSession();
	const permissions = session.kind === "signed-in" || session.kind === "signed-out" ? (session.permissions ?? []) : [];
	const { result, refresh } = usePanelQuery<{ apiKeys: readonly KeyRecord[] }>("/api/auth/api-keys");
	const roster = usePanelQuery<{ agents: readonly PersonalAgent[] }>("/api/agents");
	const [name, setName] = useState("");
	const [agentId, setAgentId] = useState("");
	const [selected, setSelected] = useState<readonly string[]>([]);
	const [expiresAt, setExpiresAt] = useState("");
	const [secret, setSecret] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const response = await getJSONResult<{ secret: string }>("/api/auth/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				kind: "personal",
				...(agentId ? { agentId } : {}),
				permissions: selected.filter((permission) => permissions.includes(permission)),
				expiresAt: new Date(expiresAt).toISOString(),
			}),
		});
		setBusy(false);
		if (response.error || !response.data?.secret) setError(response.error ?? "The instance did not return a key.");
		else {
			setSecret(response.data.secret);
			setName("");
			setSelected([]);
			refresh();
		}
	};
	return (
		<div className="flex flex-col gap-6">
			{secret ? (
				<div className="flex flex-col gap-3 rounded-lg border p-4">
					<h2 className="m-0 text-body font-medium">Copy your key now</h2>
					<p className="m-0 text-small text-muted-foreground">
						This is the only time it is shown. Store it somewhere safe.
					</p>
					<output aria-label="New API key" className="break-all font-mono text-small">
						{secret}
					</output>
					<div className="flex gap-3">
						<Button
							variant="outline"
							onClick={() =>
								void navigator.clipboard.writeText(secret).then(
									() => toast.success("Key copied"),
									() => toast.error("Could not copy. Select the key and copy it manually."),
								)
							}
						>
							Copy key
						</Button>
						<Button onClick={() => setSecret(null)}>I saved my key</Button>
					</div>
				</div>
			) : (
				<form
					onSubmit={submit}
					className="flex flex-col gap-4 rounded-lg border p-4"
					aria-label="Create personal API key"
				>
					<h2 className="m-0 text-body font-medium">Create a personal API key</h2>
					<AuthField label="Name" name="keyName" value={name} onChange={setName} />
					<label className="flex flex-col gap-1.5 text-small">
						Agent
						<select
							className="rounded border bg-background p-2"
							value={agentId}
							onChange={(event) => setAgentId(event.target.value)}
						>
							<option value="">Your default write agent</option>
							{roster.result?.data?.agents
								.filter((agent) => agent.canActAs && !agent.archivedAt)
								.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
						</select>
					</label>
					<fieldset className="flex flex-wrap gap-3">
						<legend className="mb-2 text-small">Permissions</legend>
						{permissions.map((permission) => (
							<label key={permission} className="flex items-center gap-2 text-small">
								<input
									type="checkbox"
									value={permission}
									checked={selected.includes(permission)}
									onChange={(event) =>
										setSelected(
											event.target.checked ? [...selected, permission] : selected.filter((item) => item !== permission),
										)
									}
								/>
								{permission}
							</label>
						))}
					</fieldset>
					<AuthField
						label="Expires at (your local time)"
						name="expiresAt"
						type="datetime-local"
						value={expiresAt}
						onChange={setExpiresAt}
					/>
					{error && (
						<p role="alert" className="text-small text-destructive">
							{error}
						</p>
					)}
					<Button type="submit" disabled={busy || selected.length === 0}>
						{busy ? "Creating…" : "Create key"}
					</Button>
				</form>
			)}
			<Panel
				result={result}
				empty={result?.data?.apiKeys.filter((key) => key.kind === "personal").length === 0}
				emptyMessage="No personal API keys."
				onRetry={refresh}
			>
				{({ apiKeys }) => <KeyRows keys={apiKeys.filter((key) => key.kind === "personal")} refresh={refresh} />}
			</Panel>
		</div>
	);
}

function MyAgents() {
	const whoami = useWhoami();
	const canRename = useCan("modify");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const { result, refresh } = usePanelQuery<{ agents: readonly PersonalAgent[] }>("/api/agents");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const response = await getJSONResult("/api/agents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, kind: "personal" }),
		});
		setBusy(false);
		if (response.error) setError(response.error);
		else {
			setName("");
			refresh();
		}
	};
	const rename = async (event: FormEvent) => {
		event.preventDefault();
		if (!renaming) return;
		setBusy(true);
		setError(null);
		const response = await getJSONResult(`/api/agents/${encodeURIComponent(renaming)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: renameValue }),
		});
		if (response.error) {
			setError(response.error);
			setBusy(false);
			return;
		}
		const confirmed = await getJSONResult<{ agents: readonly PersonalAgent[] }>("/api/agents");
		if (!confirmed.data?.agents.some((agent) => agent.id === renaming && agent.name === renameValue.trim()))
			setError(confirmed.error ?? "The renamed agent could not be confirmed. Refresh before retrying.");
		else {
			setRenaming(null);
			refresh();
			toast.success("Agent renamed");
		}
		setBusy(false);
	};
	const own =
		result?.data?.agents.filter((agent) => agent.kind === "personal" && agent.ownerUserId === whoami?.user.id) ?? [];
	return (
		<div className="flex flex-col gap-6">
			<form className="flex flex-col gap-4" onSubmit={submit}>
				<AuthField label="Agent name" name="agentName" value={name} onChange={setName} />
				<p className="m-0 text-small text-muted-foreground">
					Your organization’s personal-agent policy determines whether you can create an agent.
				</p>
				{error && (
					<p role="alert" className="text-small text-destructive">
						{error}
					</p>
				)}
				<Button type="submit" disabled={busy} className="self-start">
					Create personal agent
				</Button>
			</form>
			<Panel result={result} empty={own.length === 0} emptyMessage="No personal agents." onRetry={refresh}>
				{() => (
					<ul className="m-0 list-none divide-y p-0">
						{own.map((agent) => (
							<li className="py-4 text-small" key={agent.id}>
								<div className="flex items-center justify-between gap-3">
									<span>{agent.name}</span>
									<Button
										size="sm"
										variant="outline"
										disabled={busy || !canRename || Boolean(agent.archivedAt)}
										title={!canRename ? "Requires the modify permission" : undefined}
										onClick={() => {
											setRenaming(agent.id);
											setRenameValue(agent.name);
										}}
									>
										Rename
									</Button>
								</div>
								{renaming === agent.id && (
									<form className="my-3 flex flex-col gap-3" onSubmit={(event) => void rename(event)}>
										<label htmlFor="rename-agent" className="text-small">
											New agent name
										</label>
										<Input
											id="rename-agent"
											name="renameAgent"
											value={renameValue}
											required
											maxLength={128}
											disabled={busy}
											onChange={(event) => setRenameValue(event.target.value)}
										/>
										<div className="flex gap-3">
											<Button type="submit" disabled={busy}>
												Save agent name
											</Button>
											<Button type="button" variant="outline" onClick={() => setRenaming(null)}>
												Cancel
											</Button>
										</div>
									</form>
								)}
								<p className="m-0 text-muted-foreground">
									{agent.id}
									{agent.archivedAt ? " · Archived" : ""}
								</p>
							</li>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

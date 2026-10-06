import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Copy } from "@/components/mingcute-icons";
import { GroupLabel } from "@/components/settings/controls";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { type ApiKeyRecord, type ApiKeyRole, type CreatedApiKey, api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/use-async";

const ROLES: readonly { readonly value: ApiKeyRole; readonly label: string }[] = [
	{ value: "agent", label: "Agent: read and write memories" },
	{ value: "readonly", label: "Read-only: recall only" },
	{ value: "operator", label: "Operator: adds connectors and diagnostics" },
	{ value: "admin", label: "Admin: everything" },
];

const EXPIRY: readonly { readonly value: string; readonly label: string; readonly days: number | null }[] = [
	{ value: "90", label: "90 days", days: 90 },
	{ value: "30", label: "30 days", days: 30 },
	{ value: "365", label: "1 year", days: 365 },
	{ value: "never", label: "Never", days: null },
];

function formatDate(value: string | null): string {
	if (!value) return "never";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function keyStatus(key: ApiKeyRecord): string {
	if (key.revokedAt) return `Revoked ${formatDate(key.revokedAt)}`;
	if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return `Expired ${formatDate(key.expiresAt)}`;
	return key.expiresAt ? `Expires ${formatDate(key.expiresAt)}` : "No expiry";
}

function CreateKeyForm({ onCreated }: { onCreated: (key: CreatedApiKey) => void }) {
	const [name, setName] = useState("");
	const [role, setRole] = useState<ApiKeyRole>("agent");
	const [agentId, setAgentId] = useState("");
	const [expiry, setExpiry] = useState("90");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const days = EXPIRY.find((option) => option.value === expiry)?.days ?? null;
		const result = await api.createApiKey({
			name: name.trim(),
			role,
			agentId: agentId.trim() || undefined,
			expiresAt: days === null ? undefined : new Date(Date.now() + days * 86_400_000).toISOString(),
		});
		setBusy(false);
		if (!result.data?.apiKey?.key) {
			setError(result.error ?? "The key could not be created.");
			return;
		}
		setName("");
		setAgentId("");
		onCreated(result.data.apiKey);
	};

	return (
		<form className="grid gap-3 sm:grid-cols-2" onSubmit={submit} aria-label="Create an API key">
			<Field label="Name" htmlFor="api-key-name" hint="Name it after the person and device, like alice-laptop.">
				<Input
					id="api-key-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					maxLength={128}
					required
				/>
			</Field>
			<Field label="Role" htmlFor="api-key-role">
				<NativeSelect
					id="api-key-role"
					value={role}
					onChange={(event) => {
						const next = ROLES.find((option) => option.value === event.target.value);
						if (next) setRole(next.value);
					}}
				>
					{ROLES.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</NativeSelect>
			</Field>
			<Field label="Agent" htmlFor="api-key-agent" hint="Optional. Limits the key to one agent's memories.">
				<Input id="api-key-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} />
			</Field>
			<Field label="Expires" htmlFor="api-key-expiry">
				<NativeSelect id="api-key-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)}>
					{EXPIRY.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</NativeSelect>
			</Field>
			{error && (
				<p role="alert" className="m-0 text-small text-destructive sm:col-span-2">
					{error}
				</p>
			)}
			<div className="sm:col-span-2">
				<Button type="submit" size="compact" disabled={busy || !name.trim()}>
					{busy ? "Creating…" : "Create key"}
				</Button>
			</div>
		</form>
	);
}

function NewKeyNotice({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(created.key);
			toast("API key copied");
		} catch {
			toast("Copy failed. Select the key and copy it manually.");
		}
	};
	return (
		<div role="status" className="flex flex-col gap-2 rounded-lg border px-4 py-3">
			<p className="m-0 text-body font-medium">Copy the key for {created.name} now. It won't be shown again.</p>
			<div className="flex items-center gap-2">
				<code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-small select-all">
					{created.key}
				</code>
				<Button type="button" variant="outline" size="compact" onClick={() => void copy()}>
					<Copy aria-hidden="true" /> Copy
				</Button>
			</div>
			<p className="m-0 text-small text-muted-foreground">
				Send it through a secret manager. They can paste it on the dashboard sign-in screen or set it as{" "}
				<code className="font-mono">SIGNET_API_KEY</code> for the CLI and connectors.
			</p>
			<div>
				<Button type="button" variant="ghost" size="compact" onClick={onDone}>
					Done
				</Button>
			</div>
		</div>
	);
}

export function ApiKeysSection() {
	const session = useSession();
	const keys = useAsync(() => api.listApiKeys().then((result) => result.data), { key: "api-keys" });
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const [revoking, setRevoking] = useState<ApiKeyRecord | null>(null);
	const list = keys.data?.apiKeys ?? [];

	const revoke = async (key: ApiKeyRecord) => {
		setRevoking(null);
		const result = await api.revokeApiKey(key.id);
		toast(result.ok ? `Revoked ${key.name}` : (result.data?.error ?? `Could not revoke ${key.name}`));
		await keys.refresh();
	};

	return (
		<div className="flex flex-col gap-6">
			{session.kind === "open" && session.mode === "local" && (
				<p className="m-0 settings-row-description">
					This daemon is in local mode, so it doesn't check keys. They take effect once <code>auth.mode</code> is{" "}
					<code>team</code> or <code>hybrid</code>.
				</p>
			)}
			<section className="flex flex-col gap-3" aria-labelledby="api-keys-create">
				<GroupLabel>
					<span id="api-keys-create">Create a key</span>
				</GroupLabel>
				{created ? (
					<NewKeyNotice created={created} onDone={() => setCreated(null)} />
				) : (
					<CreateKeyForm
						onCreated={(key) => {
							setCreated(key);
							void keys.refresh();
						}}
					/>
				)}
			</section>
			<section className="flex flex-col gap-3" aria-labelledby="api-keys-list">
				<GroupLabel suffix={keys.data ? `· ${list.filter((key) => !key.revokedAt).length} active` : undefined}>
					<span id="api-keys-list">Keys</span>
				</GroupLabel>
				{keys.loading ? (
					<p className="m-0 settings-row-description">Loading keys…</p>
				) : keys.error ? (
					<p className="m-0 settings-row-description">{keys.error}</p>
				) : list.length === 0 ? (
					<p className="m-0 settings-row-description">No API keys yet.</p>
				) : (
					<ul className="m-0 flex list-none flex-col divide-y p-0">
						{list.map((key) => (
							<li key={key.id} className="flex items-center gap-3 py-2.5">
								<div className="min-w-0 flex-1">
									<p className="m-0 truncate text-body font-medium">
										{key.name} <span className="font-mono text-small text-muted-foreground">{key.prefix}</span>
									</p>
									<p className="m-0 truncate text-small text-muted-foreground">
										{key.role} · {key.agentId ? `agent ${key.agentId}` : "all agents"} · last used{" "}
										{formatDate(key.lastUsedAt)} · {keyStatus(key)}
									</p>
								</div>
								{!key.revokedAt && (
									<Button type="button" variant="outline" size="compact" onClick={() => setRevoking(key)}>
										Revoke
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</section>
			<ConfirmationDialog
				open={revoking !== null}
				onOpenChange={(open) => {
					if (!open) setRevoking(null);
				}}
				title={<>Revoke {revoking?.name}?</>}
				description={
					<>
						The key stops working right away for the CLI, connectors, and new sign-ins. A dashboard session already
						started with it lasts until it expires.
					</>
				}
				actions={
					<>
						<Button variant="outline" onClick={() => setRevoking(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (revoking) void revoke(revoking);
							}}
						>
							Revoke key
						</Button>
					</>
				}
			/>
		</div>
	);
}

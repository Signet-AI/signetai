import { type ReactNode, useEffect, useState } from "react";
import type {
	OperatorSettings,
	OperatorSettingsInput,
} from "../../../../../platform/daemon/src/operator-settings-contract";
import { AuthPage } from "@/components/shell/auth-entry";
import { Panel } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/field";
import { TextField } from "@/components/organization/controls";
import { AuthenticationContent } from "@/components/organization/authentication";
import { ClassificationsContent } from "@/components/organization/classifications";
import { CreateTeam } from "@/components/organization/teams";
import { SecretsSection } from "@/components/settings/secrets";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { getJSONResult, type ApiReadResult, type SignetSource } from "@/lib/api";
import type { OrganizationClassification, OrganizationGroup, OrganizationSettings } from "@/lib/organization";
import type { Whoami } from "@/lib/session";
import { useWhoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";
import { useView } from "@/lib/view-context";

const PATH = "/api/org/operator/settings";
export function OperatorOnboardingGate({
	whoami,
	children,
}: {
	readonly whoami: Whoami | null;
	readonly children: ReactNode;
}) {
	return whoami?.user.role === "admin" ? (
		<OperatorGate key={whoami.user.id} organizationName={whoami.organization.name}>
			{children}
		</OperatorGate>
	) : (
		children
	);
}
function OperatorGate({
	organizationName,
	children,
}: {
	readonly organizationName: string;
	readonly children: ReactNode;
}) {
	const { result, refresh } = usePanelQuery<OperatorSettings>(PATH);
	const { setView, setSetupComplete } = useView();
	const [finished, setFinished] = useState(false);
	const [settings, setSettings] = useState<OperatorSettings | null>(null);
	useEffect(() => {
		if (result?.data) setSettings(result.data);
	}, [result]);
	if (finished || settings?.complete) return children;
	if (settings)
		return (
			<OperatorWizard
				settings={settings}
				organizationName={organizationName}
				onComplete={() => {
					setSetupComplete(true);
					setView("home");
					setFinished(true);
				}}
			/>
		);
	return (
		<AuthPage
			title="Set up your organization"
			organizationName={organizationName}
			description="Configure this instance once for your organization."
		>
			<Panel result={result} onRetry={refresh}>
				{() => null}
			</Panel>
		</AuthPage>
	);
}
export function OperatorSetup({
	organizationName,
	onComplete,
}: {
	readonly organizationName: string;
	readonly onComplete: () => void;
}) {
	const { result, refresh } = usePanelQuery<OperatorSettings>(PATH);
	return (
		<Panel result={result} onRetry={refresh}>
			{(settings) => <OperatorWizard settings={settings} organizationName={organizationName} onComplete={onComplete} />}
		</Panel>
	);
}
export function OperatorWizard({
	settings,
	organizationName,
	onComplete,
}: {
	readonly settings: OperatorSettings;
	readonly organizationName: string;
	readonly onComplete: () => void;
}) {
	const [step, setStep] = useState(0);
	const [draft, setDraft] = useState(settings);
	const [name, setName] = useState(organizationName);
	const [busy, setBusy] = useState(false);
	const [action, setAction] = useState<ApiReadResult<unknown> | null>(null);
	const [failed, setFailed] = useState(false);
	const titles = [
		"Organization",
		"Connection",
		"Search",
		"Organization instructions",
		"Teams and classifications",
		"Sources",
		"Invite people",
		"Summary",
	];
	const save = async () => {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		setAction(null);
		let input: OperatorSettingsInput | null = null;
		if (step === 1) input = { section: "inference", value: draft.inference };
		else if (step === 2) input = { section: "embedding", value: draft.embedding };
		else if (step === 3) input = { section: "instructions", value: draft.instructions };
		else if (step === 5) input = { section: "sourcesDefaults", value: draft.sourcesDefaults };
		else if (step === 7) input = { section: "complete", value: true };
		const result =
			step === 0
				? await getJSONResult("/api/org/settings", {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name }),
					})
				: await getJSONResult<OperatorSettings>(
						PATH,
						input
							? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
							: undefined,
					);
		setAction(result);
		if (!result.data || result.error) {
			setFailed(true);
			setBusy(false);
			return;
		}
		if (step === 7) {
			const readback = await getJSONResult<OperatorSettings>(PATH);
			setAction(readback);
			setBusy(false);
			if (readback.data?.complete) onComplete();
			else setFailed(true);
			return;
		}
		setBusy(false);
		setStep(step + 1);
	};
	const providers = ["none", "openai-compatible", "openai", "anthropic", "google", "openrouter"] as const;
	const embeddings = ["none", "native", "ollama", "llama-cpp", "openai"] as const;
	return (
		<AuthPage
			title={titles[step] ?? "Organization"}
			organizationName={organizationName}
			description={`Step ${step + 1} of ${titles.length} · Instance settings, not developer-machine setup.`}
		>
			{step === 0 ? (
				<div className="flex flex-col gap-4">
					<TextField label="Organization name" value={name} onChange={setName} />
					<p className="text-small">
						Keep the bootstrap administrator password for now, or configure SSO below. Keep password login enabled until
						SSO is working.
					</p>
					<OperatorAuthentication />
				</div>
			) : step === 1 ? (
				<div className="flex flex-col gap-4">
					<label className="flex flex-col gap-2 text-small" htmlFor="operator-provider">
						AI provider
					</label>
					<NativeSelect
						id="operator-provider"
						value={draft.inference.provider}
						disabled={busy}
						onChange={(event) => {
							const provider = providers.find((item) => item === event.target.value);
							if (provider) setDraft({ ...draft, inference: { ...draft.inference, provider } });
						}}
					>
						{providers.map((provider) => (
							<option key={provider} value={provider}>
								{provider === "none" ? "Set up inference later" : provider}
							</option>
						))}
					</NativeSelect>
					<TextField
						label="AI model"
						value={draft.inference.model}
						onChange={(model) => setDraft({ ...draft, inference: { ...draft.inference, model } })}
					/>
					<TextField
						label="Model endpoint"
						value={draft.inference.endpoint ?? ""}
						onChange={(endpoint) =>
							setDraft({ ...draft, inference: { ...draft.inference, endpoint: endpoint || null } })
						}
					/>
					<TextField
						label="Provider secret reference"
						value={draft.inference.credentialRef ?? ""}
						onChange={(credentialRef) =>
							setDraft({ ...draft, inference: { ...draft.inference, credentialRef: credentialRef || null } })
						}
					/>
					<label className="flex items-start gap-2 text-small">
						<input
							type="checkbox"
							checked={draft.inference.allowRemote}
							onChange={(event) =>
								setDraft({ ...draft, inference: { ...draft.inference, allowRemote: event.target.checked } })
							}
						/>
						Allow organization evidence to be sent to this remote inference provider.
					</label>
					<p className="text-small">
						Store API keys in Secrets below. Enter only their secret names above; keys are never written to
						configuration or URLs.
					</p>
					<SecretsSection />
				</div>
			) : step === 2 ? (
				<div className="flex flex-col gap-4">
					<label className="text-small" htmlFor="operator-embedding">
						Embedding profile
					</label>
					<NativeSelect
						id="operator-embedding"
						value={draft.embedding.provider}
						disabled={busy}
						onChange={(event) => {
							const provider = embeddings.find((item) => item === event.target.value);
							if (provider) setDraft({ ...draft, embedding: { ...draft.embedding, provider } });
						}}
					>
						{embeddings.map((provider) => (
							<option key={provider} value={provider}>
								{provider === "none" ? "Keyword search only" : provider}
							</option>
						))}
					</NativeSelect>
					<TextField
						label="Embedding model"
						value={draft.embedding.model}
						onChange={(model) => setDraft({ ...draft, embedding: { ...draft.embedding, model } })}
					/>
					<TextField
						label="Embedding dimensions"
						type="number"
						value={String(draft.embedding.dimensions)}
						onChange={(dimensions) =>
							setDraft({ ...draft, embedding: { ...draft.embedding, dimensions: Number(dimensions) } })
						}
					/>
					<TextField
						label="Embedding endpoint"
						value={draft.embedding.endpoint ?? ""}
						onChange={(endpoint) =>
							setDraft({ ...draft, embedding: { ...draft.embedding, endpoint: endpoint || null } })
						}
					/>
					<TextField
						label="Embedding secret reference"
						value={draft.embedding.credentialRef ?? ""}
						onChange={(credentialRef) =>
							setDraft({ ...draft, embedding: { ...draft.embedding, credentialRef: credentialRef || null } })
						}
					/>
					<p className="text-small">
						Hosted embeddings send evidence to that endpoint. Secret values belong in Secrets. A changed profile may
						require the existing index transition to finish before semantic search uses it; keyword search remains
						available.
					</p>
					<SecretsSection />
				</div>
			) : step === 3 ? (
				<div className="flex flex-col gap-3 text-small">
					<label htmlFor="operator-instructions">Company conventions and how your organization works</label>
					<textarea
						id="operator-instructions"
						aria-describedby="operator-instructions-hint"
						className="min-h-48 rounded-md border bg-background p-3"
						maxLength={65536}
						value={draft.instructions}
						onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
					/>
					<p id="operator-instructions-hint">
						These are the organization agent's AGENTS.md instructions, not a developer's personal profile.
					</p>
				</div>
			) : step === 4 ? (
				<OperatorTeams />
			) : step === 5 ? (
				<OperatorSources
					defaults={draft.sourcesDefaults}
					onChange={(sourcesDefaults) => setDraft({ ...draft, sourcesDefaults })}
				/>
			) : step === 6 ? (
				<OperatorInvites />
			) : (
				<div className="flex flex-col gap-3 text-small">
					<p>Organization: {name}</p>
					<p>
						Inference: {draft.inference.provider} · {draft.inference.model || "Not configured"}
					</p>
					<p>
						Search: {draft.embedding.provider} · {draft.embedding.model || "Keyword search"}
					</p>
					<p>
						Settings are saved on this instance. Members configure their own harnesses after joining. No server
						harnesses or sample memories were created.
					</p>
				</div>
			)}
			{(busy || failed) && (
				<Panel result={action} onRetry={() => void save()}>
					{() => <p role="status">Verifying saved settings…</p>}
				</Panel>
			)}
			<div className="flex flex-wrap gap-3">
				{step > 0 && (
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => {
							setFailed(false);
							setStep(step - 1);
						}}
					>
						Back
					</Button>
				)}
				<Button disabled={busy || !name.trim()} onClick={() => void save()}>
					{busy ? "Saving…" : step === 7 ? "Finish instance setup" : "Save and continue"}
				</Button>
			</div>
		</AuthPage>
	);
}
function OperatorAuthentication() {
	const [open, setOpen] = useState(false);
	const { result, refresh } = usePanelQuery<OrganizationSettings>("/api/org/settings");
	return (
		<div className="flex flex-col gap-3">
			<Button variant="outline" className="self-start" onClick={() => setOpen(!open)}>
				{open ? "Keep bootstrap password for now" : "Configure SSO (optional)"}
			</Button>
			{open && (
				<Panel result={result} onRetry={refresh}>
					{(settings) => (
						<>
							<SecretsSection />
							<AuthenticationContent settings={settings} groups={[]} refresh={refresh} />
						</>
					)}
				</Panel>
			)}
		</div>
	);
}
function OperatorTeams() {
	const whoami = useWhoami();
	const teams = usePanelQuery<{ groups: readonly OrganizationGroup[] }>("/api/org/groups");
	const classifications = usePanelQuery<readonly OrganizationClassification[]>("/api/classifications");
	return (
		<div className="flex flex-col gap-6">
			<p className="text-small">
				Optional. Create your first teams and classifications now, or return to the admin pages later.
			</p>
			<Panel
				result={teams.result}
				onRetry={teams.refresh}
				empty={teams.result?.data?.groups.length === 0}
				emptyMessage="No teams yet. Create one below or continue."
			>
				{({ groups }) => (
					<ul>
						{groups.map((group) => (
							<li key={group.id}>{group.name}</li>
						))}
					</ul>
				)}
			</Panel>
			<CreateTeam refresh={teams.refresh} />
			<Panel result={classifications.result} onRetry={classifications.refresh}>
				{(rows) => (
					<ClassificationsContent
						classifications={rows}
						canManage={whoami?.user.compliance === true}
						refresh={classifications.refresh}
					/>
				)}
			</Panel>
			{!whoami?.user.compliance && (
				<p className="text-small">
					Creating classifications requires the compliance flag. An administrator can assign it on the Users page;
					administrator status alone does not grant classified access.
				</p>
			)}
		</div>
	);
}
function OperatorSources({
	defaults,
	onChange,
}: {
	readonly defaults: OperatorSettings["sourcesDefaults"];
	readonly onChange: (value: OperatorSettings["sourcesDefaults"]) => void;
}) {
	const [open, setOpen] = useState(false);
	const agents = usePanelQuery<{ agents: readonly { id: string; name: string; canActAs: boolean }[] }>("/api/agents");
	const classifications = usePanelQuery<readonly OrganizationClassification[]>("/api/classifications");
	const sources = usePanelQuery<{ sources: readonly SignetSource[] }>("/api/sources");
	return (
		<div className="flex flex-col gap-4">
			<p className="text-small">
				Choose the owning agent and classification for each organization or team source. These defaults seed the source
				dialog; the sources owner checks access again before writing.
			</p>
			<Panel result={agents.result} onRetry={agents.refresh}>
				{({ agents: rows }) => (
					<label htmlFor="operator-source-agent" className="flex flex-col gap-2 text-small">
						Default source agent
						<NativeSelect
							id="operator-source-agent"
							value={defaults.agentId}
							onChange={(event) => onChange({ ...defaults, agentId: event.target.value })}
						>
							{rows
								.filter((agent) => agent.canActAs)
								.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
						</NativeSelect>
					</label>
				)}
			</Panel>
			<Panel result={classifications.result} onRetry={classifications.refresh}>
				{(rows) => (
					<label htmlFor="operator-source-label" className="flex flex-col gap-2 text-small">
						Default source classification
						<NativeSelect
							id="operator-source-label"
							value={defaults.classificationId ?? ""}
							onChange={(event) => onChange({ ...defaults, classificationId: event.target.value || null })}
						>
							<option value="">Unclassified</option>
							{rows.map((row) => (
								<option key={row.id} value={row.id}>
									{row.name}
								</option>
							))}
						</NativeSelect>
					</label>
				)}
			</Panel>
			<Panel
				result={sources.result}
				onRetry={sources.refresh}
				empty={sources.result?.data?.sources.length === 0}
				emptyMessage="No sources yet. Connect shared documents now or continue."
			>
				{({ sources: rows }) => (
					<ul>
						{rows.map((source) => (
							<li key={source.id}>{source.name}</li>
						))}
					</ul>
				)}
			</Panel>
			<Button className="self-start" variant="outline" onClick={() => setOpen(true)}>
				Connect a source
			</Button>
			{open && (
				<ConnectSourceDialog
					open
					onClose={() => setOpen(false)}
					onConnected={sources.refresh}
					initialAgentId={defaults.agentId}
					initialClassificationId={defaults.classificationId ?? "none"}
				/>
			)}
		</div>
	);
}
function OperatorInvites() {
	const [email, setEmail] = useState("");
	const [invite, setInvite] = useState<string | null>(null);
	const [status, setStatus] = useState<ApiReadResult<unknown> | null>(null);
	const [busy, setBusy] = useState(false);
	const create = async () => {
		setBusy(true);
		setInvite(null);
		const result = await getJSONResult<{ inviteUrl: string }>("/api/org/invites", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role: "member", groupIds: [], ...(email.trim() ? { email: email.trim() } : {}) }),
		});
		setBusy(false);
		setStatus(result);
		setInvite(result.data?.inviteUrl ?? null);
	};
	return (
		<div className="flex flex-col gap-4 text-small">
			<p>
				Signet does not send email. Copy each one-time invitation link and send it yourself. For SSO, allowed email
				domains let people join on their first sign-in.
			</p>
			<TextField label="Invitation email (optional)" type="email" value={email} onChange={setEmail} />
			<Button variant="outline" className="self-start" disabled={busy} onClick={() => void create()}>
				Create invitation
			</Button>
			{status?.error && <Panel result={status}>{() => null}</Panel>}
			{invite && (
				<div className="flex flex-col gap-3">
					<label htmlFor="operator-invite">
						One-time invitation link
						<input
							id="operator-invite"
							type="password"
							readOnly
							value={invite}
							className="w-full rounded-md border bg-background p-3"
						/>
					</label>
					<Button
						variant="outline"
						className="self-start"
						onClick={() =>
							void navigator.clipboard
								.writeText(invite)
								.then(() => setInvite(null))
								.catch(() => setStatus({ data: null, error: "Could not copy the invitation. Try again.", status: 0 }))
						}
					>
						Copy invitation link
					</Button>
					<p>This link is shown only here. Leaving this step discards it.</p>
				</div>
			)}
		</div>
	);
}

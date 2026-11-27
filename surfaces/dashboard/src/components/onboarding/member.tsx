import { PersonalMemoryCopy } from "./personal-copy";
import { type ReactNode, useEffect, useState } from "react";
import { AuthField, AuthPage } from "@/components/shell/auth-entry";
import { Panel } from "@/components/shell/panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getJSONResult } from "@/lib/api";
import type { OrganizationAgent } from "@/lib/organization";
import type { Whoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";

export interface MemberOnboardingStatus {
	readonly version: string;
	readonly acknowledged: boolean;
	readonly complete: boolean;
}

export function OrganizationOnboardingGate({
	whoami,
	children,
}: {
	readonly whoami: Whoami | null;
	readonly children: ReactNode;
}) {
	if (!whoami || whoami.user.role === "admin" || whoami.user.role === "operator") return children;
	return (
		<MemberGate key={whoami.user.id} whoami={whoami}>
			{children}
		</MemberGate>
	);
}

function MemberGate({ whoami, children }: { readonly whoami: Whoami; readonly children: ReactNode }) {
	const { result, refresh } = usePanelQuery<MemberOnboardingStatus>("/api/auth/onboarding");
	const [status, setStatus] = useState<MemberOnboardingStatus | null>(null);
	const [finished, setFinished] = useState(false);
	useEffect(() => {
		if (result?.data) setStatus(result.data);
	}, [result]);
	if (finished || status?.complete) return children;
	if (status) return <MemberOnboarding whoami={whoami} status={status} onComplete={() => setFinished(true)} />;
	return (
		<AuthPage
			title="Join your organization"
			organizationName={whoami.organization.name}
			description="Checking your onboarding progress."
		>
			<Panel result={result} onRetry={refresh}>
				{() => null}
			</Panel>
		</AuthPage>
	);
}

export function MemberSetup({ whoami, onComplete }: { readonly whoami: Whoami; readonly onComplete: () => void }) {
	const { result, refresh } = usePanelQuery<MemberOnboardingStatus>("/api/auth/onboarding");
	return (
		<Panel result={result} onRetry={refresh}>
			{(status) => <MemberOnboarding whoami={whoami} status={status} onComplete={onComplete} />}
		</Panel>
	);
}

export function MemberOnboarding({
	whoami,
	status,
	onComplete,
}: {
	readonly whoami: Whoami;
	readonly status: MemberOnboardingStatus;
	readonly onComplete: () => void;
}) {
	const [acknowledged, setAcknowledged] = useState(false);
	const [step, setStep] = useState(status.acknowledged ? 1 : 0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const acknowledge = async () => {
		if (!acknowledged || busy) return;
		setBusy(true);
		setError(null);
		const result = await getJSONResult<MemberOnboardingStatus>("/api/auth/onboarding", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "acknowledge", version: status.version }),
		});
		setBusy(false);
		if (result.data?.acknowledged) setStep(1);
		else setError(result.error ?? "Your acknowledgement was not recorded. Try again.");
	};
	const finish = async () => {
		if (busy) return;
		setBusy(true);
		const result = await getJSONResult<MemberOnboardingStatus>("/api/auth/onboarding", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "complete" }),
		});
		setBusy(false);
		if (result.data?.complete) onComplete();
		else setError(result.error ?? "Completion was not recorded. Try again.");
	};
	const titles = ["What's shared", "Your agents", "About you", "Connect your harnesses", "First memory", "Summary"];
	return (
		<AuthPage
			title={titles[step] ?? "Join your organization"}
			organizationName={whoami.organization.name}
			description={
				step === 0
					? "Understand the visibility model before connecting your harnesses."
					: `Step ${step + 1} of ${titles.length} · Your local workspace is never replaced.`
			}
		>
			{step === 0 ? (
				<div className="flex flex-col gap-6">
					<div className="flex flex-col gap-3 rounded-lg border p-4 text-small">
						<p>
							Your personal agent is yours to organize.{" "}
							<strong>The organization can read it unless it's hidden.</strong>
						</p>
						<p>
							Classifications control who can read a memory, session, or source. Only people in every applied
							classification's audience can read it. Administrators do not get an exception.
						</p>
						<p>
							Choosing a personal agent does not make its contents private. Review the destination and classifications
							before sharing sensitive information.
						</p>
					</div>
					<label className="flex items-start gap-3 text-small">
						<input
							type="checkbox"
							checked={acknowledged}
							onChange={(event) => setAcknowledged(event.target.checked)}
							className="mt-1"
						/>
						I understand what my organization can read and how classifications restrict access.
					</label>
					<Button className="self-start" disabled={!acknowledged || busy} onClick={() => void acknowledge()}>
						{busy ? "Recording acknowledgement…" : "I understand — continue"}
					</Button>
				</div>
			) : step === 1 ? (
				<MemberAgents whoami={whoami} onNext={() => setStep(2)} />
			) : step === 2 ? (
				<MemberProfile whoami={whoami} onNext={() => setStep(3)} />
			) : step === 3 ? (
				<MemberConnect onNext={() => setStep(4)} />
			) : step === 4 ? (
				<MemberFirstMemory whoami={whoami} onNext={() => setStep(5)} />
			) : (
				<div className="flex flex-col gap-4 text-small">
					<p>
						You're signed in to <strong>{whoami.organization.name}</strong> as {whoami.user.displayName}.
					</p>
					<p>
						Your sessions write to your personal agent. Organization memory is your default for reading. Classifications
						control access, including for administrators.
					</p>
					{whoami.agents.defaultWrite ? (
						<PersonalMemoryCopy agentId={whoami.agents.defaultWrite} />
					) : (
						<p>Your personal agent must be provisioned before copying evidence.</p>
					)}
					<Button className="self-start" disabled={busy} onClick={() => void finish()}>
						Open dashboard
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-small text-destructive">
					{error}
				</p>
			)}
		</AuthPage>
	);
}

function MemberAgents({ whoami, onNext }: { readonly whoami: Whoami; readonly onNext: () => void }) {
	const { result, refresh } = usePanelQuery<{ agents: readonly OrganizationAgent[] }>("/api/agents");
	return (
		<Panel
			result={result}
			onRetry={refresh}
			empty={result?.data?.agents.length === 0}
			emptyMessage="No agents are available. Ask your organization administrator to provision your personal agent."
		>
			{({ agents }) => (
				<div className="flex flex-col gap-4">
					{agents
						.filter(
							(agent) =>
								agent.id === whoami.agents.defaultWrite ||
								agent.id === whoami.agents.defaultRead ||
								(agent.kind === "team" && agent.canActAs),
						)
						.map((agent) => (
							<div
								key={agent.id}
								className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-small"
							>
								<span>{agent.name}</span>
								<Badge>
									{agent.id === whoami.agents.defaultWrite
										? "Session destination"
										: agent.id === whoami.agents.defaultRead
											? "Default for reading"
											: "Team agent"}
								</Badge>
							</div>
						))}
					<p className="text-small text-muted-foreground">
						Your personal agent is created for you. Your team agents are listed above. Organization memory is the
						default for reading.
					</p>
					<Button className="self-start" onClick={onNext}>
						Continue
					</Button>
				</div>
			)}
		</Panel>
	);
}

function MemberProfile({ whoami, onNext }: { readonly whoami: Whoami; readonly onNext: () => void }) {
	const { result, refresh } = usePanelQuery<{ editableFields: readonly string[] }>("/api/auth/profile");
	const [name, setName] = useState(whoami.user.displayName);
	const [preferences, setPreferences] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = async (editable: boolean) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		if (editable && name !== whoami.user.displayName) {
			const saved = await getJSONResult("/api/auth/profile", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ displayName: name }),
			});
			if (saved.error) {
				setError(saved.error);
				setBusy(false);
				return;
			}
		}
		if (preferences.trim()) {
			const saved = await getJSONResult("/api/memory/remember", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: preferences.trim(), agentId: whoami.agents.defaultWrite, type: "fact" }),
			});
			if (saved.error) {
				setError(saved.error);
				setBusy(false);
				return;
			}
		}
		setBusy(false);
		onNext();
	};
	return (
		<Panel result={result} onRetry={refresh}>
			{(profile) => (
				<div className="flex flex-col gap-4">
					{profile.editableFields.includes("displayName") ? (
						<AuthField name="member-name" label="Your name" value={name} onChange={setName} />
					) : (
						<p className="text-small">Your identity provider manages your name: {whoami.user.displayName}.</p>
					)}
					<label className="flex flex-col gap-2 text-small" htmlFor="member-preferences">
						Preferences and how you work (optional)
						<textarea
							id="member-preferences"
							className="min-h-28 w-full rounded-md border bg-background p-3 text-small"
							maxLength={4000}
							value={preferences}
							onChange={(event) => setPreferences(event.target.value)}
						/>
					</label>
					<p className="text-small text-muted-foreground">
						Preferences are saved as your evidence in your personal agent, not in a workspace-wide USER.md. Your
						organization's visibility rules apply.
					</p>
					{error && (
						<p role="alert" className="text-small text-destructive">
							{error}
						</p>
					)}
					<Button
						className="self-start"
						disabled={busy || !name.trim()}
						onClick={() => void save(profile.editableFields.includes("displayName"))}
					>
						Save and continue
					</Button>
				</div>
			)}
		</Panel>
	);
}

function useMemberPoll<T>(path: string) {
	const query = usePanelQuery<T>(path);
	useEffect(() => {
		const timer = setInterval(query.refresh, 2000);
		return () => clearInterval(timer);
	}, [query.refresh]);
	return query;
}

function MemberConnect({ onNext }: { readonly onNext: () => void }) {
	const { result, refresh } = useMemberPoll<{
		keys: readonly { id: string; harness: string | null; last_used_at: string | null; revoked_at: string | null }[];
	}>("/api/auth/connector-keys");
	return (
		<div className="flex flex-col gap-4 text-small">
			<p>Run these commands on your own computer, where your harnesses run:</p>
			<pre className="overflow-x-auto rounded-lg border p-4">
				<code>{`signet login ${location.origin}\nsignet connect`}</code>
			</pre>
			<p>
				Choose personal or organization for each detected harness. A harness uses one daemon at a time. Your local
				workspace stays in place, and no personal memories are copied automatically.
			</p>
			<Panel result={result} onRetry={refresh}>
				{({ keys }) => {
					const used = keys.filter((key) => key.last_used_at && !key.revoked_at);
					return (
						<div className="flex flex-col gap-4">
							{used.length ? (
								<p role="status">
									<Badge>Connected</Badge> Your first connector has been used: {used[0]?.harness ?? "harness"}.
								</p>
							) : (
								<p role="status">
									Waiting for your first connector to be used. Open your harness and send a prompt; this screen updates
									automatically.
								</p>
							)}
							<Button className="self-start" disabled={!used.length} onClick={onNext}>
								Continue
							</Button>
						</div>
					);
				}}
			</Panel>
		</div>
	);
}

function MemberFirstMemory({ whoami, onNext }: { readonly whoami: Whoami; readonly onNext: () => void }) {
	const [started] = useState(() => Date.now());
	const path = `/api/memories?agentId=${encodeURIComponent(whoami.agents.defaultWrite ?? "")}&author=${encodeURIComponent(whoami.user.id)}&limit=20`;
	const { result, refresh } = useMemberPoll<{
		memories: readonly { id: string; content: string; created_at: string }[];
	}>(path);
	const observed = result?.data?.memories.find((memory) => Date.parse(memory.created_at) >= started);
	return (
		<div className="flex flex-col gap-4 text-small">
			<p>In your connected harness, ask Signet to remember something. For example:</p>
			<blockquote className="rounded-lg border p-4">
				Remember that I prefer concise code reviews with runnable examples.
			</blockquote>
			<p>We watch your personal agent for a new memory. Nothing is written by this screen.</p>
			<Panel
				result={result}
				onRetry={refresh}
				empty={!observed}
				emptyMessage="Waiting for a new memory from your harness…"
			>
				{() => (
					<div role="status" className="rounded-lg border p-4">
						<Badge>Memory received</Badge>
						<p className="mt-3 whitespace-pre-wrap break-words">{observed?.content}</p>
					</div>
				)}
			</Panel>
			<div className="flex flex-wrap gap-3">
				<Button disabled={!observed} onClick={onNext}>
					Continue
				</Button>
				<Button variant="outline" onClick={onNext}>
					Skip for now
				</Button>
			</div>
		</div>
	);
}

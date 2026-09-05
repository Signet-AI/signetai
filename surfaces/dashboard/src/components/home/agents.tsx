import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, UserRound } from "@/components/mingcute-icons";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { api, type Agent } from "@/lib/api";
import { useAsync } from "@/lib/use-async";

const policies = ["isolated", "shared", "group"] as const;
type Policy = (typeof policies)[number];
type Draft = { policy: Policy; group: string };

const POLICY_LABELS: Record<Policy, string> = {
	isolated: "Private",
	shared: "Shared",
	group: "Group",
};

function ScopeBadge({ children }: { children: string }) {
	return (
		<span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
			{children}
		</span>
	);
}

/**
 * Home owns the agent workflow. Keep the roster compact and defer scope
 * controls to native disclosure rows, matching the source drill-down pattern.
 */
export function HomeAgentsPanel({ activeAgentId }: { activeAgentId?: string }) {
	const rosterRef = useRef<HTMLElement>(null);
	const identityQuery = useAsync(() => api.getIdentity(), { intervalMs: 30000 });
	const agentsQuery = useAsync(async () => (await api.getAgents()).data?.agents ?? null, { intervalMs: 30000 });
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft>({ policy: "isolated", group: "" });
	const [pending, setPending] = useState<{ agent: Agent; draft: Draft } | null>(null);
	const [confirmation, setConfirmation] = useState<Agent | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const agents = agentsQuery.data;

	const beginEdit = (agent: Agent) => {
		setEditing(agent.name);
		setDraft({ policy: agent.read_policy, group: agent.policy_group ?? "" });
		setConfirmation(null);
		setError(null);
	};

	const confirmEdit = async () => {
		if (!pending) return;
		setSaving(true);
		setError(null);
		const result = await api.updateAgentScope(
			pending.agent.name,
			pending.draft.policy,
			pending.draft.group || undefined,
		);
		setSaving(false);
		if (result.error || !result.data) {
			setError(result.error ?? "Unable to update the agent. Try again.");
			return;
		}
		setPending(null);
		setEditing(null);
		setConfirmation(result.data);
		await agentsQuery.refresh();
	};

	return (
		<>
			<section ref={rosterRef} className="py-2.5" aria-labelledby="home-agents-title">
				<div className="flex items-center justify-between gap-2.5">
					<span id="home-agents-title" className="text-[15px] font-semibold tracking-tight text-foreground">
						Agents
					</span>
					{agents?.some((agent) => agent.name !== "default") && (
						<button
							type="button"
							className="home-text-action"
							onClick={() => {
								const agent = agents.find((candidate) => candidate.name !== "default");
								if (!agent) return;
								const row = Array.from(rosterRef.current?.querySelectorAll("details") ?? []).find(
									(candidate) => candidate.dataset.agentId === agent.id,
								);
								if (row) row.open = true;
								beginEdit(agent);
							}}
						>
							Manage <ArrowRight className="size-3.5" />
						</button>
					)}
				</div>

				{error && (
					<div
						role="alert"
						className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-destructive"
					>
						<span className="truncate" title={error}>
							{error}
						</span>
						<button type="button" className="shrink-0 underline" onClick={() => void agentsQuery.refresh()}>
							Retry
						</button>
					</div>
				)}

				{agentsQuery.loading && agents === null ? (
					<div className="grid min-h-[48px] place-items-center">
						<span className="font-mono text-[10px] text-muted-foreground">Loading agents…</span>
					</div>
				) : agents === null ? (
					<div className="flex min-h-[48px] items-center justify-center gap-2 text-center">
						<span className="font-mono text-[10px] text-muted-foreground">Unable to load agents.</span>
						<button type="button" className="home-text-action shrink-0" onClick={() => void agentsQuery.refresh()}>
							Retry
						</button>
					</div>
				) : agents.length === 0 ? (
					<div className="grid min-h-[48px] place-items-center text-center">
						<span className="font-mono text-[10px] text-muted-foreground">No agents registered yet.</span>
					</div>
				) : (
					<div className="mt-1.5 divide-y divide-border">
						{agents.map((agent) => (
							<AgentDisclosure
								key={agent.id}
								agent={agent}
								active={agent.id === activeAgentId}
								displayName={
									(agent.name === "default" || agent.id === activeAgentId) &&
									identityQuery.data?.name &&
									identityQuery.data.name !== "Unknown"
										? identityQuery.data.name
										: agent.name
								}
								editing={editing === agent.name}
								draft={draft}
								saving={saving}
								onBeginEdit={() => beginEdit(agent)}
								onDraftChange={setDraft}
								onConfirm={() => setPending({ agent, draft })}
								onCancel={() => setEditing(null)}
							/>
						))}
					</div>
				)}
			</section>

			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open && !saving) setPending(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Confirm access change</DialogTitle>
						<DialogDescription>
							Set <strong>{pending?.agent.name}</strong>'s memory access to{" "}
							<ScopeBadge>{pending ? POLICY_LABELS[pending.draft.policy] : ""}</ScopeBadge>
							{pending?.draft.policy === "group" && pending.draft.group ? (
								<>
									{" "}
									in <ScopeBadge>{pending.draft.group}</ScopeBadge>
								</>
							) : null}
							? Signet will apply the effective scope after you save.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							disabled={saving}
							onClick={() => setPending(null)}
							className="rounded border border-border px-3 py-1 text-sm"
						>
							Cancel
						</button>
						<button
							type="button"
							disabled={saving}
							onClick={() => void confirmEdit()}
							className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
						>
							{saving ? "Saving…" : "Save access change"}
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{confirmation && (
				<div role="status" className="mt-2 font-mono text-[10px] text-muted-foreground">
					Saved access for <strong>{confirmation.name}</strong>; effective scope: {confirmation.effective_scope ?? "unknown"}
				</div>
			)}
		</>
	);
}

function AgentDisclosure({
	agent,
	active,
	displayName,
	editing,
	draft,
	saving,
	onBeginEdit,
	onDraftChange,
	onConfirm,
	onCancel,
}: {
	agent: Agent;
	active: boolean;
	displayName: string;
	editing: boolean;
	draft: Draft;
	saving: boolean;
	onBeginEdit: () => void;
	onDraftChange: (draft: Draft) => void;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const canEdit = agent.name !== "default";
	const policyRef = useRef<HTMLSelectElement>(null);
	useEffect(() => {
		if (editing) policyRef.current?.focus();
	}, [editing]);

	return (
		<details className="group/agent" data-agent-id={agent.id}>
			<summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
				<span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
					<UserRound className="size-3" aria-hidden="true" />
				</span>
				<span className="min-w-0 flex-1 truncate text-[12px] font-medium">
					{displayName}
				</span>
				{active && (
					<span className="flex shrink-0 items-center gap-1 font-mono text-[9.5px] text-success">
						<span className="size-1.5 rounded-full bg-success" />
						Active
					</span>
				)}
				<ScopeBadge>{POLICY_LABELS[agent.read_policy]}</ScopeBadge>
				{agent.policy_group && <ScopeBadge>{agent.policy_group}</ScopeBadge>}
				<ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/agent:rotate-90" />
			</summary>
			<div className="home-agent-detail">
				<p>
					{canEdit ? "Access changes require confirmation." : "Memory access is managed by Signet."}
				</p>
				{agent.effective_scope && agent.effective_scope !== agent.read_policy && (
					<dl><dt>Effective scope</dt><dd>{agent.effective_scope}</dd></dl>
				)}

				{editing ? (
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<label className="font-mono text-[9.5px] text-muted-foreground" htmlFor={`agent-policy-${agent.id}`}>
							Scope
						</label>
						<select
							ref={policyRef}
							id={`agent-policy-${agent.id}`}
							aria-label={`Memory policy for ${agent.name}`}
							value={draft.policy}
							onChange={(event) => onDraftChange({ ...draft, policy: event.target.value as Policy })}
							className="h-7 rounded border border-input bg-background px-2 text-[11px]"
						>
							{policies.map((policy) => (
								<option key={policy} value={policy}>
									{policy}
								</option>
							))}
						</select>
						{draft.policy === "group" && (
							<input
								aria-label={`Policy group for ${agent.name}`}
								value={draft.group}
								onChange={(event) => onDraftChange({ ...draft, group: event.target.value })}
								placeholder="group name"
								className="h-7 w-28 rounded border border-input bg-background px-2 text-[11px]"
							/>
						)}
						<button
							type="button"
							disabled={saving}
							onClick={onConfirm}
							className="h-7 rounded bg-primary px-2.5 text-[11px] font-medium text-primary-foreground"
						>
							Review change
						</button>
						<button type="button" onClick={onCancel} className="h-7 px-1.5 text-[11px] text-muted-foreground underline">
							Cancel
						</button>
					</div>
				) : canEdit ? (
					<button
						type="button"
						onClick={onBeginEdit}
						className="home-text-action mt-1 h-7 text-[11px]"
					>
						Edit access
					</button>
				) : null}
			</div>
		</details>
	);
}

import { useEffect, useState } from "react";
import { api, type Agent } from "@/lib/api";

const policies = ["isolated", "shared", "group"] as const;
type Policy = (typeof policies)[number];

function ScopeBadge({ children }: { children: string }) {
	return <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[11px]">{children}</span>;
}

export function AgentsView() {
	const [agents, setAgents] = useState<Agent[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState<{ policy: Policy; group: string }>({ policy: "isolated", group: "" });
	const [saving, setSaving] = useState(false);
	const [confirmation, setConfirmation] = useState<Agent | null>(null);

	const load = async () => {
		const result = await api.getAgents();
		if (result.error || !result.data) {
			setError(result.error ?? "Agent roster unavailable");
			return;
		}
		setError(null);
		setAgents(result.data.agents);
	};
	useEffect(() => { void load(); }, []);

	const beginEdit = (agent: Agent) => {
		setEditing(agent.name);
		setDraft({ policy: agent.read_policy, group: agent.policy_group ?? "" });
		setConfirmation(null);
	};
	const save = async (agent: Agent) => {
		setSaving(true);
		const result = await api.updateAgentScope(agent.name, draft.policy, draft.group || undefined);
		setSaving(false);
		if (result.error || !result.data) { setError(result.error ?? "Agent update failed"); return; }
		setEditing(null);
		setConfirmation(result.data);
		await load();
	};

	return <section className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto" aria-labelledby="agents-title">
		<header><p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">System</p><h1 id="agents-title" className="text-xl font-semibold tracking-tight">Agents</h1><p className="mt-1 text-sm text-muted-foreground">Daemon-owned memory policy and group access.</p></header>
		{error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error} <button className="ml-2 underline" onClick={() => void load()}>Retry</button></div>}
		{confirmation && <div role="status" className="rounded-md border border-border bg-muted/50 p-3 text-sm">Saved <strong>{confirmation.name}</strong>: daemon resolved scope to <ScopeBadge>{confirmation.effective_scope ?? "unknown"}</ScopeBadge>{confirmation.policy_group ? <> in <ScopeBadge>{confirmation.policy_group}</ScopeBadge></> : null}</div>}
		{agents === null && !error && <p className="text-sm text-muted-foreground">Loading agents…</p>}
		{agents?.length === 0 && <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No agents registered with the daemon.</div>}
		{agents && agents.length > 0 && <div className="overflow-hidden rounded-lg border border-border"><div className="divide-y divide-border">{agents.map((agent) => <article key={agent.id} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-[180px] flex-1"><h2 className="font-medium">{agent.name}</h2><p className="font-mono text-xs text-muted-foreground">{agent.id}</p></div><div className="flex items-center gap-2"><ScopeBadge>{agent.read_policy}</ScopeBadge>{agent.policy_group && <ScopeBadge>{agent.policy_group}</ScopeBadge>} {agent.effective_scope && <span className="text-xs text-muted-foreground">effective: {agent.effective_scope}</span>}</div>{editing === agent.name ? <div className="flex w-full flex-wrap items-center gap-2 border-t border-border pt-3"><select aria-label={`Memory policy for ${agent.name}`} value={draft.policy} onChange={(e) => setDraft({ ...draft, policy: e.target.value as Policy })} className="rounded border border-input bg-background px-2 py-1 text-sm">{policies.map((policy) => <option key={policy}>{policy}</option>)}</select>{draft.policy === "group" && <input aria-label={`Policy group for ${agent.name}`} value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} placeholder="group name" className="rounded border border-input bg-background px-2 py-1 text-sm" /> }<button disabled={saving} onClick={() => void save(agent)} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">{saving ? "Saving…" : "Confirm"}</button><button onClick={() => setEditing(null)} className="px-2 py-1 text-sm underline">Cancel</button></div> : <button onClick={() => beginEdit(agent)} className="rounded border border-border px-3 py-1 text-sm hover:bg-muted">Edit scope</button>}</article>)}</div></div>}
	</section>;
}
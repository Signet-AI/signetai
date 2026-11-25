import type { Principal } from "./principal";

export interface AgentRecord {
	readonly id: string;
	readonly kind: "legacy" | "personal" | "team" | "organization";
	readonly owner_user_id: string | null;
	readonly owner_group_id: string | null;
	readonly archived_at: string | null;
}
export interface OrganizationSettings {
	readonly agentModel: "personal" | "single";
	readonly personalAgentsSelfService: boolean;
	readonly organizationAgentId: string;
	readonly personalAgentId: string | null;
	readonly defaultReadAgentId: string | null;
	readonly agents: readonly AgentRecord[];
}
export interface Forbidden {
	readonly status: 400 | 403;
	readonly reason: string;
	readonly error: string;
}
export type Result<T, E = Forbidden> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };
const access = new WeakMap<Principal, OrganizationSettings>();
export function bindPrincipalAccess(p: Principal, settings: OrganizationSettings): void {
	access.set(p, settings);
}
export function principalAccess(p: Principal): OrganizationSettings | undefined {
	return access.get(p);
}
function denied(reason: string, status: 400 | 403 = 403): Result<never> {
	return { ok: false, error: { status, reason, error: reason.replaceAll("_", " ") } };
}

export function canActAs(p: Principal, agent: AgentRecord): boolean {
	if (agent.archived_at) return false;
	if (p.kind === "local") return true;
	if (agent.kind === "legacy")
		return p.role === "admin" || (p.credential.kind === "api_key" && p.boundAgentId === agent.id);
	if (p.kind !== "user") return agent.kind === "organization" && p.credential.kind === "api_key";
	if (agent.kind === "organization") return true;
	if (agent.kind === "personal") return agent.owner_user_id === p.userId;
	return agent.owner_group_id !== null && p.groupIds.includes(agent.owner_group_id);
}
export function reconcileAgentSources(sources: readonly (string | undefined)[]): Result<string | undefined> {
	const values = [...new Set(sources.map((s) => s?.trim()).filter((s): s is string => Boolean(s)))];
	if (values.length > 1) return denied("agent_conflict", 400);
	return { ok: true, value: values[0] };
}
function boundTarget(p: Principal, requested: string | undefined): Result<string | undefined> {
	if (p.boundAgentId && requested && p.boundAgentId !== requested) return denied("agent_binding_conflict");
	return { ok: true, value: requested ?? p.boundAgentId ?? undefined };
}
export function resolveWriteAgent(
	p: Principal,
	requested: string | undefined,
	org: OrganizationSettings,
): Result<string> {
	const target = boundTarget(p, requested);
	if (!target.ok) return target;
	let id =
		target.value ??
		(org.agentModel === "personal" && p.kind === "user" ? org.personalAgentId : org.organizationAgentId);
	if (!id) return denied("org_policy");
	const agent = org.agents.find((a) => a.id === id);
	if (!agent || !canActAs(p, agent)) return denied("agent_not_permitted");
	if (org.agentModel === "personal" && agent.kind === "organization" && p.kind === "user") {
		if (!org.personalAgentId) return denied("org_policy");
		id = org.personalAgentId;
		const personal = org.agents.find((a) => a.id === id);
		if (!personal || !canActAs(p, personal)) return denied("agent_not_permitted");
	}
	return { ok: true, value: id };
}
export function resolveReadAgent(p: Principal, requested: string | undefined): Result<string> {
	const target = boundTarget(p, requested);
	if (!target.ok) return target;
	const org = access.get(p);
	if (!org) return denied("org_policy");
	const id = target.value ?? org.defaultReadAgentId ?? org.organizationAgentId;
	const agent = org.agents.find((a) => a.id === id);
	if (!agent || agent.archived_at) return denied("agent_not_permitted");
	return { ok: true, value: id };
}
export function checkPrincipalProject(p: Principal, project: string | undefined): Result<undefined> {
	return project && p.allowedProjects && !p.allowedProjects.includes(project)
		? denied("project_not_permitted")
		: { ok: true, value: undefined };
}

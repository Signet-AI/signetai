import type { AgentRosterReadPolicy } from "@signet/core";
import type { Context } from "hono";
import { getAgentScope } from "./agent-id";
import { principalAccess, resolveReadAgent } from "./auth/agent-access";
import { IdentityError } from "./auth/organization-store";
import type { Principal } from "./auth/principal";
import { type AgentReach, type ReadScope, audienceSubjectFromPrincipal, resolveReadScope } from "./read-scope";

export function reachForPolicy(
	agentId: string,
	policy: { readonly readPolicy: AgentRosterReadPolicy; readonly policyGroup: string | null },
): AgentReach {
	if (policy.readPolicy === "shared") return { kind: "shared", agentId };
	if (policy.readPolicy === "group" && policy.policyGroup) return { kind: "group", agentId, group: policy.policyGroup };
	return { kind: "own", agentId };
}

async function localAgentReach(agentId: string): Promise<AgentReach> {
	return reachForPolicy(agentId, await getAgentScope(agentId));
}

export async function internalHookReadScope(agentId: string): Promise<ReadScope> {
	return { reach: await localAgentReach(agentId), compartments: "all", projects: null };
}

function organizationReach(principal: Principal, agentId: string): AgentReach {
	const agent = principalAccess(principal)?.agents.find((candidate) => candidate.id === agentId);
	return agent?.kind === "organization" && !agent.archived_at ? { kind: "all" } : { kind: "own", agentId };
}

export async function resolveHookReadScope(
	c: Context,
	agentId: string,
	options: { readonly useDefaultReadAgent?: boolean } = {},
): Promise<ReadScope> {
	const principal = c.get("principal");
	const organization = c.get("organization");
	if (organization && principal && options.useDefaultReadAgent) {
		const resolved = resolveReadAgent(principal, c.get("requestedOrganizationAgent"));
		if (!resolved.ok) throw new IdentityError(resolved.error.status, resolved.error.reason);
		agentId = resolved.value;
	}
	const reach = organization && principal ? organizationReach(principal, agentId) : await localAgentReach(agentId);
	const projects = principal?.allowedProjects ?? null;
	if (principal && (principal.kind === "local" || principal.userId))
		return await resolveReadScope({ reach, projects }, audienceSubjectFromPrincipal(principal));
	const reader = principal ? `${principal.credential.kind}:${principal.credential.id}` : "anonymous";
	return { reach, projects, compartments: [], inFlightUserId: `unauthenticated:${reader}` };
}

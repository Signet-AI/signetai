import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getAgentScope } from "../agent-id";
import { principalAccess, reconcileAgentSources, resolveReadAgent } from "../auth/agent-access";
import { audienceSubjectFromPrincipal, resolveReadScope, type ReadScope } from "../read-scope";
import { resolveScopedAgentId } from "./utils";

export async function resolveRouteReadScope(c: Context, requestedAgent?: string): Promise<ReadScope> {
	const principal = c.get("principal");
	if (c.get("organization")) {
		if (!principal) throw new HTTPException(401, { message: "missing_credential" });
		const requested = reconcileAgentSources([requestedAgent, c.get("requestedOrganizationAgent")]);
		if (!requested.ok) throw new HTTPException(requested.error.status, { message: requested.error.reason });
		const resolved = resolveReadAgent(principal, requested.value);
		if (!resolved.ok) throw new HTTPException(resolved.error.status, { message: resolved.error.reason });
		const access = principalAccess(principal);
		if (!access) throw new HTTPException(403, { message: "org_policy" });
		c.set("readAuditAgent", resolved.value);
		return resolveReadScope(
			{
				reach:
					resolved.value === access.organizationAgentId ? { kind: "all" } : { kind: "own", agentId: resolved.value },
				projects: principal.allowedProjects,
			},
			audienceSubjectFromPrincipal(principal),
		);
	}
	const resolved = resolveScopedAgentId(c, requestedAgent);
	if (resolved.error) throw new HTTPException(403, { message: resolved.error });
	const policy = await getAgentScope(resolved.agentId);
	const project = c.get("auth")?.claims?.scope.project;
	return {
		reach:
			policy.readPolicy === "shared"
				? { kind: "shared", agentId: resolved.agentId }
				: policy.readPolicy === "group" && policy.policyGroup
					? { kind: "group", agentId: resolved.agentId, group: policy.policyGroup }
					: { kind: "own", agentId: resolved.agentId },
		compartments: "all",
		projects: principal?.allowedProjects ?? (project ? [project] : null),
	};
}

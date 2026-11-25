import type { Context } from "hono";
import { getAgentScope, resolveDaemonAgentId } from "../agent-id";
import { principalAccess, resolveReadAgent } from "../auth/agent-access";
import { requirePermission } from "../auth";
import { audienceSubjectFromPrincipal, resolveReadScope, type ReadScope } from "../read-scope";
import { authConfig } from "./state";
import { parseOptionalString, resolveScopedAgentId, resolveScopedProject } from "./utils";

export async function resolveRouteReadScope(
	c: Context,
	options: {
		readonly agentId?: string;
		readonly project?: string;
		readonly allowAllAgents?: boolean;
		readonly memory?: boolean;
		readonly localGlobal?: boolean;
		readonly allReadable?: boolean;
	} = {},
): Promise<{ readonly agentId: string; readonly scope: ReadScope } | Response> {
	const requested =
		options.agentId ?? c.req.query("agentId") ?? c.req.query("agent_id") ?? c.req.header("x-signet-agent-id");
	const principal = c.get("principal");
	const organization = c.get("organization");
	let agentId: string;
	if (requested === "all") {
		if (!options.allowAllAgents) return c.json({ error: "this route does not support an all-agents view" }, 400);
		const denied = await requirePermission("admin", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;
		if (organization && principal?.boundAgentId)
			return c.json({ error: "agent binding conflict", reason: "agent_binding_conflict" }, 403);
		agentId = "all";
	} else if (organization && principal) {
		const result = resolveReadAgent(principal, c.get("requestedOrganizationAgent") ?? requested);
		if (!result.ok) return c.json({ error: result.error.error, reason: result.error.reason }, result.error.status);
		agentId = result.value;
	} else {
		const sessionKey = c.req.query("sessionKey") ?? c.req.query("session_key") ?? c.req.header("x-signet-session-key");
		const sessionAgent = sessionKey?.startsWith("agent:") ? parseOptionalString(sessionKey.split(":")[1]) : undefined;
		const result = resolveScopedAgentId(c, parseOptionalString(requested) ?? sessionAgent, resolveDaemonAgentId());
		if (result.error) return c.json({ error: result.error }, 403);
		agentId = result.agentId;
	}
	const project = resolveScopedProject(c, options.project ?? c.req.query("project"));
	if (project.error) return c.json({ error: project.error, reason: project.error }, 403);
	const tokenProject = parseOptionalString(c.get("auth")?.claims?.scope.project);
	const projects = project.project
		? [project.project]
		: organization
			? (principal?.allowedProjects ?? null)
			: tokenProject
				? [tokenProject]
				: null;
	if (organization) {
		if (!principal) return c.json({ error: "unauthorized" }, 401);
		const agent = principalAccess(principal)?.agents.find((entry) => entry.id === agentId);
		const reach =
			agentId === "all" ||
			agent?.kind === "organization" ||
			(options.allReadable && !requested && !principal.boundAgentId)
				? { kind: "all" as const }
				: { kind: "own" as const, agentId };
		const scope = await resolveReadScope({ reach, projects }, audienceSubjectFromPrincipal(principal));
		c.set("readAuditAgent", agentId);
		return { agentId, scope };
	}
	const policy = await getAgentScope(agentId);
	const reach =
		agentId === "all"
			? { kind: "all" as const }
			: options.localGlobal || (options.memory && policy.readPolicy === "shared")
				? { kind: "shared" as const, agentId }
				: options.memory && policy.readPolicy === "group" && policy.policyGroup
					? { kind: "group" as const, agentId, group: policy.policyGroup }
					: { kind: "own" as const, agentId };
	return { agentId, scope: await resolveReadScope({ reach, projects }, { local: true, userId: null, groupIds: [] }) };
}

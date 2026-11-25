import { expect, test } from "bun:test";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import type { OrganizationRow } from "../auth/organization-store";
import { localPrincipal, type Principal } from "../auth/principal";
import { resolveRouteReadScope } from "./read-scope";

function app(principal: Principal, requested?: string): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("principal", principal);
		const organization: OrganizationRow = {
			id: 1,
			name: "Test",
			claimed_at: "now",
			claimed_by: "alice",
			setup_token_hash: null,
			agent_model: "personal",
			personal_agents_self_service: 0,
			password_login: 1,
			require_sso: 0,
			session_ttl_seconds: 3600,
			refresh_ttl_seconds: 3600,
			access_ttl_seconds: 3600,
			connector_key_ttl_seconds: 3600,
			legacy_key_deadline: null,
			oidc_json: null,
			audit_retention_days: 365,
			public_url: null,
		};
		c.set("organization", organization);
		c.set("requestedOrganizationAgent", requested);
		await next();
	});
	app.get("/scope", async (c) => c.json(await resolveRouteReadScope(c, c.req.query("agentId"))));
	return app;
}

test("read-scope binding and alias denials retain structured HTTP errors", async () => {
	const principal: Principal = { ...localPrincipal(), kind: "user", userId: "alice", boundAgentId: "alice-agent" };
	bindPrincipalAccess(principal, {
		agentModel: "personal",
		personalAgentsSelfService: false,
		organizationAgentId: "default",
		personalAgentId: "alice-agent",
		defaultReadAgentId: null,
		agents: [{ id: "alice-agent", kind: "personal", owner_user_id: "alice", owner_group_id: null, archived_at: null }],
	});
	const binding = await app(principal).request("/scope?agentId=bob-agent");
	expect(binding.status).toBe(403);
	expect(await binding.json()).toMatchObject({ reason: "agent_binding_conflict" });
	const alias = await app(principal, "alice-agent").request("/scope?agentId=bob-agent");
	expect(alias.status).toBe(400);
	expect(await alias.json()).toMatchObject({ reason: "agent_conflict" });
});

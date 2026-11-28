import { expect, test } from "bun:test";
import { Hono } from "hono";
import { loadRouteInventory } from "../../../tests/integration/org-mode/route-inventory";
import effects from "./route-effects.json";
import { hostRouteGuard } from "./host-route-guard";
import { localPrincipal } from "./auth/principal";

test("every route registration declares a reviewed effect", async () => {
	expect((await loadRouteInventory()).length).toBeGreaterThan(0);
});

test("host group guard preserves local mode and refuses every organization principal", async () => {
	for (const organization of [false, true]) {
		for (const kind of ["local", "user", "legacy"] as const) {
			const app = new Hono();
			app.use("*", async (c, next) => {
				if (organization)
					c.set("organization", {
						id: 1,
						name: "test",
						claimed_at: "now",
						claimed_by: null,
						setup_token_hash: null,
						agent_model: "personal",
						personal_agents_self_service: 1,
						password_login: 1,
						require_sso: 0,
						session_ttl_seconds: 60,
						refresh_ttl_seconds: 60,
						access_ttl_seconds: 60,
						connector_key_ttl_seconds: 60,
						legacy_key_deadline: null,
						oidc_json: null,
						audit_retention_days: 1,
						public_url: null,
					});
				c.set("principal", { ...localPrincipal(), kind });
				c.set("parsedJsonBody", { transcriptPath: "/isolated/host-transcript.jsonl" });
				return next();
			});
			app.use("*", hostRouteGuard);
			app.all("*", (c) => c.json({ reached: true }));
			for (const routes of Object.values(effects)) {
				for (const [route, effect] of Object.entries(routes)) {
					if (effect !== "host" && !effect.startsWith("host-input")) continue;
					const [method, pattern] = route.split(" ");
					if (!method || !pattern) throw new Error("Invalid effect declaration");
					const path = pattern.replace(/\$\{[^}]+\}/g, "probe").replace(/:[^/]+/g, "probe");
					const response = await app.request(path, { method });
					expect({ route, status: response.status }).toEqual({
						route,
						status: organization ? 403 : 200,
					});
					if (organization)
						expect(await response.json()).toEqual({
							error: "Run this operation with the CLI on the instance host",
							reason: "host_operation_local_only",
						});
				}
			}
		}
	}
});

test("unreviewed route registrations fail closed in organization mode", async () => {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("organization", {
			id: 1,
			name: "test",
			claimed_at: "now",
			claimed_by: null,
			setup_token_hash: null,
			agent_model: "personal",
			personal_agents_self_service: 1,
			password_login: 1,
			require_sso: 0,
			session_ttl_seconds: 60,
			refresh_ttl_seconds: 60,
			access_ttl_seconds: 60,
			connector_key_ttl_seconds: 60,
			legacy_key_deadline: null,
			oidc_json: null,
			audit_retention_days: 1,
			public_url: null,
		});
		c.set("principal", { ...localPrincipal(), kind: "user" });
		return next();
	});
	app.use("*", hostRouteGuard);
	app.post("/api/future-host-operation", (c) => c.json({ executed: true }));
	expect((await app.request("/api/future-host-operation", { method: "POST" })).status).toBe(403);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindLocalEndpoint } from "./local-endpoint";
import { socketFetch } from "../../../surfaces/cli/src/lib/socket-transport";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { loadRouteInventory } from "../../../tests/integration/org-mode/route-inventory";
import effects from "./route-effects.json";
import { hostRouteGuard } from "./host-route-guard";
import { localPrincipal } from "./auth/principal";
import type { OrganizationRow } from "./auth/organization-store";
import { HOST_FEATURES, replaceRemoteHostFeatures } from "./host-features";
import { requireLocalHost } from "./host-route-guard";

const organizationFixture: OrganizationRow = {
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
};

test("every route registration declares a reviewed effect", async () => {
	expect((await loadRouteInventory()).length).toBeGreaterThan(0);
});

test("host group guard preserves local mode and refuses every organization principal", async () => {
	for (const organization of [false, true]) {
		for (const kind of ["local", "user", "legacy"] as const) {
			const app = new Hono();
			app.use("*", async (c, next) => {
				if (organization) c.set("organization", organizationFixture);
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

test("the real private transport admits every reviewed host registration at the shared guard", async () => {
	const root = await mkdtemp(join(tmpdir(), ""));
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("organization", organizationFixture);
		c.set("principal", localPrincipal());
		c.set("parsedJsonBody", { transcriptPath: "/isolated/transcript" });
		return next();
	});
	app.use("*", hostRouteGuard);
	app.all("*", (c) => requireLocalHost(c) ?? c.json({ admitted: true }));
	const endpoint = await bindLocalEndpoint(join(root, "p", "s"), app.fetch);
	try {
		for (const route of await loadRouteInventory()) {
			if (!route.effect.startsWith("host")) continue;
			for (const pattern of route.paths) {
				const path = pattern.replace(/:[^/]+/g, "probe");
				const response = await socketFetch(endpoint.path, `http://localhost${path}`, { method: route.method });
				expect({ route: `${route.method} ${path}`, status: response.status }).toEqual({
					route: `${route.method} ${path}`,
					status: 200,
				});
				await response.arrayBuffer();
			}
		}
	} finally {
		await endpoint.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("unreviewed route registrations fail closed in organization mode", async () => {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("organization", organizationFixture);
		c.set("principal", { ...localPrincipal(), kind: "user" });
		return next();
	});
	app.use("*", hostRouteGuard);
	app.post("/api/future-host-operation", (c) => c.json({ executed: true }));
	expect((await app.request("/api/future-host-operation", { method: "POST" })).status).toBe(403);
});

test("every remote host feature retains role and credential permission ceilings", async () => {
	try {
		for (const feature of HOST_FEATURES) {
			for (const allowed of [false, true]) {
				replaceRemoteHostFeatures(allowed ? [feature] : []);
				for (const kind of ["user", "legacy", "local"] as const) {
					for (const role of ["admin", "member"] as const) {
						for (const adminPermission of [false, true]) {
							const app = new Hono();
							app.use("*", async (c, next) => {
								c.set("organization", organizationFixture);
								c.set("principal", {
									...localPrincipal(),
									kind,
									role,
									permissions: new Set(adminPermission ? (["admin"] as const) : (["recall"] as const)),
								});
								return next();
							});
							app.get("/", (c) => requireLocalHost(c, feature) ?? c.json({ admitted: true }));
							expect((await app.request("/")).status).toBe(
								allowed && kind === "user" && role === "admin" && adminPermission ? 200 : 403,
							);
							app.get("/never", (c) => requireLocalHost(c, "never-remote") ?? c.json({ admitted: true }));
							expect((await app.request("/never")).status).toBe(403);
						}
					}
				}
			}
		}
	} finally {
		replaceRemoteHostFeatures([]);
	}
});

import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { Hono } from "hono";
import effects from "./route-effects.json";
import { hostRouteGuard } from "./host-route-guard";
import { localPrincipal } from "./auth/principal";

const src = import.meta.dir;

test("every route registration declares a reviewed effect", async () => {
	const found: Record<string, string[]> = {};
	for await (const file of new Glob("**/*.ts").scan({ cwd: src })) {
		if (file.includes(".test.") || file.split("/").includes("__tests__")) continue;
		const source = ts.createSourceFile(file, await readFile(join(src, file), "utf8"), ts.ScriptTarget.Latest, true);
		const routes = new Set<string>();
		function visit(node: ts.Node): void {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
				const method = node.expression.name.text;
				if (["get", "post", "put", "patch", "delete", "all"].includes(method)) {
					const arg = node.arguments[0];
					if (arg && (ts.isStringLiteralLike(arg) || ts.isTemplateExpression(arg))) {
						const path = arg.getText(source).slice(1, -1);
						if (path.startsWith("/")) routes.add(`${method.toUpperCase()} ${path}`);
					}
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		if (routes.size) found[file] = [...routes].sort();
	}
	const declared = Object.fromEntries(
		Object.entries(effects).map(([file, routes]) => [file, Object.keys(routes).sort()]),
	);
	expect(found).toEqual(declared);
	for (const routes of Object.values(effects))
		for (const effect of Object.values(routes))
			expect(["host", "host-input", "host-paths", "records", "supervised"]).toContain(effect);
});

test("host group guard preserves local mode and requires local principal in organization mode", async () => {
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
				return next();
			});
			app.use("*", hostRouteGuard);
			app.all("*", (c) => c.json({ reached: true }));
			for (const routes of Object.values(effects)) {
				for (const [route, effect] of Object.entries(routes)) {
					if (effect !== "host") continue;
					const [method, pattern] = route.split(" ");
					if (!method || !pattern) throw new Error("Invalid effect declaration");
					const path = pattern.replace(/\$\{[^}]+\}/g, "probe").replace(/:[^/]+/g, "probe");
					const response = await app.request(path, { method });
					expect({ route, status: response.status }).toEqual({
						route,
						status: organization && kind !== "local" ? 403 : 200,
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

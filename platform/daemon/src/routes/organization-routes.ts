import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthConfig } from "../auth/config";
import { hybridProxyDetected, getPeerAddress } from "../auth/middleware";
import { AuthRateLimiter } from "../auth/rate-limiter";
import { failure } from "../auth/identity-middleware";
import {
	claimOrganization,
	claimSchema,
	IdentityError,
	readOrganization,
	refreshSession,
	type OrganizationRow,
} from "../auth/organization-store";
import * as operations from "../auth/organization-operations";
import * as admin from "../auth/organization-admin";
import { oidcStart, oidcCallback } from "../auth/oidc";

const limiter = new AuthRateLimiter(60_000, 20);
function origin(c: Context): string {
	return new URL(c.req.url).origin;
}
async function body(c: Context): Promise<unknown> {
	return c.req.json();
}
function sessionCookies(
	c: Context,
	result: { accessToken?: string; csrf?: string | null },
	org: OrganizationRow | null,
) {
	if (!result.accessToken || !result.csrf) return;
	const secure = new URL(c.req.url).protocol === "https:" || org?.public_url?.startsWith("https:") === true;
	setCookie(c, "signet_session", result.accessToken, {
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		secure,
		maxAge: org?.session_ttl_seconds ?? 604800,
	});
	setCookie(c, "signet_csrf", result.csrf, {
		httpOnly: false,
		sameSite: "Lax",
		path: "/",
		secure,
		maxAge: org?.session_ttl_seconds ?? 604800,
	});
}
function endpoint(fn: (c: Context) => Promise<Response>): MiddlewareHandler {
	return async (c) => {
		try {
			return await fn(c);
		} catch (error) {
			if (error instanceof IdentityError) return failure(c, error);
			if (error instanceof z.ZodError || error instanceof SyntaxError)
				return c.json({ error: "Invalid request body", reason: "invalid_request" }, 400);
			throw error;
		}
	};
}
function user(c: Context) {
	const p = c.get("principal");
	operations.requireUser(p);
	return p;
}
export function registerOrganizationRoutes(app: Hono, config: AuthConfig | (() => AuthConfig)): void {
	const getConfig = typeof config === "function" ? config : () => config;
	app.use("/api/*", async (c, next) => {
		const isOrg = c.get("organization");
		if (!isOrg && c.req.path !== "/api/org/claim") return next();
		if (getConfig().mode !== "team")
			return c.json({ error: "Organization mode requires team mode", reason: "org_policy" }, 403);
		return next();
	});
	const active =
		(fn: (c: Context) => Promise<Response>): MiddlewareHandler =>
		async (c, next) => {
			if (!c.get("organization")) return next();
			return endpoint(fn)(c, next);
		};
	app.post(
		"/api/org/claim",
		endpoint(async (c) => {
			if (getConfig().mode !== "team") throw new IdentityError(403, "org_policy");
			const key = `claim:${getPeerAddress(c) ?? "unknown"}`;
			if (!limiter.check(key).allowed) {
				c.header("Retry-After", "60");
				throw new IdentityError(429, "rate_limit");
			}
			limiter.record(key);
			const result = await claimOrganization(claimSchema.parse(await body(c)));
			sessionCookies(c, result, await readOrganization());
			return c.json(result);
		}),
	);
	app.get(
		"/api/auth/methods",
		active(async (c) => {
			const org = await readOrganization();
			return c.json({
				mode: getConfig().mode,
				organization: { name: org.name, claimed: true },
				providers: operations.authProviders(org),
			});
		}),
	);
	app.get(
		"/api/auth/whoami",
		active(async (c) =>
			c.json(await operations.whoami(c.get("principal"), await readOrganization(), hybridProxyDetected)),
		),
	);
	app.post(
		"/api/auth/login",
		active(async (c) => {
			const key = `login:${getPeerAddress(c) ?? "unknown"}`;
			if (!limiter.check(key).allowed) {
				c.header("Retry-After", "60");
				throw new IdentityError(429, "rate_limit");
			}
			limiter.record(key);
			const result = await operations.passwordLogin(await body(c));
			sessionCookies(c, result, c.get("organization"));
			return c.json(result);
		}),
	);
	app.get(
		"/api/auth/sso/start",
		active(async (c) => {
			const result = await oidcStart(origin(c), c.req.query("invite"));
			setCookie(c, "signet_oidc_state", result.state, {
				httpOnly: true,
				sameSite: "Lax",
				path: "/api/auth/sso",
				secure:
					new URL(c.req.url).protocol === "https:" || c.get("organization")?.public_url?.startsWith("https:") === true,
				maxAge: 600,
			});
			return c.redirect(result.url);
		}),
	);
	app.get(
		"/api/auth/sso/callback",
		active(async (c) => {
			const result = await oidcCallback(
				{
					state: c.req.query("state") ?? "",
					code: c.req.query("code") ?? "",
					cookieState: getCookie(c, "signet_oidc_state"),
				},
				origin(c),
			);
			deleteCookie(c, "signet_oidc_state", { path: "/api/auth/sso" });
			sessionCookies(c, result, c.get("organization"));
			return c.redirect("/");
		}),
	);
	app.post(
		"/api/auth/logout",
		active(async (c) => {
			const result = await operations.logout(user(c), await body(c));
			deleteCookie(c, "signet_session", { path: "/" });
			deleteCookie(c, "signet_csrf", { path: "/" });
			return c.json(result);
		}),
	);
	app.get(
		"/api/auth/sessions",
		active(async (c) => c.json(await operations.listSessions(user(c)))),
	);
	app.delete(
		"/api/auth/sessions/:id",
		active(async (c) => c.json(await operations.revokeSession(user(c), c.req.param("id") ?? ""))),
	);
	app.post(
		"/api/auth/device/start",
		active(async (c) => c.json(await operations.deviceStart(await body(c), origin(c)))),
	);
	app.get(
		"/api/auth/device/:userCode",
		active(async (c) => {
			user(c);
			const row = await operations.deviceInfo(c.req.param("userCode") ?? "");
			return c.json({
				client: row.client,
				deviceName: row.device_name,
				platform: row.platform,
				createdAt: row.created_at,
			});
		}),
	);
	app.post(
		"/api/auth/device/approve",
		active(async (c) => c.json(await operations.deviceApprove(user(c), await body(c)))),
	);
	app.post(
		"/api/auth/device/token",
		active(async (c) => c.json(await operations.deviceToken(await body(c)))),
	);
	app.post(
		"/api/auth/refresh",
		active(async (c) =>
			c.json(await refreshSession(z.object({ refreshToken: z.string().max(256) }).parse(await body(c)).refreshToken)),
		),
	);
	app.get(
		"/api/auth/devices",
		active(async (c) => c.json(await operations.devices(user(c)))),
	);
	app.patch(
		"/api/auth/devices/:id",
		active(async (c) => c.json(await operations.changeDevice(user(c), c.req.param("id") ?? "", await body(c)))),
	);
	app.delete(
		"/api/auth/devices/:id",
		active(async (c) => c.json(await operations.changeDevice(user(c), c.req.param("id") ?? "", null))),
	);
	app.post(
		"/api/auth/connector-keys",
		active(async (c) => c.json(await operations.createKey(user(c), await body(c), true), 201)),
	);
	app.get(
		"/api/auth/connector-keys",
		active(async (c) => c.json({ keys: await operations.listKeys(user(c), false, "connector") })),
	);
	app.delete(
		"/api/auth/connector-keys/:id",
		active(async (c) => c.json(await operations.revokeKey(user(c), c.req.param("id") ?? ""))),
	);
	app.post(
		"/api/auth/api-keys",
		active(async (c) => c.json(await operations.createKey(user(c), await body(c), false), 201)),
	);
	app.get(
		"/api/auth/api-keys",
		active(async (c) => c.json({ apiKeys: await operations.listKeys(user(c), c.req.query("all") === "1") })),
	);
	app.delete(
		"/api/auth/api-keys/:id",
		active(async (c) => c.json(await operations.revokeKey(user(c), c.req.param("id") ?? ""))),
	);
	for (const path of ["/api/auth/token", "/api/auth/session", "/api/auth/handoff", "/api/auth/handoff/redeem"])
		app.post(
			path,
			active(async () => {
				throw new IdentityError(403, "org_policy");
			}),
		);
	app.get(
		"/api/auth/invites/:token",
		active(async (c) => {
			const invite = await operations.readInvite(c.req.param("token") ?? "");
			const org = await readOrganization();
			return c.json({
				organization: { name: org.name },
				role: invite.role,
				...(invite.email ? { email: invite.email } : {}),
			});
		}),
	);
	app.post(
		"/api/auth/invites/accept",
		active(async (c) => {
			const result = await operations.acceptInvite(await body(c));
			if ("accessToken" in result) sessionCookies(c, result, c.get("organization"));
			return c.json(result);
		}),
	);
	app.post(
		"/api/org/invites",
		active(async (c) => c.json(await operations.createInvite(user(c), await body(c), origin(c)), 201)),
	);
	app.get(
		"/api/org/invites",
		active(async (c) => c.json(await admin.invites(user(c)))),
	);
	app.delete(
		"/api/org/invites/:id",
		active(async (c) => c.json(await admin.deleteInvite(user(c), c.req.param("id") ?? ""))),
	);
	app.get(
		"/api/org/users",
		active(async (c) => c.json(await operations.listUsers(user(c), c.req.query()))),
	);
	app.patch(
		"/api/org/users/:id",
		active(async (c) => c.json(await operations.updateUser(user(c), c.req.param("id") ?? "", await body(c)))),
	);
	app.post(
		"/api/org/users/:id/deactivate",
		active(async (c) => {
			const result = await admin.deactivate(user(c), c.req.param("id") ?? "", await body(c));
			return c.json(result, "jobId" in result ? 202 : 200);
		}),
	);
	app.post(
		"/api/org/users/:id/reactivate",
		active(async (c) => c.json(await operations.reactivate(user(c), c.req.param("id") ?? ""))),
	);
	app.get(
		"/api/org/groups",
		active(async (c) => c.json(await admin.groups(user(c)))),
	);
	app.post(
		"/api/org/groups",
		active(async (c) => c.json(await admin.createGroup(user(c), await body(c)), 201)),
	);
	app.get(
		"/api/org/groups/:id",
		active(async (c) => c.json(await admin.group(user(c), c.req.param("id") ?? ""))),
	);
	app.patch(
		"/api/org/groups/:id",
		active(async (c) => c.json(await admin.changeGroup(user(c), c.req.param("id") ?? "", await body(c)))),
	);
	app.delete(
		"/api/org/groups/:id",
		active(async (c) => c.json(await admin.changeGroup(user(c), c.req.param("id") ?? "", null))),
	);
	app.put(
		"/api/org/groups/:id/members/:userId",
		active(async (c) =>
			c.json(await admin.groupMember(user(c), c.req.param("id") ?? "", c.req.param("userId") ?? "", await body(c))),
		),
	);
	app.delete(
		"/api/org/groups/:id/members/:userId",
		active(async (c) =>
			c.json(await admin.groupMember(user(c), c.req.param("id") ?? "", c.req.param("userId") ?? "", null)),
		),
	);
	app.get(
		"/api/agents",
		active(async (c) => c.json(await admin.agents(user(c)))),
	);
	app.post(
		"/api/agents",
		active(async (c) => c.json(await admin.createAgent(user(c), await body(c)), 201)),
	);
	app.patch(
		"/api/agents/:id",
		active(async (c) => c.json(await admin.updateAgent(user(c), c.req.param("id") ?? "", await body(c)))),
	);
	app.get(
		"/api/org/agents/legacy",
		active(async (c) => c.json(await admin.legacyAgents(user(c)))),
	);
	app.post(
		"/api/org/agents/:id/map",
		active(async (c) => c.json(await admin.mapAgent(user(c), c.req.param("id") ?? "", await body(c)))),
	);
	app.get(
		"/api/org/access/:userId",
		active(async (c) => c.json(await admin.effectiveAccess(user(c), c.req.param("userId") ?? ""))),
	);
	app.get(
		"/api/org/settings",
		active(async (c) => c.json(await admin.settings(user(c)))),
	);
	app.patch(
		"/api/org/settings",
		active(async (c) => c.json(await admin.updateSettings(user(c), await body(c)))),
	);
	app.get(
		"/api/org/keys",
		active(async (c) => c.json(await admin.keys(user(c), c.req.query()))),
	);
	app.post(
		"/api/org/keys/revoke",
		active(async (c) => c.json(await admin.bulkRevoke(user(c), await body(c)), 202)),
	);
	app.patch(
		"/api/org/keys/:id",
		active(async (c) => c.json(await admin.assignKey(user(c), c.req.param("id") ?? "", await body(c)))),
	);
	app.get(
		"/api/org/audit",
		active(async (c) => c.json(await admin.audit(user(c), c.req.query()))),
	);
	app.get(
		"/api/org/audit/export",
		active(async (c) => {
			const result = await admin.auditExport(user(c), c.req.query());
			return new Response(result, { headers: { "Content-Type": "application/x-ndjson" } });
		}),
	);
	app.get(
		"/api/org/jobs",
		active(async (c) => c.json(await admin.jobs(user(c), c.req.query("kind")))),
	);
	app.get(
		"/api/org/jobs/:id",
		active(async (c) => c.json(await admin.job(user(c), c.req.param("id") ?? ""))),
	);
}

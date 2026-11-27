import { setOrganizationSso } from "../organization-sso";
import { startAgentPurge } from "../agent-purge";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthConfig } from "../auth/config";
import { authCookies } from "../auth/cookies";
import { failure } from "../auth/identity-middleware";
import { hybridProxyDetected } from "../auth/middleware";
import { oidcCallback, oidcStart } from "../auth/oidc";
import { operatorRestartCapabilities, restartOrganization } from "../operator-restart";
import { startOperatorJob } from "../operator-jobs";
import * as admin from "../auth/organization-admin";
import * as operations from "../auth/organization-operations";
import {
	claimOrganization,
	prepareOrganizationBootstrap,
	claimSchema,
	IdentityError,
	type OrganizationRow,
	readOrganization,
	issueKeyBrowserSession,
	refreshSession,
} from "../auth/organization-store";
import { getRequestOrigin } from "../auth/request-network";
import { jsonBody } from "../request-body";

function browserResult(result: Awaited<ReturnType<typeof operations.passwordLogin>>) {
	return { user: result.user, expiresAt: result.accessExpiresAt, csrf: result.csrf };
}
function origin(c: Context): string {
	return getRequestOrigin(c);
}
async function body(c: Context): Promise<unknown> {
	return jsonBody(c)();
}
function sessionCookies(
	c: Context,
	result: { accessToken?: string; csrf?: string | null; accessExpiresAt?: string },
	org: OrganizationRow | null,
) {
	if (!result.accessToken || !result.csrf) return;
	const maxAge = result.accessExpiresAt
		? Math.max(0, Math.floor((Date.parse(result.accessExpiresAt) - Date.now()) / 1000))
		: (org?.session_ttl_seconds ?? 604800);
	const secure = new URL(c.req.url).protocol === "https:" || org?.public_url?.startsWith("https:") === true;
	setCookie(c, authCookies(c).session, result.accessToken, {
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		secure,
		maxAge,
	});
	setCookie(c, authCookies(c).csrf, result.csrf, {
		httpOnly: false,
		sameSite: "Lax",
		path: "/",
		secure,
		maxAge,
	});
}
function endpoint(fn: (c: Context) => Promise<Response>): MiddlewareHandler {
	return async (c) => {
		try {
			return await fn(c);
		} catch (error) {
			if (error instanceof IdentityError) {
				if (error.status === 429 && c.req.path === "/api/org/users/lookup") c.header("Retry-After", "60");
				return failure(c, error);
			}
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
export function registerOrganizationRoutes(
	app: Hono,
	config: AuthConfig | (() => AuthConfig),
	workspaceRoot: string,
): void {
	const getConfig = typeof config === "function" ? config : () => config;
	app.use("/api/*", async (c, next) => {
		const isOrg = c.get("organization");
		if (!isOrg && !["/api/org/claim", "/api/org/bootstrap"].includes(c.req.path)) return next();
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
			const result = await claimOrganization(claimSchema.parse(await body(c)), workspaceRoot);
			sessionCookies(c, result, await readOrganization());
			return c.json(browserResult(result));
		}),
	);
	app.get("/api/auth/methods", async (c, next) => {
		if (getConfig().mode !== "team") return next();
		return endpoint(async (c) => {
			const org = await readOrganization();
			return c.json({
				mode: "team",
				organization: { name: org.name, claimed: org.claimed_at !== null },
				providers: operations.authProviders(org),
			});
		})(c, next);
	});
	app.post(
		"/api/org/bootstrap",
		endpoint(async (c) => c.json(await prepareOrganizationBootstrap(await body(c)))),
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
			const result = await operations.passwordLogin(await body(c));
			sessionCookies(c, result, c.get("organization"));
			return c.json(browserResult(result));
		}),
	);
	app.get(
		"/api/auth/sso/start",
		active(async (c) => {
			if (c.req.query("invite"))
				throw new IdentityError(400, "invalid_request", "Submit invitation tokens as JSON, not in URLs");
			const code = c.req.query("continuation");
			const invite = code ? await operations.consumeInvitationContinuation(code) : undefined;
			const result = await oidcStart(origin(c), invite);
			setCookie(c, authCookies(c).state, result.state, {
				httpOnly: true,
				sameSite: "Lax",
				path: "/",
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
					cookieState: getCookie(c, authCookies(c).state),
				},
				origin(c),
			);
			deleteCookie(c, authCookies(c).state, { path: "/", secure: authCookies(c).secure });
			sessionCookies(c, result, c.get("organization"));
			return c.redirect("/");
		}),
	);
	app.patch(
		"/api/auth/preferences",
		active(async (c) => c.json(await operations.updatePreferences(user(c), await body(c)))),
	);
	app.get(
		"/api/auth/profile",
		active(async (c) => c.json(await operations.profile(user(c)))),
	);
	app.patch(
		"/api/auth/profile",
		active(async (c) => c.json(await operations.updateProfile(user(c), await body(c)))),
	);
	app.post(
		"/api/auth/logout",
		active(async (c) => {
			const result = await operations.logout(user(c), await body(c));
			deleteCookie(c, authCookies(c).session, { path: "/", secure: authCookies(c).secure });
			deleteCookie(c, authCookies(c).csrf, { path: "/", secure: authCookies(c).secure });
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
		"/api/org/sso",
		active(async (c) => c.json(await setOrganizationSso(user(c), await body(c)))),
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
	app.get(
		"/api/auth/connector-keys/:id/errors",
		active(async (c) => c.json(await operations.connectorErrors(user(c), c.req.param("id") ?? ""))),
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
	app.post(
		"/api/auth/handoff",
		active(async (c) => c.json(await operations.createDashboardHandoff(user(c)))),
	);
	app.post(
		"/api/auth/handoff/redeem",
		active(async (c) => {
			const result = await operations.redeemDashboardHandoff(await body(c));
			if ("confirmationRequired" in result) return c.json(result);
			sessionCookies(c, result, c.get("organization"));
			return c.json(browserResult(result));
		}),
	);
	app.post(
		"/api/auth/session",
		active(async (c) => {
			z.object({})
				.strict()
				.parse(await body(c));
			const result = await issueKeyBrowserSession(user(c));
			sessionCookies(c, result, c.get("organization"));
			return c.json(browserResult(result));
		}),
	);
	for (const path of ["/api/auth/token"])
		app.post(
			path,
			active(async () => {
				throw new IdentityError(403, "org_policy");
			}),
		);
	app.post(
		"/api/auth/invites/lookup",
		active(async (c) => {
			const invite = await operations.readInvite(
				z.object({ token: z.string().min(1).max(256) }).parse(await body(c)).token,
			);
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
			if ("accessToken" in result) {
				sessionCookies(c, result, c.get("organization"));
				return c.json(browserResult(result));
			}
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
	app.post(
		"/api/classifications/:id/purge-author",
		active(async (c) => {
			const result = await admin.purgeClassificationAuthor(
				user(c),
				c.req.param("id") ?? "",
				await body(c),
				workspaceRoot,
			);
			return c.json(result, "jobId" in result ? 202 : 200);
		}),
	);
	app.get(
		"/api/org/users/lookup",
		active(async (c) => c.json(await admin.lookupUsers(user(c), c.req.query()))),
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
			const result = await admin.deactivate(user(c), c.req.param("id") ?? "", await body(c), workspaceRoot);
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
	app.post(
		"/api/org/agents/:id/purge",
		active(async (c) => {
			z.object({})
				.strict()
				.parse(await body(c));
			return c.json(await startAgentPurge(user(c), c.req.param("id") ?? "", c.req.header("x-signet-agent-id")), 202);
		}),
	);
	app.delete(
		"/api/agents/:id",
		active(async () => {
			throw new IdentityError(
				409,
				"org_policy",
				"Use agent remove to archive, then agent purge --confirm for an audited purge job",
			);
		}),
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
		"/api/org/operator/doctor",
		active(async (c) => {
			const org = c.get("organization");
			if (!org) throw new IdentityError(401, "missing_credential");
			return c.json(await admin.organizationDoctor(user(c), org, hybridProxyDetected));
		}),
	);
	app.get(
		"/api/org/operator/capabilities",
		active(async (c) => {
			operations.requireAdmin(user(c));
			return c.json(operatorRestartCapabilities());
		}),
	);
	app.post(
		"/api/org/operator/restart",
		active(async (c) => {
			z.object({})
				.strict()
				.parse(await body(c));
			return c.json(await restartOrganization(user(c)), 202);
		}),
	);
	app.post(
		"/api/org/operator/jobs",
		active(async (c) => c.json(await startOperatorJob(user(c), await body(c), c.req.header("x-signet-agent-id")), 202)),
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

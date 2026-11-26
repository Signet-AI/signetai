import { bodyLimit } from "hono/body-limit";
import { withWritePrincipal, classifiedDestinationDenied } from "@signet/core";
import { admitWriteDestination } from "./write-destination";
import { LOCAL_AUTHOR } from "./audit-owner";
import { withStopAdmission } from "../stop-admission";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hasDbAccessor } from "../db-accessor";
import { JsonBodyError, prepareJsonBody } from "../request-body";
import {
	checkPrincipalProject,
	organizationReadRequest,
	principalAccess,
	reconcileAgentSources,
	resolveWriteAgent,
} from "./agent-access";
import { isSignetApiKey, verifyApiKey } from "./api-keys";
import type { AuthConfig } from "./config";
import { authCookies } from "./cookies";
import { createAuthMiddleware, isAuthOpenPath, isLoopbackRequest } from "./middleware";
import {
	activeUser,
	bindAccess,
	bindHookSpeaker,
	bindRequestedReadAgent,
	IdentityError,
	type OrganizationRow,
	readBoundKey,
	readOrganization,
	recordConnectorError,
	renewConnectorKey,
	userPrincipal,
	verifySession,
} from "./organization-store";
import { acceptRequestOrigin } from "./origins";
import { legacyPrincipal, localPrincipal, type Principal, rolePermissions } from "./principal";
import { AuthRateLimiter } from "./rate-limiter";
import { rateLimitClientAddress, resolveRequestNetwork } from "./request-network";
import { PERMISSIONS } from "./types";

declare module "hono" {
	interface ContextVariableMap {
		principal: Principal;
		organization: OrganizationRow | null;
		requestedOrganizationAgent: string | undefined;
		authFailureReason: string | undefined;
		author: { userId: string | null; credential: string };
	}
}
async function withIdentityBody(c: Context, next: Next): Promise<Response | undefined> {
	if (c.req.method !== "POST" || c.req.path !== "/api/hooks/stop") {
		await next();
		return;
	}
	try {
		return await withStopAdmission(c, async () => {
			const response = await bodyLimit({
				maxSize: 2 * 1_048_576,
				onError: (ctx) => ctx.json({ error: "payload too large" }, 413),
			})(c, async () => {
				await prepareJsonBody(c);
				await next();
			});
			if (response) c.res = response;
		});
	} catch (error) {
		if (error instanceof JsonBodyError) return c.json({ error: error.message, reason: error.reason }, error.status);
		throw error;
	}
}
export function createIdentityMiddleware(config: AuthConfig, secret: Buffer | null): MiddlewareHandler {
	const legacy = createAuthMiddleware(config, secret, verifyApiKey);
	const ipLimits = new AuthRateLimiter(60_000, 20),
		nameLimits = new AuthRateLimiter(60_000, 30),
		pairLimits = new AuthRateLimiter(60_000, 5),
		deviceLimits = new AuthRateLimiter(60_000, 20);
	const openAuthPaths = new Set([
		"/api/auth/session",
		"/api/auth/handoff/redeem",
		"/api/auth/login",
		"/api/org/claim",
		"/api/org/bootstrap",
		"/api/auth/refresh",
		"/api/auth/device/start",
		"/api/auth/device/token",
		"/api/auth/invites/lookup",
		"/api/auth/invites/accept",
		"/api/auth/sso/start",
		"/api/auth/sso/callback",
	]);
	function admit(limiter: AuthRateLimiter, key: string, c: Context): boolean {
		const result = limiter.check(key);
		if (!result.allowed) {
			c.header("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
			return false;
		}
		limiter.record(key);
		return true;
	}

	return async (c, next) => {
		c.set("organization", null);
		resolveRequestNetwork(c, config);
		if (openAuthPaths.has(c.req.path) && !admit(ipLimits, `${c.req.path}:${rateLimitClientAddress(c) ?? "unknown"}`, c))
			return failure(c, new IdentityError(429, "rate_limit"));
		try {
			if (c.req.path !== "/api/hooks/stop" || c.req.method !== "POST") await prepareJsonBody(c);
		} catch (error) {
			if (error instanceof JsonBodyError) return c.json({ error: error.message, reason: error.reason }, error.status);
			throw error;
		}
		if (c.req.method === "POST" && c.req.path === "/api/auth/login") {
			const body = c.get("parsedJsonBody");
			const username = typeof body === "object" && body !== null ? Reflect.get(body, "username") : undefined;
			if (typeof username === "string" && (username.trim().length === 0 || username.trim().length > 128))
				return failure(c, new IdentityError(400, "invalid_request"));
			if (
				typeof username === "string" &&
				(!admit(pairLimits, JSON.stringify([username.trim().toLowerCase(), rateLimitClientAddress(c)]), c) ||
					!admit(nameLimits, username.trim().toLowerCase(), c))
			)
				return failure(c, new IdentityError(429, "rate_limit"));
		}
		if (config.mode !== "team" && ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && c.req.header("origin")) {
			let accepted = acceptRequestOrigin(c, config, null);
			if (!accepted && hasDbAccessor())
				accepted = acceptRequestOrigin(c, config, (await readOrganization()).public_url);
			if (!accepted && isAuthOpenPath(c.req.path))
				return failure(c, new IdentityError(403, "org_policy", "Cross-origin authentication rejected"));
		}
		if (config.mode !== "team")
			return legacy(c, async () => {
				const claims = c.get("auth")?.claims;
				if (claims) {
					c.set("principal", legacyPrincipal(claims));
					c.set("author", { userId: claims.scope.user ?? null, credential: `token:${claims.sub}` });
				} else if (config.mode === "local" || isLoopbackRequest(c)) {
					c.set("principal", localPrincipal());
					c.set("author", LOCAL_AUTHOR);
				}
				const response = await withIdentityBody(c, next);
				if (response) c.res = response;
			});
		const org = await readOrganization();
		if (
			["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
			(isAuthOpenPath(c.req.path) || c.req.path === "/api/auth/session") &&
			!acceptRequestOrigin(c, config, org.public_url)
		)
			return failure(c, new IdentityError(403, "org_policy", "Cross-origin authentication rejected"));
		if (!org.claimed_at)
			return legacy(c, async () => {
				const claims = c.get("auth")?.claims;
				if (claims && claims.role !== "admin" && !claims.scope.agent && !claims.scope.project && !claims.scope.user) {
					const key = claims.sub.startsWith("api-key:") ? await readBoundKey(claims.sub.slice(8)) : null;
					if (!key?.legacy) {
						c.res = failure(c, new IdentityError(401, "empty_scope"));
						return;
					}
				}
				if (claims) {
					c.set("principal", legacyPrincipal(claims));
					c.set("author", { userId: claims.scope.user ?? null, credential: `token:${claims.sub}` });
				}
				const response = await withIdentityBody(c, next);
				if (response) c.res = response;
			});
		c.set("organization", org);
		const open = isAuthOpenPath(c.req.path);
		const bearer = c.req.header("authorization");
		const cookie = !bearer ? getCookie(c, authCookies(c).session) : undefined;
		const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : cookie;
		if (cookie && !token?.startsWith("sig_ses_")) return failure(c, new IdentityError(401, "invalid_credential"));
		if (!token) {
			c.set("auth", { authenticated: false, claims: null });
			if (
				open ||
				(!c.req.path.startsWith("/api/") &&
					!c.req.path.startsWith("/memory/") &&
					c.req.path !== "/mcp" &&
					!c.req.path.startsWith("/v1/"))
			)
				return next();
			return failure(c, new IdentityError(401, "missing_credential"));
		}
		let verifiedKeyId: string | null = null;
		try {
			let p: Principal;
			if (token.startsWith("sig_ses_")) {
				const result = await verifySession(
					token,
					c.req.header("x-signet-csrf"),
					Boolean(cookie) && ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method),
					org,
				);
				p = result.principal;
				if (cookie && result.slid) {
					const options = {
						sameSite: "Lax" as const,
						path: "/",
						secure: authCookies(c, org).secure,
						maxAge: Math.max(0, Math.floor((Date.parse(result.session.access_expires_at) - Date.now()) / 1000)),
					};
					setCookie(c, authCookies(c).session, token, { ...options, httpOnly: true });
					const csrfCookie = getCookie(c, authCookies(c).csrf);
					if (csrfCookie) setCookie(c, authCookies(c).csrf, csrfCookie, { ...options, httpOnly: false });
				}
				c.set("auth", {
					authenticated: true,
					claims: {
						sub: result.user.id,
						role: p.role,
						scope: { user: result.user.id },
						iat: 0,
						exp: Math.floor(Date.parse(result.session.access_expires_at) / 1000),
						permissions: [...p.permissions],
					},
				});
			} else if (isSignetApiKey(token)) {
				const verified = await verifyApiKey(token);
				verifiedKeyId =
					verified.verifiedKeyId ?? (verified.authenticated ? (verified.claims?.sub.slice(8) ?? null) : null);
				if (!verified.authenticated || !verified.claims)
					throw new IdentityError(
						401,
						verified.error?.includes("revoked")
							? "revoked"
							: verified.error?.includes("expired")
								? "expired"
								: "invalid_credential",
					);
				const key = await readBoundKey(verified.claims.sub.slice(8));
				if (!key || key.revoked_at) throw new IdentityError(401, "revoked");
				if (key.expires_at && key.expires_at <= new Date().toISOString()) throw new IdentityError(401, "expired");
				if (key.agent_id && verified.claims.scope.agent && key.agent_id !== verified.claims.scope.agent)
					throw new IdentityError(401, "invalid_credential");
				const boundAgent = key.agent_id ?? verified.claims.scope.agent ?? null;
				let projects = key.allowed_projects_json
					? z.array(z.string()).parse(JSON.parse(key.allowed_projects_json))
					: null;
				if (verified.claims.scope.project) {
					const project = verified.claims.scope.project;
					projects = projects ? projects.filter((v) => v === project) : [project];
				}
				if (key.legacy && org.legacy_key_deadline && org.legacy_key_deadline <= new Date().toISOString())
					throw new IdentityError(401, "legacy_key_expired");
				if (!key.user_id) {
					if (!key.legacy) throw new IdentityError(401, "empty_scope");
					p = {
						...legacyPrincipal(verified.claims),
						harness: key.harness,
						boundAgentId: boundAgent,
						allowedProjects: projects,
					};
					await bindAccess(p, null, org);
				} else {
					const user = await activeUser(key.user_id, key.device_id);
					const permissions = z.array(z.enum(PERMISSIONS)).parse(JSON.parse(key.permissions_json));
					p = await userPrincipal(
						user,
						{ kind: "api_key", id: key.id },
						key.session_id,
						key.device_id,
						key.harness,
						boundAgent,
						projects,
						permissions.length || key.kind !== "legacy" ? permissions : [...rolePermissions(verified.claims.role)],
					);
					if (key.kind === "connector") p = { ...p, role: "member" };
					await bindAccess(p, user, org);
					await renewConnectorKey(key, org);
				}
				c.set("auth", { ...verified, claims: { ...verified.claims, role: p.role, permissions: [...p.permissions] } });
			} else throw new IdentityError(401, "legacy_token");
			c.set("principal", p);
			if (
				!open &&
				/^\/api\/auth\/device\/[^/]+$/.test(c.req.path) &&
				!admit(deviceLimits, p.userId ?? p.credential.id, c)
			)
				return failure(c, new IdentityError(429, "rate_limit"));
			c.set("author", { userId: p.userId, credential: `${p.credential.kind}:${p.credential.id}` });
			return await withWritePrincipal({ userId: p.userId }, () =>
				withIdentityBody(c, async () => {
					if (!open) {
						for (const header of ["x-signet-actor", "x-signet-actor-type"]) {
							const actor = c.req.header(header);
							if (actor !== undefined && actor !== p.userId) throw new IdentityError(403, "actor_conflict");
						}
						const parsed = c.get("parsedJsonBody");
						const body =
							typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
								? z.record(z.string(), z.unknown()).parse(parsed)
								: {};
						if (p.harness && typeof body.harness === "string" && body.harness !== p.harness)
							throw new IdentityError(403, "org_policy", "Credential is bound to another harness");
						const headerSession = c.req.header("x-signet-session-key");
						const sessionKey =
							typeof body.sessionKey === "string"
								? body.sessionKey
								: typeof body.fromSessionKey === "string"
									? body.fromSessionKey
									: headerSession;
						const sessionAgent = sessionKey?.startsWith("agent:") ? sessionKey.split(":")[1] : undefined;
						const headerSessionAgent = headerSession?.startsWith("agent:") ? headerSession.split(":")[1] : undefined;
						const requested = reconcileAgentSources([
							typeof body.fromAgentId === "string" ? body.fromAgentId : undefined,
							typeof body.agentId === "string" ? body.agentId : undefined,
							typeof body.agent_id === "string" ? body.agent_id : undefined,
							...(c.req.queries("agentId") ?? []),
							...(c.req.queries("agent_id") ?? []),
							c.req.header("x-signet-agent-id"),
							sessionAgent,
							headerSessionAgent,
							...[
								body.sessionKey,
								body.session_key,
								body.fromSessionKey,
								...(c.req.queries("sessionKey") ?? []),
								...(c.req.queries("session_key") ?? []),
							].map((key) => (typeof key === "string" && key.startsWith("agent:") ? key.split(":")[1] : undefined)),
						]);
						if (!requested.ok) throw new IdentityError(requested.error.status, requested.error.reason);
						if (p.boundAgentId && requested.value && requested.value !== p.boundAgentId)
							throw new IdentityError(403, "agent_binding_conflict");
						c.set("requestedOrganizationAgent", requested.value);
						if (organizationReadRequest(c.req.method, c.req.path)) await bindRequestedReadAgent(p, requested.value);
						const project = checkPrincipalProject(
							p,
							typeof body.project === "string" ? body.project : c.req.query("project"),
						);
						if (!project.ok) throw new IdentityError(403, project.error.reason);
						if (
							!c.req.path.startsWith("/api/auth/") &&
							!c.req.path.startsWith("/api/org/") &&
							!c.req.path.startsWith("/api/agents") &&
							c.req.path !== "/mcp" &&
							["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
							!organizationReadRequest(c.req.method, c.req.path)
						) {
							if (body.scope === "all" || c.req.query("scope") === "all")
								throw new IdentityError(403, "agent_not_permitted");
							const access = principalAccess(p);
							if (!access) throw new IdentityError(403, "org_policy");
							const target = resolveWriteAgent(p, requested.value, access);
							if (!target.ok) throw new IdentityError(target.error.status, target.error.reason);
							await admitWriteDestination(
								target.value,
								body,
								c.req.path,
								headerSession,
								c.req.matchedRoutes.filter((route) => route.path.includes(":sourceId")).at(-1)?.path,
							);
							if (
								sessionKey &&
								/^\/api\/hooks?\/(session-start|user-prompt-submit|session-end|remember|compaction-complete)$/.test(
									c.req.path,
								)
							) {
								if (!p.permissions.has("remember")) throw new IdentityError(403, "permission");
								await bindHookSpeaker(
									p,
									sessionKey,
									target.value,
									p.harness ?? (typeof body.harness === "string" ? body.harness : "unknown"),
									typeof body.project === "string" ? body.project : null,
								);
							}
						}
					}
					await next();
					if (classifiedDestinationDenied()) c.res = failure(c, new IdentityError(403, "classified_destination"));
					if (verifiedKeyId && (c.res.status === 401 || c.res.status === 403))
						await recordConnectorError(verifiedKeyId, c.res.status, c.get("authFailureReason") ?? "request_denied");
				}),
			);
		} catch (error) {
			if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "classified_destination") {
				if (verifiedKeyId) await recordConnectorError(verifiedKeyId, 403, "classified_destination");
				return failure(c, new IdentityError(403, "classified_destination"));
			}
			if (error instanceof SyntaxError || error instanceof z.ZodError)
				return failure(c, new IdentityError(400, "invalid_request"));
			if (!(error instanceof IdentityError)) throw error;
			if (verifiedKeyId && (error.status === 401 || error.status === 403))
				await recordConnectorError(verifiedKeyId, error.status, error.reason);
			if (open) {
				c.set("auth", { authenticated: false, claims: null, error: error.reason });
				return next();
			}
			return failure(c, error);
		}
	};
}
export function failure(c: Context, error: IdentityError): Response {
	c.set("authFailureReason", error.reason);
	if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
	const required =
		error.status === 403
			? error.message !== error.reason
				? error.message
				: error.reason === "not_owner"
					? "Ask a team owner"
					: error.reason === "permission"
						? "Requires the role and permission for this operation"
						: error.reason === "agent_not_permitted"
							? "Use a credential authorized for the requested agent"
							: error.reason === "project_not_permitted"
								? "Use a credential authorized for the requested project"
								: "Ask an organization administrator"
			: undefined;
	return c.json({ error: error.message, reason: error.reason, ...(required ? { required } : {}) }, error.status);
}

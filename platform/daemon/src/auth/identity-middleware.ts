import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthConfig } from "./config";
import { createAuthMiddleware, isAuthOpenPath } from "./middleware";
import { verifyApiKey, isSignetApiKey } from "./api-keys";
import { legacyPrincipal, localPrincipal, rolePermissions, type Principal } from "./principal";
import {
	activeUser,
	bindAccess,
	IdentityError,
	readBoundKey,
	readOrganization,
	renewConnectorKey,
	userPrincipal,
	verifySession,
	bindHookSpeaker,
	type OrganizationRow,
} from "./organization-store";
import { PERMISSIONS } from "./types";
import { reconcileAgentSources, checkPrincipalProject, principalAccess, resolveWriteAgent } from "./agent-access";

declare module "hono" {
	interface ContextVariableMap {
		principal: Principal;
		organization: OrganizationRow | null;
		requestedOrganizationAgent: string | undefined;
		author: { userId: string | null; credential: string };
	}
}
export function createIdentityMiddleware(config: AuthConfig, secret: Buffer | null): MiddlewareHandler {
	const legacy = createAuthMiddleware(config, secret, verifyApiKey);
	return async (c, next) => {
		c.set("organization", null);
		if (config.mode !== "team")
			return legacy(c, async () => {
				const claims = c.get("auth")?.claims;
				c.set("principal", claims ? legacyPrincipal(claims) : localPrincipal());
				return next();
			});
		const org = await readOrganization();
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
				if (claims) c.set("principal", legacyPrincipal(claims));
				return next();
			});
		c.set("organization", org);
		const open = isAuthOpenPath(c.req.path);
		const bearer = c.req.header("authorization");
		const cookie = !bearer ? getCookie(c, "signet_session") : undefined;
		const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : cookie;
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
						secure: new URL(c.req.url).protocol === "https:" || org.public_url?.startsWith("https:") === true,
						maxAge: org.session_ttl_seconds,
					};
					setCookie(c, "signet_session", token, { ...options, httpOnly: true });
					const csrfCookie = getCookie(c, "signet_csrf");
					if (csrfCookie) setCookie(c, "signet_csrf", csrfCookie, { ...options, httpOnly: false });
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
			c.set("author", { userId: p.userId, credential: `${p.credential.kind}:${p.credential.id}` });
			if (!open) {
				for (const header of ["x-signet-actor", "x-signet-actor-type"]) {
					const actor = c.req.header(header);
					if (actor !== undefined && actor !== p.userId) throw new IdentityError(403, "actor_conflict");
				}
				let body: Record<string, unknown> = {};
				if (
					["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) &&
					c.req.header("content-type")?.includes("application/json")
				) {
					const parsed = await c.req.json<unknown>();
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
						body = z.record(z.string(), z.unknown()).parse(parsed);
				}
				if (p.harness && typeof body.harness === "string" && body.harness !== p.harness)
					throw new IdentityError(403, "org_policy", "Credential is bound to another harness");
				const headerSession = c.req.header("x-signet-session-key");
				const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : headerSession;
				const sessionAgent = sessionKey?.startsWith("agent:") ? sessionKey.split(":")[1] : undefined;
				const headerSessionAgent = headerSession?.startsWith("agent:") ? headerSession.split(":")[1] : undefined;
				const requested = reconcileAgentSources([
					typeof body.agentId === "string" ? body.agentId : undefined,
					typeof body.agent_id === "string" ? body.agent_id : undefined,
					...(c.req.queries("agentId") ?? []),
					...(c.req.queries("agent_id") ?? []),
					c.req.header("x-signet-agent-id"),
					sessionAgent,
					headerSessionAgent,
				]);
				if (!requested.ok) throw new IdentityError(requested.error.status, requested.error.reason);
				if (p.boundAgentId && requested.value && requested.value !== p.boundAgentId)
					throw new IdentityError(403, "agent_binding_conflict");
				c.set("requestedOrganizationAgent", requested.value);
				const project = checkPrincipalProject(
					p,
					typeof body.project === "string" ? body.project : c.req.query("project"),
				);
				if (!project.ok) throw new IdentityError(403, project.error.reason);
				if (
					!c.req.path.startsWith("/api/auth/") &&
					!c.req.path.startsWith("/api/org/") &&
					!c.req.path.startsWith("/api/agents") &&
					["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)
				) {
					const access = principalAccess(p);
					if (!access) throw new IdentityError(403, "org_policy");
					const target = resolveWriteAgent(p, requested.value, access);
					if (!target.ok) throw new IdentityError(target.error.status, target.error.reason);
					if (
						sessionKey &&
						/^\/api\/hooks?\/(session-start|user-prompt-submit|session-end|remember)$/.test(c.req.path)
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
		} catch (error) {
			if (error instanceof SyntaxError || error instanceof z.ZodError)
				return failure(c, new IdentityError(400, "invalid_request"));
			if (!(error instanceof IdentityError)) throw error;
			if (open) {
				c.set("auth", { authenticated: false, claims: null, error: error.reason });
				return next();
			}
			return failure(c, error);
		}
		return next();
	};
}
export function failure(c: Context, error: IdentityError): Response {
	if (error.status === 401) c.header("WWW-Authenticate", "Bearer");
	return c.json({ error: error.message, reason: error.reason }, error.status);
}

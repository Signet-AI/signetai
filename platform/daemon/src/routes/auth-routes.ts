import type { Context, Hono, Next } from "hono";
import { randomBytes } from "node:crypto";
import {
	PERMISSIONS,
	type Permission,
	type TokenClaims,
	type TokenRole,
	type TokenScope,
	createApiKey,
	checkPermission,
	createToken,
	getPeerAddress,
	listApiKeys,
	requirePermissionWithRateLimit,
	revokeApiKey,
	verifyPasswordHash,
	verifyPlainPassword,
} from "../auth";
import { getDbAccessor } from "../db-accessor.js";
import { readEnvTrimmed } from "./state.js";
import { authAdminLimiter, authConfig, authLoginLimiter, authSecret } from "./state.js";

const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_HANDOFF_CODE_LENGTH = 128;
const HANDOFF_TTL_MS = 60_000;
const HANDOFF_LIMIT = 32;
const HANDOFF_LIMIT_PER_CREDENTIAL = 4;

interface Session {
	readonly token: string;
	readonly expiresAt: string;
	readonly role: TokenRole;
	readonly sub: string;
}
const handoffs = new Map<string, { readonly session: Session; readonly expiresAt: number }>();

function mintSession(claims: TokenClaims): Session | null {
	if (!authSecret) return null;
	const now = Math.floor(Date.now() / 1000);
	if (claims.exp <= now) return null;
	const token = createToken(
		authSecret,
		{
			sub: claims.sub,
			name: claims.name,
			scope: claims.scope,
			role: claims.role,
			permissions: claims.permissions,
			notAfter: claims.exp,
		},
		authConfig.sessionTokenTtlSeconds,
	);
	const exp = Math.min(now + authConfig.sessionTokenTtlSeconds, claims.exp);
	return { token, expiresAt: new Date(exp * 1000).toISOString(), role: claims.role, sub: claims.sub };
}

function pruneHandoffs(now: number): void {
	for (const [code, entry] of handoffs) {
		if (entry.expiresAt <= now) handoffs.delete(code);
	}
}

function resolvePasswordLogin(): {
	readonly username: string;
	readonly passwordHash: string | null;
	readonly plainPassword: string | null;
	readonly configured: boolean;
} {
	const username = readEnvTrimmed("SIGNET_ADMIN_USERNAME") ?? authConfig.login.password.username;
	const passwordHash = readEnvTrimmed("SIGNET_ADMIN_PASSWORD_HASH") ?? authConfig.login.password.passwordHash;
	const plainPassword = readEnvTrimmed("SIGNET_ADMIN_PASSWORD") ?? null;
	return {
		username,
		passwordHash,
		plainPassword,
		configured: Boolean(passwordHash || plainPassword),
	};
}

function isValidLoginString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function authProviderResponse() {
	const login = resolvePasswordLogin();
	return {
		mode: authConfig.mode,
		providers: [
			{
				id: "password",
				type: "password",
				enabled: login.configured,
				username: login.username,
			},
			{
				id: "sso",
				type: "oidc",
				enabled: false,
				startPath: "/api/auth/sso/start",
			},
			{
				id: "saml",
				type: "saml",
				enabled: false,
				startPath: "/api/auth/saml/start",
			},
		],
	};
}

export function registerAuthRoutes(app: Hono): void {
	app.get("/api/auth/whoami", (c) => {
		const auth = c.get("auth");
		const effectiveAccess = authConfig.mode === "local" || auth?.authenticated === true || auth?.trustedLocal === true;
		const permissions =
			authConfig.mode === "local" || auth?.trustedLocal === true
				? [...PERMISSIONS]
				: PERMISSIONS.filter(
						(permission) => checkPermission(auth?.claims ?? null, permission, authConfig.mode).allowed,
					);
		return c.json({
			authenticated: auth?.authenticated ?? false,
			trustedLocal: auth?.trustedLocal === true,
			effectiveAccess,
			claims: auth?.claims ?? null,
			error: auth?.error ?? null,
			permissions,
			mode: authConfig.mode,
			providers: authProviderResponse().providers,
		});
	});

	app.get("/api/auth/methods", (c) => c.json(authProviderResponse()));

	app.post("/api/auth/login", async (c) => {
		const limitKey = `login:${getPeerAddress(c) ?? "anonymous"}`;
		const check = authLoginLimiter.check(limitKey);
		if (!check.allowed) {
			c.status(429);
			c.header("Retry-After", String(Math.ceil((check.resetAt - Date.now()) / 1000)));
			return c.json({ error: "rate limit exceeded", retryAfter: check.resetAt });
		}
		authLoginLimiter.record(limitKey);

		if (!authSecret) {
			return c.json({ error: "auth secret not available" }, 400);
		}

		const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!payload) return c.json({ error: "invalid request body" }, 400);

		if (!isValidLoginString(payload.username, MAX_USERNAME_LENGTH)) {
			return c.json({ error: "username is required" }, 400);
		}
		if (!isValidLoginString(payload.password, MAX_PASSWORD_LENGTH)) {
			return c.json({ error: "password is required" }, 400);
		}

		const login = resolvePasswordLogin();
		if (!login.configured) {
			return c.json({ error: "password login is not configured" }, 503);
		}

		const usernameMatches = verifyPlainPassword(payload.username, login.username);
		const hashMatches = login.passwordHash ? verifyPasswordHash(payload.password, login.passwordHash) : false;
		const plainMatches = login.plainPassword ? verifyPlainPassword(payload.password, login.plainPassword) : false;
		if (!usernameMatches || (!hashMatches && !plainMatches)) {
			return c.json({ error: "invalid username or password" }, 401);
		}

		const ttl = authConfig.sessionTokenTtlSeconds;
		const token = createToken(
			authSecret,
			{ sub: "dashboard:admin", name: login.username, scope: {}, role: "admin" },
			ttl,
		);
		const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
		return c.json({ token, expiresAt, role: "admin", username: login.username });
	});

	app.post("/api/auth/session", (c) => {
		const claims = c.get("auth")?.claims;
		if (!claims) return c.json({ error: "a credential is required" }, 401);
		const session = mintSession(claims);
		if (!session) return c.json({ error: "credential cannot start a session" }, 401);
		return c.json(session);
	});

	app.post("/api/auth/handoff", (c) => {
		const claims = c.get("auth")?.claims;
		if (!claims) return c.json({ error: "a credential is required" }, 401);
		const now = Date.now();
		pruneHandoffs(now);
		const pending = [...handoffs.values()].filter((entry) => entry.session.sub === claims.sub).length;
		if (handoffs.size >= HANDOFF_LIMIT || pending >= HANDOFF_LIMIT_PER_CREDENTIAL) {
			return c.json({ error: "too many pending handoffs" }, 429);
		}
		const session = mintSession(claims);
		if (!session) return c.json({ error: "credential cannot start a session" }, 401);
		const code = randomBytes(32).toString("base64url");
		const expiresAt = now + HANDOFF_TTL_MS;
		handoffs.set(code, { session, expiresAt });
		return c.json({ code, expiresAt: new Date(expiresAt).toISOString() });
	});

	app.post("/api/auth/handoff/redeem", async (c) => {
		const limitKey = `handoff:${getPeerAddress(c) ?? "anonymous"}`;
		const check = authLoginLimiter.check(limitKey);
		if (!check.allowed) {
			c.header("Retry-After", String(Math.ceil((check.resetAt - Date.now()) / 1000)));
			return c.json({ error: "rate limit exceeded", retryAfter: check.resetAt }, 429);
		}
		authLoginLimiter.record(limitKey);
		const payload: unknown = await c.req.json().catch(() => null);
		const code =
			typeof payload === "object" && payload !== null && !Array.isArray(payload)
				? Reflect.get(payload, "code")
				: undefined;
		if (!isValidLoginString(code, MAX_HANDOFF_CODE_LENGTH)) return c.json({ error: "code is required" }, 400);
		const now = Date.now();
		pruneHandoffs(now);
		const entry = handoffs.get(code);
		handoffs.delete(code);
		if (!entry) return c.json({ error: "handoff code is invalid or expired" }, 401);
		return c.json(entry.session);
	});

	app.get("/api/auth/sso/start", (c) => c.json({ error: "SSO login is not configured", provider: "sso" }, 501));
	app.get("/api/auth/sso/callback", (c) => c.json({ error: "SSO callback is not configured", provider: "sso" }, 501));
	app.post("/api/auth/saml/acs", (c) => c.json({ error: "SAML ACS is not configured", provider: "saml" }, 501));
	app.get("/api/auth/saml/start", (c) => c.json({ error: "SAML login is not configured", provider: "saml" }, 501));

	const requireAdminAuth = (c: Context, next: Next) =>
		requirePermissionWithRateLimit("admin", "admin", authAdminLimiter, authConfig)(c, next);

	app.use("/api/auth/token", requireAdminAuth);
	app.use("/api/auth/api-keys", requireAdminAuth);
	app.use("/api/auth/api-keys/*", requireAdminAuth);

	app.post("/api/auth/token", async (c) => {
		if (!authSecret) {
			return c.json({ error: "auth secret not available (local mode?)" }, 400);
		}

		const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!payload) {
			return c.json({ error: "invalid request body" }, 400);
		}

		const role = payload.role as string | undefined;
		const validRoles: TokenRole[] = ["admin", "operator", "agent", "readonly"];
		if (!role || !validRoles.includes(role as TokenRole)) {
			return c.json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
		}

		const scope = (payload.scope ?? {}) as TokenScope;
		const ttl =
			typeof payload.ttlSeconds === "number" && payload.ttlSeconds > 0
				? payload.ttlSeconds
				: authConfig.defaultTokenTtlSeconds;

		const token = createToken(authSecret, { sub: `token:${role}`, scope, role: role as TokenRole }, ttl);
		const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
		return c.json({ token, expiresAt });
	});

	app.get("/api/auth/api-keys", (c) => {
		return c.json({ apiKeys: listApiKeys(getDbAccessor()) });
	});

	app.post("/api/auth/api-keys", async (c) => {
		const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!payload) return c.json({ error: "invalid request body" }, 400);
		const name = typeof payload.name === "string" ? payload.name.trim() : "";
		if (!name) return c.json({ error: "name is required" }, 400);
		const role = typeof payload.role === "string" ? payload.role : undefined;
		const validRoles: TokenRole[] = ["admin", "operator", "agent", "readonly"];
		if (role !== undefined && !validRoles.includes(role as TokenRole)) {
			return c.json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
		}
		try {
			const apiKey = createApiKey(getDbAccessor(), {
				name,
				role: role as TokenRole | undefined,
				scope: (payload.scope ?? {}) as TokenScope,
				permissions: Array.isArray(payload.permissions)
					? payload.permissions.filter((permission): permission is Permission => typeof permission === "string")
					: undefined,
				connector: typeof payload.connector === "string" ? payload.connector : undefined,
				harness: typeof payload.harness === "string" ? payload.harness : undefined,
				agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
				allowedProjects: Array.isArray(payload.allowedProjects)
					? payload.allowedProjects.filter((project): project is string => typeof project === "string")
					: undefined,
				expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
			});
			return c.json({ apiKey }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, 400);
		}
	});

	app.delete("/api/auth/api-keys/:id", (c) => {
		const id = c.req.param("id");
		const revoked = revokeApiKey(getDbAccessor(), id);
		if (!revoked) return c.json({ error: "API key not found" }, 404);
		return c.json({ apiKey: revoked });
	});
}

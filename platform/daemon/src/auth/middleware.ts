import type { Context, MiddlewareHandler } from "hono";
import { isSignetApiKey } from "./api-keys";
import type { AuthConfig } from "./config";
import { checkPermission, checkScope } from "./policy";
import type { AuthRateLimiter } from "./rate-limiter";
import { verifyToken } from "./tokens";
import type { AuthResult, Permission, TokenScope } from "./types";
declare module "hono" {
	interface ContextVariableMap {
		auth: AuthResult;
	}
}

function extractBearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const parts = header.split(" ");
	if (parts.length !== 2 || parts[0] !== "Bearer") return null;
	return parts[1] ?? null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isAuthOpenPath(path: string): boolean {
	if (path === "/health" || path === "/health/live" || path === "/health/ready") return true;
	if (path === "/api/mode") return true;
	if (path === "/api/auth/login" || path === "/api/auth/methods" || path === "/api/auth/whoami") return true;
	if (
		[
			"/api/auth/handoff/redeem",
			"/api/auth/device/start",
			"/api/auth/device/token",
			"/api/auth/refresh",
			"/api/org/claim",
			"/api/auth/invites/accept",
		].includes(path)
	)
		return true;
	if (path === "/api/auth/invites/lookup") return true;
	if (path.startsWith("/api/auth/sso/") || path.startsWith("/api/auth/saml/")) return true;
	return false;
}

function isDashboardRequest(c: Context): boolean {
	const path = c.req.path;
	if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
	if (path.startsWith("/api/") || path.startsWith("/memory/") || path === "/mcp" || path.startsWith("/v1/")) {
		return false;
	}
	if (path === "/" || path.includes(".")) return true;
	return c.req.header("accept")?.includes("text/html") ?? false;
}
export function getPeerAddress(c: Context): string | null {
	try {
		const addr = (c.env as Record<string, unknown>)?.incoming as { socket?: { remoteAddress?: string } } | undefined;
		return addr?.socket?.remoteAddress ?? null;
	} catch {
		return null;
	}
}

export let hybridProxyDetected = false;
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];
export function isLoopbackRequest(c: Context): boolean {
	if (FORWARDED_HEADERS.some((header) => c.req.header(header) !== undefined)) {
		if (!hybridProxyDetected) console.warn("[auth] Hybrid proxy detected; forwarded requests require credentials");
		hybridProxyDetected = true;
		return false;
	}
	const remote = getPeerAddress(c);
	return remote ? LOOPBACK.has(remote) : false;
}

export function createAuthMiddleware(
	config: AuthConfig,
	secret: Buffer | null,
	verifyApiKey?: (token: string) => Promise<AuthResult>,
): MiddlewareHandler {
	const verify = async (token: string): Promise<AuthResult> => {
		if (isSignetApiKey(token) && verifyApiKey) return await verifyApiKey(token);
		if (secret) return verifyToken(secret, token);
		return { authenticated: false, claims: null, error: "auth secret not configured" };
	};
	const verifyOpen = async (path: string, token: string): Promise<AuthResult> => {
		if (isSignetApiKey(token) && path !== "/api/auth/whoami") return { authenticated: false, claims: null };
		try {
			return await verify(token);
		} catch {
			return { authenticated: false, claims: null, error: "credential could not be verified" };
		}
	};
	return async (c, next) => {
		const token = extractBearerToken(c.req.header("authorization"));
		if (isAuthOpenPath(c.req.path) || isDashboardRequest(c)) {
			c.set(
				"auth",
				token && config.mode !== "local" ? await verifyOpen(c.req.path, token) : { authenticated: false, claims: null },
			);
			if (config.mode === "hybrid" && isLoopbackRequest(c) && !c.get("auth")?.claims) {
				c.set("auth", { authenticated: false, claims: null, trustedLocal: true });
			}
			await next();
			return;
		}
		if (config.mode === "local") {
			c.set("auth", { authenticated: false, claims: null });
			await next();
			return;
		}
		if (config.mode === "hybrid" && isLoopbackRequest(c)) {
			c.set("auth", token ? await verify(token) : { authenticated: false, claims: null });
			await next();
			return;
		}
		if (!token) {
			c.status(401);
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ error: "authentication required", reason: "missing_credential" });
		}

		if (!secret && !(isSignetApiKey(token) && verifyApiKey)) {
			c.status(500);
			return c.json({ error: "auth secret not configured" });
		}

		const result = await verify(token);
		if (!result.authenticated) {
			c.status(401);
			c.header("WWW-Authenticate", "Bearer");
			return c.json({
				error: result.error ?? "invalid token",
				reason: result.error?.includes("expired")
					? "expired"
					: result.error?.includes("revoked")
						? "revoked"
						: "invalid_credential",
			});
		}

		c.set("auth", result);
		await next();
	};
}

export function requirePermission(permission: Permission, config: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		const auth = c.get("auth");
		if (config.mode === "hybrid" && isLoopbackRequest(c) && (!auth || !auth.claims)) {
			await next();
			return;
		}

		const principal = c.get("principal");
		const decision = principal
			? { allowed: principal.permissions.has(permission), reason: `credential lacks '${permission}' permission` }
			: checkPermission(auth?.claims ?? null, permission, config.mode);
		if (!decision.allowed) {
			c.status(403);
			return c.json({ error: decision.reason ?? "forbidden", reason: "permission", required: permission });
		}

		await next();
	};
}

export function requirePermissionWithRateLimit(
	permission: Permission,
	operation: string,
	limiter: AuthRateLimiter,
	config: AuthConfig,
): MiddlewareHandler {
	return async (c, next) => {
		const denied = await requirePermission(permission, config)(c, () => Promise.resolve());
		if (denied) return denied;
		const limited = await requireRateLimit(operation, limiter, config)(c, () => Promise.resolve());
		if (limited) return limited;
		await next();
	};
}

export function requireScope(getTarget: (c: Context) => TokenScope, config: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		const auth = c.get("auth");

		if (config.mode === "hybrid" && isLoopbackRequest(c) && (!auth || !auth.claims)) {
			await next();
			return;
		}

		const target = getTarget(c);
		const decision = checkScope(auth?.claims ?? null, target, config.mode);
		if (!decision.allowed) {
			c.status(403);
			return c.json({ error: decision.reason ?? "scope violation" });
		}

		await next();
	};
}

export function requireRateLimit(operation: string, limiter: AuthRateLimiter, config: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		if (config.mode === "local") {
			await next();
			return;
		}

		const auth = c.get("auth");
		const actor = auth?.claims?.sub ?? "anonymous";
		const key = `${actor}:${operation}`;

		const check = limiter.check(key);
		if (!check.allowed) {
			c.status(429);
			c.header("Retry-After", String(Math.ceil((check.resetAt - Date.now()) / 1000)));
			return c.json({
				error: "rate limit exceeded",
				retryAfter: check.resetAt,
			});
		}

		limiter.record(key);
		await next();
	};
}

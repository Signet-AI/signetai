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

function isLocalhost(c: Context): boolean {
	const remote = getPeerAddress(c);
	return remote ? LOOPBACK.has(remote) : false;
}

function setOptionalAuth(c: Context, secret: Buffer | null): void {
	const token = extractBearerToken(c.req.header("authorization"));
	if (token && secret) {
		c.set("auth", verifyToken(secret, token));
		return;
	}
	c.set("auth", { authenticated: false, claims: null });
}

export function createAuthMiddleware(
	config: AuthConfig,
	secret: Buffer | null,
	verifyApiKey?: (token: string) => AuthResult,
): MiddlewareHandler {
	return async (c, next) => {
		if (isAuthOpenPath(c.req.path) || isDashboardRequest(c)) {
			setOptionalAuth(c, secret);
			if (config.mode === "hybrid" && isLocalhost(c) && !c.get("auth")?.claims) {
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
		if (config.mode === "hybrid" && isLocalhost(c)) {
			const token = extractBearerToken(c.req.header("authorization"));
			if (token && isSignetApiKey(token) && verifyApiKey) {
				const result = verifyApiKey(token);
				c.set("auth", result);
			} else if (token && secret) {
				const result = verifyToken(secret, token);
				c.set("auth", result);
			} else {
				c.set("auth", { authenticated: false, claims: null });
			}
			await next();
			return;
		}
		const token = extractBearerToken(c.req.header("authorization"));
		if (!token) {
			c.status(401);
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ error: "authentication required" });
		}

		if (!secret && !(isSignetApiKey(token) && verifyApiKey)) {
			c.status(500);
			return c.json({ error: "auth secret not configured" });
		}

		const result = isSignetApiKey(token) && verifyApiKey ? verifyApiKey(token) : verifyToken(secret as Buffer, token);
		if (!result.authenticated) {
			c.status(401);
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ error: result.error ?? "invalid token" });
		}

		c.set("auth", result);
		await next();
	};
}

export function requirePermission(permission: Permission, config: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		const auth = c.get("auth");
		if (config.mode === "hybrid" && isLocalhost(c) && (!auth || !auth.claims)) {
			await next();
			return;
		}

		const decision = checkPermission(auth?.claims ?? null, permission, config.mode);
		if (!decision.allowed) {
			c.status(403);
			return c.json({ error: decision.reason ?? "forbidden" });
		}

		await next();
	};
}

export function requireScope(getTarget: (c: Context) => TokenScope, config: AuthConfig): MiddlewareHandler {
	return async (c, next) => {
		const auth = c.get("auth");

		if (config.mode === "hybrid" && isLocalhost(c) && (!auth || !auth.claims)) {
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

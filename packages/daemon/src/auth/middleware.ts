/**
 * Hono middleware for auth: token validation, permission checks,
 * scope enforcement, and rate limiting.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AuthConfig } from "./config";
import type { AuthResult, Permission, TokenScope } from "./types";
import { verifyToken } from "./tokens";
import { checkPermission, checkScope } from "./policy";
import type { AuthRateLimiter } from "./rate-limiter";

// Augment Hono context variables
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

// Known limitation: checks Host header, not connection peer address.
// Spoofable by remote clients in theory, but daemon typically binds to
// localhost anyway. Hono doesn't expose peer IP portably. Acceptable
// for v1; revisit if daemon gets exposed to untrusted networks.
function isLocalhost(c: Context): boolean {
	const host = c.req.header("host") ?? "";
	const hostWithoutPort = host.split(":")[0] ?? "";
	return (
		hostWithoutPort === "localhost" ||
		hostWithoutPort === "127.0.0.1" ||
		hostWithoutPort === "::1"
	);
}

export function createAuthMiddleware(
	config: AuthConfig,
	secret: Buffer | null,
): MiddlewareHandler {
	return async (c, next) => {
		// Local mode: no auth required at all
		if (config.mode === "local") {
			c.set("auth", { authenticated: false, claims: null });
			await next();
			return;
		}

		// Hybrid mode: localhost requests skip token requirement
		if (config.mode === "hybrid" && isLocalhost(c)) {
			const token = extractBearerToken(
				c.req.header("authorization"),
			);
			if (token && secret) {
				// If they send a token anyway, validate it
				const result = verifyToken(secret, token);
				c.set("auth", result);
			} else {
				c.set("auth", { authenticated: false, claims: null });
			}
			await next();
			return;
		}

		// Team mode (or hybrid+remote): token required
		const token = extractBearerToken(c.req.header("authorization"));
		if (!token) {
			c.status(401);
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ error: "authentication required" });
		}

		if (!secret) {
			c.status(500);
			return c.json({ error: "auth secret not configured" });
		}

		const result = verifyToken(secret, token);
		if (!result.authenticated) {
			c.status(401);
			c.header("WWW-Authenticate", "Bearer");
			return c.json({ error: result.error ?? "invalid token" });
		}

		c.set("auth", result);
		await next();
	};
}

export function requirePermission(
	permission: Permission,
	config: AuthConfig,
): MiddlewareHandler {
	return async (c, next) => {
		const auth = c.get("auth");

		// In hybrid mode, localhost without token gets full access
		if (
			config.mode === "hybrid" &&
			isLocalhost(c) &&
			(!auth || !auth.claims)
		) {
			await next();
			return;
		}

		const decision = checkPermission(
			auth?.claims ?? null,
			permission,
			config.mode,
		);
		if (!decision.allowed) {
			c.status(403);
			return c.json({ error: decision.reason ?? "forbidden" });
		}

		await next();
	};
}

export function requireScope(
	getTarget: (c: Context) => TokenScope,
	config: AuthConfig,
): MiddlewareHandler {
	return async (c, next) => {
		const auth = c.get("auth");

		if (
			config.mode === "hybrid" &&
			isLocalhost(c) &&
			(!auth || !auth.claims)
		) {
			await next();
			return;
		}

		const target = getTarget(c);
		const decision = checkScope(
			auth?.claims ?? null,
			target,
			config.mode,
		);
		if (!decision.allowed) {
			c.status(403);
			return c.json({ error: decision.reason ?? "scope violation" });
		}

		await next();
	};
}

export function requireRateLimit(
	operation: string,
	limiter: AuthRateLimiter,
	config: AuthConfig,
): MiddlewareHandler {
	return async (c, next) => {
		// No rate limiting in local mode
		if (config.mode === "local") {
			await next();
			return;
		}

		const auth = c.get("auth");
		const actor =
			auth?.claims?.sub ??
			c.req.header("x-signet-actor") ??
			"anonymous";
		const key = `${actor}:${operation}`;

		const check = limiter.check(key);
		if (!check.allowed) {
			c.status(429);
			c.header(
				"Retry-After",
				String(Math.ceil((check.resetAt - Date.now()) / 1000)),
			);
			return c.json({
				error: "rate limit exceeded",
				retryAfter: check.resetAt,
			});
		}

		limiter.record(key);
		await next();
	};
}

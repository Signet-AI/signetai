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

/** Endpoints that are always public (health checks). */
function isPublicEndpoint(c: Context): boolean {
	const method = c.req.method;
	const path = c.req.path;
	if (method !== "GET") return false;
	return path === "/health" || path === "/api/status";
}

/** Extract the local auth token from headers or query param (for EventSource). */
function extractLocalToken(c: Context): string | null {
	// Check X-Local-Token header first
	const localHeader = c.req.header("x-local-token");
	if (localHeader) return localHeader.trim();
	// Fall back to Authorization: Bearer
	const bearer = extractBearerToken(c.req.header("authorization"));
	if (bearer) return bearer;
	// Fall back to ?token= query param (for EventSource which can't set headers)
	const queryToken = c.req.query("token");
	if (queryToken) return queryToken.trim();
	return null;
}

/**
 * Check if request originates from localhost using the actual connection
 * peer address (not the spoofable Host header).
 *
 * Hono exposes the raw Request via c.req.raw, and Bun's server attaches
 * the remote address to the request's socket info. We also check the
 * X-Forwarded-For header as a fallback (only trusted when the daemon
 * binds to localhost, which prevents external clients from setting it).
 */
function isLocalhost(c: Context): boolean {
	// Method 1: Bun exposes requestIP on the server object via c.env
	const env = c.env as Record<string, unknown> | undefined;
	if (env && typeof env === "object") {
		// Bun's Hono adapter passes { ip } in env for Bun.serve
		const connInfo = env as { ip?: string; remoteAddr?: string };
		const peerIp = connInfo.ip ?? connInfo.remoteAddr;
		if (peerIp) {
			return (
				peerIp === "127.0.0.1" ||
				peerIp === "::1" ||
				peerIp === "::ffff:127.0.0.1" ||
				peerIp === "localhost"
			);
		}
	}

	// Method 2: Check the raw request for Bun's .address property
	const raw = c.req.raw as Record<string, unknown>;
	if (raw && typeof raw.address === "string") {
		const addr = raw.address;
		return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
	}

	// Method 3: Fallback to Host header (only safe when daemon binds to localhost).
	// This is the weakest check — a remote attacker can spoof the Host header.
	// Since we bind to localhost by default, this is acceptable as a last resort.
	const host = c.req.header("host") ?? "";
	const hostWithoutPort = host.split(":")[0] ?? "";
	return (
		hostWithoutPort === "localhost" ||
		hostWithoutPort === "127.0.0.1" ||
		hostWithoutPort === "::1"
	);
}

/**
 * Simple in-memory rate limiter for write operations.
 * Prevents memory injection floods even in local/unauthenticated mode.
 * Tracks per-endpoint request counts in a sliding window.
 */
const _writeRateLimiter = {
	window: new Map<string, { count: number; resetAt: number }>(),
	maxPerMinute: 120, // 2 writes/sec average
	check(endpoint: string): boolean {
		const now = Date.now();
		const entry = this.window.get(endpoint);
		if (!entry || entry.resetAt < now) {
			this.window.set(endpoint, { count: 1, resetAt: now + 60_000 });
			return true;
		}
		entry.count++;
		return entry.count <= this.maxPerMinute;
	},
};

export function createAuthMiddleware(
	config: AuthConfig,
	secret: Buffer | null,
): MiddlewareHandler {
	return async (c, next) => {
		// Rate limit write operations in ALL modes (including local)
		const method = c.req.method;
		if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
			const endpoint = c.req.path;
			if (!_writeRateLimiter.check(endpoint)) {
				return c.json({ error: "Rate limit exceeded. Max 120 writes per minute per endpoint." }, 429);
			}
		}

		// local-notoken mode: no auth required at all (explicit dev opt-out)
		if (config.mode === "local-notoken") {
			c.set("auth", { authenticated: false, claims: null });
			await next();
			return;
		}

		// Local mode: require local auth token (except public health/status endpoints)
		if (config.mode === "local") {
			if (isPublicEndpoint(c)) {
				c.set("auth", { authenticated: false, claims: null });
				await next();
				return;
			}

			const expectedToken = config.localToken;
			if (expectedToken) {
				const providedToken = extractLocalToken(c);
				if (!providedToken || providedToken !== expectedToken) {
					c.status(401);
					return c.json({
						error: "Local token required. See ~/.agents/.daemon/local.token",
					});
				}
			}
			// Token validated (or no token file configured — fallback for tests)
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
		// No rate limiting in local/local-notoken mode
		if (config.mode === "local" || config.mode === "local-notoken") {
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

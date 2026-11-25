import "./request-read";
import { organizationReadRequest } from "./auth/agent-access";
import { requestRoute } from "./request-route";
import { isIP } from "node:net";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { isAuthOpenPath } from "./auth";
import { createIdentityMiddleware } from "./auth/identity-middleware";
import { bufferReadAudit } from "./auth/organization-runtime";
import { logger } from "./logger";
import { analyticsCollector, authConfig, authSecret, isAllowedOrigin, shuttingDown } from "./routes/state.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isForeignBrowserWrite(c: Context): boolean {
	if (!UNSAFE_METHODS.has(c.req.method) || isAuthOpenPath(c.req.path)) return false;
	const origin = c.req.header("origin");
	if (origin !== undefined && isAllowedOrigin(origin)) return false;
	if (c.req.header("sec-fetch-site") === "cross-site") return true;
	if (origin === undefined) return false;
	const url = new URL(c.req.url);
	if (origin !== url.origin) return true;
	const host = url.hostname.replace(/\.$/, "");
	return !LOOPBACK_HOSTNAMES.has(host) && isIP(host.replace(/^\[|\]$/g, "")) === 0;
}

export function registerGlobalMiddleware(app: Hono): void {
	app.use(
		"*",
		cors({
			origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
			credentials: true,
		}),
	);
	app.use("*", async (c, next) => {
		if (shuttingDown && !c.req.path.startsWith("/health")) {
			c.status(503);
			return c.json({ error: "shutting down" });
		}
		return next();
	});
	const limitBody = bodyLimit({ maxSize: 10 * 1_048_576, onError: (c) => c.json({ error: "payload too large" }, 413) });
	const stopBody = bodyLimit({ maxSize: 2 * 1_048_576, onError: (c) => c.json({ error: "payload too large" }, 413) });
	const importBody = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) });
	app.use("*", (c, next) =>
		c.req.method === "PUT" && /^\/api\/sources\/imports\/[^/]+\/files\/[^/]+$/.test(c.req.path)
			? next()
			: c.req.path === "/api/hooks/stop"
				? stopBody(c, next)
				: c.req.method === "POST" && c.req.path === "/api/sources/imports"
					? importBody(c, next)
					: limitBody(c, next),
	);
	let identityConfig = authConfig,
		identitySecret = authSecret,
		identity = createIdentityMiddleware(identityConfig, identitySecret);
	app.use("*", async (c, next) => {
		if (authConfig.mode !== "local" && !authSecret) {
			c.status(503);
			return c.json({ error: "server initializing" });
		}
		if (identityConfig !== authConfig || identitySecret !== authSecret) {
			identityConfig = authConfig;
			identitySecret = authSecret;
			identity = createIdentityMiddleware(identityConfig, identitySecret);
		}
		return identity(c, next);
	});
	app.use("*", async (c, next) => {
		if (authConfig.mode !== "team" && !c.get("auth")?.claims && isForeignBrowserWrite(c)) {
			return c.json({ error: "cross-origin request rejected" }, 403);
		}
		return next();
	});
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		const duration = Date.now() - start;
		const principal = c.get("principal");
		if (
			c.get("organization") &&
			principal &&
			organizationReadRequest(c.req.method, c.req.path) &&
			c.req.path.startsWith("/api/")
		)
			bufferReadAudit(principal, requestRoute(c), c.get("readAuditAgent"), c.get("readAuditCount") ?? null);
		logger.api.request(c.req.method, requestRoute(c), c.res.status, duration);
		const actor = c.req.header("x-signet-actor");
		analyticsCollector.recordRequest(c.req.method, requestRoute(c), c.res.status, duration, actor ?? undefined);
		const p = c.req.path;
		if (p.includes("/remember") || p.includes("/save")) {
			analyticsCollector.recordLatency("remember", duration);
		} else if (p.includes("/recall") || p.includes("/search") || p.includes("/similar")) {
			analyticsCollector.recordLatency("recall", duration);
		} else if (p.includes("/modify") || p.includes("/forget") || p.includes("/recover")) {
			analyticsCollector.recordLatency("mutate", duration);
		}
	});
}

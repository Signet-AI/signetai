import { isIP } from "node:net";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createAuthMiddleware, isAuthOpenPath, verifyApiKey } from "./auth";
import { isLocalhost } from "./auth/middleware";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { analyticsCollector, authConfig, authSecret, isAllowedOrigin, shuttingDown } from "./routes/state.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\//;

function trustsRequestWithoutCredential(c: Context): boolean {
	if (authConfig.mode === "local") return true;
	return authConfig.mode === "hybrid" && !c.req.header("authorization") && isLocalhost(c);
}

function isForeignBrowserWrite(c: Context): boolean {
	if (!UNSAFE_METHODS.has(c.req.method) || isAuthOpenPath(c.req.path)) return false;
	const origin = c.req.header("origin");
	if (origin === undefined) return c.req.header("sec-fetch-site") === "cross-site";
	if (isAllowedOrigin(origin) || EXTENSION_ORIGIN.test(origin)) return false;
	const url = new URL(c.req.url);
	if (origin !== url.origin) return true;
	return !LOOPBACK_HOSTNAMES.has(url.hostname) && isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0;
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
		if (trustsRequestWithoutCredential(c) && isForeignBrowserWrite(c)) {
			return c.json({ error: "cross-origin request rejected" }, 403);
		}
		return next();
	});
	app.use("*", async (c, next) => {
		if (shuttingDown && !c.req.path.startsWith("/health")) {
			c.status(503);
			return c.json({ error: "shutting down" });
		}
		return next();
	});
	app.use("*", async (c, next) => {
		if (authConfig.mode !== "local" && !authSecret) {
			c.status(503);
			return c.json({ error: "server initializing" });
		}
		const mw = createAuthMiddleware(authConfig, authSecret, (token) => verifyApiKey(getDbAccessor(), token));
		return mw(c, next);
	});
	const limitBody = bodyLimit({
		maxSize: 10 * 1_048_576,
		onError: (c) => c.json({ error: "payload too large" }, 413),
	});
	app.use("*", (c, next) =>
		c.req.method === "PUT" && /^\/api\/sources\/imports\/[^/]+\/files\/[^/]+$/.test(c.req.path)
			? next()
			: limitBody(c, next),
	);
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		const duration = Date.now() - start;
		logger.api.request(c.req.method, c.req.path, c.res.status, duration);
		const actor = c.req.header("x-signet-actor");
		analyticsCollector.recordRequest(c.req.method, c.req.path, c.res.status, duration, actor ?? undefined);
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

import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createAuthMiddleware, verifyApiKey } from "./auth";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { analyticsCollector, authConfig, authSecret, isAllowedOrigin, shuttingDown } from "./routes/state.js";

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

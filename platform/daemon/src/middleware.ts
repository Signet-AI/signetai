/**
 * Global Hono middleware extracted from daemon.ts.
 * Registers CORS, shutdown guard, auth, and request logging.
 */

import type { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuthMiddleware, verifyApiKey } from "./auth";
import { getDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import {
	analyticsCollector,
	authConfig,
	authSecret,
	isAllowedOrigin,
	shuttingDown,
} from "./routes/state.js";

export function registerGlobalMiddleware(app: Hono): void {
	// MW-1: CORS
	app.use(
		"*",
		cors({
			origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
			credentials: true,
		}),
	);

	// MW-2: Shutdown guard
	app.use("*", async (c, next) => {
		// Liveness/readiness probes must keep answering during shutdown: /health
		// and /health/live report liveness, /health/ready returns its structured
		// 503 rather than the guard's generic one.
		if (shuttingDown && !c.req.path.startsWith("/health")) {
			c.status(503);
			return c.json({ error: "shutting down" });
		}
		return next();
	});

	// MW-3: Auth
	app.use("*", async (c, next) => {
		if (authConfig.mode !== "local" && !authSecret) {
			c.status(503);
			return c.json({ error: "server initializing" });
		}
		const mw = createAuthMiddleware(authConfig, authSecret, (token) => verifyApiKey(getDbAccessor(), token));
		return mw(c, next);
	});

	// MW-4: Request logging + analytics
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

/**
 * Global Hono middleware extracted from daemon.ts.
 * Registers CORS, shutdown guard, auth, request logging, and shadow divergence.
 */

import type { ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuthMiddleware } from "./auth";
import { logger } from "./logger";
import {
	AGENTS_DIR,
	analyticsCollector,
	authConfig,
	authSecret,
	isAllowedOrigin,
	shuttingDown,
} from "./routes/state.js";

interface MiddlewareDeps {
	getShadowProcess: () => ChildProcess | null;
}

function appendDivergence(agentsDir: string, entry: Record<string, unknown>): void {
	const logPath = join(agentsDir, ".daemon", "logs", "shadow-divergences.jsonl");
	appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

export function registerGlobalMiddleware(app: Hono, deps: MiddlewareDeps): void {
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
		if (shuttingDown && c.req.path !== "/health") {
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
		const mw = createAuthMiddleware(authConfig, authSecret);
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

	// MW-5: Shadow divergence logging
	app.use("*", async (c, next) => {
		const method = c.req.method;
		const bodyP = ["POST", "PUT", "PATCH"].includes(method)
			? c.req.text().catch(() => undefined)
			: Promise.resolve(undefined);
		await next();
		if (!deps.getShadowProcess()) return;
		const reqPath = c.req.path;
		const search = new URL(c.req.url).search;
		const primaryStatus = c.res.status;
		bodyP
			.then((rawBody) =>
				fetch(`http://localhost:3851${reqPath}${search}`, {
					method,
					headers: Object.fromEntries(c.req.raw.headers),
					body: rawBody,
					signal: AbortSignal.timeout(5000),
				}),
			)
			.then((shadow) => {
				if (primaryStatus !== shadow.status) {
					appendDivergence(AGENTS_DIR, {
						path: reqPath,
						method,
						primaryStatus,
						shadowStatus: shadow.status,
					});
				}
				return shadow.body?.cancel();
			})
			.catch(() => {});
	});
}

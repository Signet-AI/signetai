import type { Hono } from "hono";
import {
	createToken,
	requirePermission,
	requireRateLimit,
	type TokenRole,
	type TokenScope,
} from "../auth";
import { authAdminLimiter, authConfig, authSecret } from "./state.js";

export function registerAuthRoutes(app: Hono): void {
	app.get("/api/auth/whoami", (c) => {
		const auth = c.get("auth");
		return c.json({
			authenticated: auth?.authenticated ?? false,
			claims: auth?.claims ?? null,
			mode: authConfig.mode,
		});
	});

	app.use("/api/auth/token", async (c, next) => {
		const perm = requirePermission("admin", authConfig);
		const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
		await perm(c, async () => {
			await rate(c, next);
		});
	});

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
}

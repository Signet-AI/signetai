import type { Context, Hono, Next } from "hono";
import {
	createApiKey,
	createToken,
	listApiKeys,
	requirePermission,
	revokeApiKey,
	requireRateLimit,
	type Permission,
	type TokenRole,
	type TokenScope,
} from "../auth";
import { getDbAccessor } from "../db-accessor.js";
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

	const requireAdminAuth = async (c: Context, next: Next) => {
		const perm = requirePermission("admin", authConfig);
		const rate = requireRateLimit("admin", authAdminLimiter, authConfig);
		await perm(c, async () => {
			await rate(c, next);
		});
	};

	app.use("/api/auth/token", requireAdminAuth);
	app.use("/api/auth/api-keys", requireAdminAuth);
	app.use("/api/auth/api-keys/*", requireAdminAuth);

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

	app.get("/api/auth/api-keys", (c) => {
		return c.json({ apiKeys: listApiKeys(getDbAccessor()) });
	});

	app.post("/api/auth/api-keys", async (c) => {
		const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!payload) return c.json({ error: "invalid request body" }, 400);
		const name = typeof payload.name === "string" ? payload.name.trim() : "";
		if (!name) return c.json({ error: "name is required" }, 400);
		const role = typeof payload.role === "string" ? payload.role : undefined;
		const validRoles: TokenRole[] = ["admin", "operator", "agent", "readonly"];
		if (role !== undefined && !validRoles.includes(role as TokenRole)) {
			return c.json({ error: `role must be one of: ${validRoles.join(", ")}` }, 400);
		}
		try {
			const apiKey = createApiKey(getDbAccessor(), {
				name,
				role: role as TokenRole | undefined,
				scope: (payload.scope ?? {}) as TokenScope,
				permissions: Array.isArray(payload.permissions)
					? payload.permissions.filter((permission): permission is Permission => typeof permission === "string")
					: undefined,
				connector: typeof payload.connector === "string" ? payload.connector : undefined,
				harness: typeof payload.harness === "string" ? payload.harness : undefined,
				agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
				allowedProjects: Array.isArray(payload.allowedProjects)
					? payload.allowedProjects.filter((project): project is string => typeof project === "string")
					: undefined,
				expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
			});
			return c.json({ apiKey }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, 400);
		}
	});

	app.delete("/api/auth/api-keys/:id", (c) => {
		const id = c.req.param("id");
		const revoked = revokeApiKey(getDbAccessor(), id);
		if (!revoked) return c.json({ error: "API key not found" }, 404);
		return c.json({ apiKey: revoked });
	});
}

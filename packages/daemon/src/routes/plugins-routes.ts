import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { queryPluginAuditEvents } from "../plugins/audit.js";
import type { PluginHostV1 } from "../plugins/index.js";
import { getDefaultPluginHost } from "../plugins/index.js";
import { authConfig } from "./state.js";

export function registerPluginRoutes(app: Hono, host: PluginHostV1 = getDefaultPluginHost()): void {
	// Permission guards
	app.use("/api/plugins", async (c, next) => {
		return requirePermission("admin", authConfig)(c, next);
	});
	app.use("/api/plugins/*", async (c, next) => {
		return requirePermission("admin", authConfig)(c, next);
	});

	app.get("/api/plugins", (c) => {
		return c.json({ plugins: host.list() });
	});

	app.get("/api/plugins/prompt-contributions", (c) => {
		const contributions = host.promptContributions();
		return c.json({ contributions, activeCount: contributions.length });
	});

	app.get("/api/plugins/audit", (c) => {
		return c.json(
			queryPluginAuditEvents({
				pluginId: c.req.query("pluginId") ?? undefined,
				event: c.req.query("event") ?? undefined,
				since: parseIsoDateQuery(c.req.query("since") ?? undefined),
				until: parseIsoDateQuery(c.req.query("until") ?? undefined),
				limit: parseBoundedInt(c.req.query("limit"), 100, 1, 500),
			}),
		);
	});

	app.get("/api/plugins/:id/diagnostics", (c) => {
		const plugin = host.diagnostics(c.req.param("id"));
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);
		return c.json({ plugin });
	});

	app.get("/api/plugins/:id", (c) => {
		const plugin = host.get(c.req.param("id"));
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);
		return c.json(plugin);
	});

	app.patch("/api/plugins/:id", async (c) => {
		const body = await c.req.json<Record<string, unknown>>().catch(() => null);
		if (!body) return c.json({ error: "Invalid JSON body" }, 400);
		const enabled = parseOptionalBoolean(body.enabled);
		if (enabled === undefined) return c.json({ error: "enabled is required" }, 400);
		const plugin = host.setEnabled(c.req.param("id"), enabled);
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);
		return c.json({ plugin });
	});
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
	const raw = await req.text();
	if (!raw.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return undefined;
	}
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (lower === "1" || lower === "true") return true;
		if (lower === "0" || lower === "false") return false;
	}
	return undefined;
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function parseIsoDateQuery(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const value = raw.trim();
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

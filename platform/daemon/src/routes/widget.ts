import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";

import { createEvent, eventBus } from "../event-bus";
import { logger } from "../logger";
import { loadProbeResult } from "../mcp-probe";
import { deleteCachedWidget, generateWidgetHtml, loadCachedWidget, widgetDir } from "../widget-gen";
export function mountWidgetRoutes(app: Hono): void {
	app.post("/api/os/widget/generate", async (c) => {
		let body: { serverId?: string; force?: boolean } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
		if (serverId.length === 0) {
			return c.json({ error: "serverId is required" }, 400);
		}
		if (!body.force) {
			const cached = loadCachedWidget(serverId);
			if (cached) {
				logger.info("widget", `Returning cached widget for ${serverId}`);
				return c.json({ status: "cached", html: cached });
			}
		}
		generateWidgetHtml(serverId, loadProbeResult(serverId)).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("widget", `Async widget generation failed for ${serverId}`, {
				error: msg,
			});
			eventBus.emit(
				createEvent("system", "widget.error", {
					serverId,
					error: msg,
				}),
			);
		});

		logger.info("widget", `Widget generation started for ${serverId}`);
		return c.json({ status: "generating" }, 202);
	});
	app.get("/api/os/widget/:id", (c) => {
		const id = c.req.param("id");
		const html = loadCachedWidget(id);
		if (!html) {
			return c.json({ error: "Widget not found" }, 404);
		}
		const path = join(widgetDir(), `${id}.html`);
		let generatedAt: string | null = null;
		try {
			if (existsSync(path)) {
				const stat = statSync(path);
				generatedAt = stat.mtime.toISOString();
			}
		} catch {}

		return c.json({ html, generatedAt });
	});
	app.delete("/api/os/widget/:id", (c) => {
		const id = c.req.param("id");
		deleteCachedWidget(id);
		return c.json({ success: true });
	});
}

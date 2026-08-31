/** Widget API routes — generation, retrieval, and deletion of LLM-generated widgets. */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";

import { createEvent, eventBus } from "../event-bus";
import { logger } from "../logger";
import { loadProbeResult } from "../mcp-probe";
import { deleteCachedWidget, generateWidgetHtml, loadCachedWidget, widgetDir } from "../widget-gen";

/**
 * Mount widget routes on the Hono app.
 */
export function mountWidgetRoutes(app: Hono): void {
	/**
	 * POST /api/os/widget/generate — generate a widget for an MCP server.
	 *
	 * If a cached widget exists and `force` is not set, returns the cached
	 * version immediately. Otherwise spawns async generation and returns 202.
	 */
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

		// Return cached widget unless force-regeneration requested
		if (!body.force) {
			const cached = loadCachedWidget(serverId);
			if (cached) {
				logger.info("widget", `Returning cached widget for ${serverId}`);
				return c.json({ status: "cached", html: cached });
			}
		}

		// Spawn async generation — don't block the response
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

	/**
	 * GET /api/os/widget/:id — retrieve a cached widget by server ID.
	 */
	app.get("/api/os/widget/:id", (c) => {
		const id = c.req.param("id");
		const html = loadCachedWidget(id);
		if (!html) {
			return c.json({ error: "Widget not found" }, 404);
		}

		// Use file stat for generatedAt timestamp
		const path = join(widgetDir(), `${id}.html`);
		let generatedAt: string | null = null;
		try {
			if (existsSync(path)) {
				const stat = statSync(path);
				generatedAt = stat.mtime.toISOString();
			}
		} catch {
			// Stat failed — omit timestamp
		}

		return c.json({ html, generatedAt });
	});

	/**
	 * DELETE /api/os/widget/:id — delete a cached widget.
	 */
	app.delete("/api/os/widget/:id", (c) => {
		const id = c.req.param("id");
		deleteCachedWidget(id);
		return c.json({ success: true });
	});
}

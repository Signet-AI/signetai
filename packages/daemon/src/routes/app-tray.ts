/**
 * App Tray API routes — Signet OS Phase 1b
 *
 * Exposes endpoints for the dashboard to read/manage the app tray
 * (installed MCP servers with their probe results and manifests).
 */

import type { Hono } from "hono";
import {
	loadAppTray,
	loadProbeResult,
	probeServer,
	reprobeServer,
	storeProbeResult,
} from "../mcp-probe.js";
import { logger } from "../logger.js";

/**
 * Mount app tray routes on the Hono app.
 */
export function mountAppTrayRoutes(app: Hono): void {
	/**
	 * GET /api/os/tray — list all app tray entries
	 */
	app.get("/api/os/tray", (c) => {
		const tray = loadAppTray();
		return c.json({
			entries: tray,
			count: tray.length,
		});
	});

	/**
	 * GET /api/os/tray/:id — get a single app tray entry
	 */
	app.get("/api/os/tray/:id", (c) => {
		const id = c.req.param("id");
		const tray = loadAppTray();
		const entry = tray.find((e) => e.id === id);
		if (!entry) {
			return c.json({ error: "App not found in tray" }, 404);
		}
		return c.json({ entry });
	});

	/**
	 * GET /api/os/tray/:id/probe — get the full probe result for a server
	 */
	app.get("/api/os/tray/:id/probe", (c) => {
		const id = c.req.param("id");
		const result = loadProbeResult(id);
		if (!result) {
			return c.json({ error: "No probe result found" }, 404);
		}
		return c.json({ probe: result });
	});

	/**
	 * POST /api/os/tray/:id/reprobe — re-probe a server (e.g., after it comes online)
	 */
	app.post("/api/os/tray/:id/reprobe", async (c) => {
		const id = c.req.param("id");

		// We need to find the server config from installed servers
		// Import dynamically to avoid circular dependency
		const { readInstalledServersPublic } = await import("./marketplace-helpers.js");
		const installed = readInstalledServersPublic();
		const server = installed.find((s) => s.id === id);

		if (!server) {
			return c.json({ error: "Server not found in installed servers" }, 404);
		}

		try {
			const result = await reprobeServer(server);
			return c.json({
				success: true,
				probe: result,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("probe", `Re-probe failed for ${id}: ${msg}`);
			return c.json({ success: false, error: msg }, 500);
		}
	});

	/**
	 * PATCH /api/os/tray/:id — update tray entry state (e.g., move to grid/dock)
	 */
	app.patch("/api/os/tray/:id", async (c) => {
		const id = c.req.param("id");
		let body: {
			state?: string;
			gridPosition?: { x: number; y: number; w: number; h: number };
		} = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const tray = loadAppTray();
		const index = tray.findIndex((e) => e.id === id);
		if (index < 0) {
			return c.json({ error: "App not found in tray" }, 404);
		}

		const validStates = ["tray", "grid", "dock"];
		if (body.state && !validStates.includes(body.state)) {
			return c.json({ error: "state must be tray, grid, or dock" }, 400);
		}

		const updated = {
			...tray[index],
			...(body.state ? { state: body.state as "tray" | "grid" | "dock" } : {}),
			...(body.gridPosition ? { gridPosition: body.gridPosition } : {}),
			updatedAt: new Date().toISOString(),
		};

		tray[index] = updated;

		const { writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { homedir } = await import("node:os");
		const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
		const trayPath = join(agentsDir, "marketplace", "app-tray.json");
		writeFileSync(trayPath, JSON.stringify(tray, null, 2));

		return c.json({ success: true, entry: updated });
	});
}

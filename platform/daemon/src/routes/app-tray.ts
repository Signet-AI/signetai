/** App Tray API routes — CRUD for app tray entries and MCP install endpoint. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoCardResource, AutoCardToolAction } from "@signet/core";
import type { Hono } from "hono";

import { resolveDefaultBasePath } from "@signet/core";
import { logger } from "../logger.js";
import { installMcpServer, MarketplaceInstallError } from "../mcp-install-service.js";
import type { MarketplaceMcpInstallDependencies } from "../mcp-install-service.js";
import { loadAppTray, loadProbeResult, reprobeServer } from "../mcp-probe.js";
import { readInstalledServersPublic } from "./marketplace-helpers.js";

function isValidState(s: string): s is "tray" | "grid" | "dock" {
	return s === "tray" || s === "grid" || s === "dock";
}

/** Resolve an icon URL from a marketplace source and catalog ID. */
function resolveServerIcon(source: string, catalogId?: string): string | null {
	if (source === "modelcontextprotocol/servers") return "https://github.com/modelcontextprotocol.png?size=40";
	if (source === "github" && catalogId?.includes("/")) {
		const org = catalogId.split("/")[0];
		if (org && org.length > 0) return `https://github.com/${org}.png?size=40`;
	}
	return null;
}

const GRID_COLS = 12;

/**
 * Find the first free grid position that can fit a widget of size (w, h).
 * Scans row by row (y=0,1,2,...) and column by column (x=0..GRID_COLS-w).
 */
function findFreeGridPosition(
	occupied: Array<{ x: number; y: number; w: number; h: number }>,
	w: number,
	h: number,
): { x: number; y: number; w: number; h: number } {
	const collides = (x: number, y: number, w: number, h: number): boolean => {
		for (const o of occupied) {
			if (x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y) {
				return true;
			}
		}
		return false;
	};

	// Scan up to 50 rows
	for (let y = 0; y < 50; y++) {
		for (let x = 0; x <= GRID_COLS - w; x++) {
			if (!collides(x, y, w, h)) {
				return { x, y, w, h };
			}
		}
	}

	// Fallback: place at bottom
	const maxY = occupied.reduce((max, o) => Math.max(max, o.y + o.h), 0);
	return { x: 0, y: maxY, w, h };
}

/**
 * Mount app tray routes on the Hono app.
 */
export function mountAppTrayRoutes(app: Hono, installDependencies: MarketplaceMcpInstallDependencies = {}): void {
	/**
	 * GET /api/os/tray — list all app tray entries.
	 * Automatically syncs installed MCP servers that are missing
	 * from the tray so pre-installed apps appear without manual
	 * probe/install actions.
	 */
	app.get("/api/os/tray", (c) => {
		const tray = loadAppTray();
		const installed = readInstalledServersPublic();
		const installedById = new Map(installed.map((s) => [s.id, s]));
		const trayIds = new Set(tray.map((e) => e.id));

		// Backfill icons on existing entries that have none
		for (const entry of tray) {
			if (!entry.icon) {
				const server = installedById.get(entry.id);
				if (server) {
					(entry as { icon: string | null }).icon = resolveServerIcon(server.source, server.catalogId);
				}
			}
		}

		const missing = installed.filter((s) => s.enabled && !trayIds.has(s.id));

		if (missing.length > 0) {
			const now = new Date().toISOString();
			const stubs = missing.map((server) => ({
				id: server.id,
				name: server.name,
				icon: resolveServerIcon(server.source, server.catalogId) ?? undefined,
				state: "tray" as const,
				manifest: {
					name: server.name,
					defaultSize: { w: 4, h: 3 },
				},
				autoCard: {
					name: server.name,
					tools: [] as AutoCardToolAction[],
					resources: [] as AutoCardResource[],
					hasAppResources: false,
					defaultSize: { w: 4, h: 3 },
				},
				hasDeclaredManifest: false,
				createdAt: now,
				updatedAt: now,
			}));

			// Best-effort persist: reload the latest tray before writing
			// to avoid overwriting concurrent PATCH updates
			try {
				ensureMarketplaceDir();
				const fresh = loadAppTray();
				const freshIds = new Set(fresh.map((e) => e.id));
				const toAdd = stubs.filter((s) => !freshIds.has(s.id));
				if (toAdd.length > 0) {
					writeFileSync(join(getMarketplaceDir(), "app-tray.json"), JSON.stringify([...fresh, ...toAdd], null, 2));
				}
				logger.info("os", `Synced ${toAdd.length} installed server(s) to app tray`);
			} catch (err) {
				logger.warn("os", `Failed to persist auto-synced tray entries: ${err}`);
			}

			// Return the merged view regardless of persist success
			for (const stub of stubs) tray.push(stub);
		}

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

		if (body.state && !isValidState(body.state)) {
			return c.json({ error: "state must be tray, grid, or dock" }, 400);
		}
		const validState = body.state && isValidState(body.state) ? body.state : undefined;

		const updated = {
			...tray[index],
			...(validState ? { state: validState } : {}),
			...(body.gridPosition ? { gridPosition: body.gridPosition } : {}),
			updatedAt: new Date().toISOString(),
		};

		tray[index] = updated;

		const agentsDir = resolveDefaultBasePath();
		const trayPath = join(agentsDir, "marketplace", "app-tray.json");
		writeFileSync(trayPath, JSON.stringify(tray, null, 2));

		return c.json({ success: true, entry: updated });
	});

	/** POST /api/os/install — install an MCP server by URL */
	app.post("/api/os/install", async (c) => {
		let body: {
			url?: string;
			name?: string;
			autoPlace?: boolean;
		} = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ ok: false, widgetId: "", manifest: null, error: "Invalid JSON body" }, 400);
		}

		const url = body.url?.trim();
		if (!url) {
			return c.json({ ok: false, widgetId: "", manifest: null, error: "url is required" }, 400);
		}

		const nameOverride = body.name?.trim() || undefined;
		const autoPlace = body.autoPlace === true;

		try {
			const mcpServersOrgMatch = url.match(
				/^https?:\/\/(?:www\.)?mcpservers\.org\/(?:[a-z][a-z-]{1,9}\/)?servers\/(.+?)(?:\/|\?|#|$)/,
			);
			const installResult = mcpServersOrgMatch
				? await installMcpServer(
						{
							kind: "catalog",
							source: "mcpservers.org",
							catalogId: mcpServersOrgMatch[1],
							alias: nameOverride,
						},
						{
							signal: c.req.raw.signal,
							idempotencyKey: c.req.header("Idempotency-Key"),
						},
						installDependencies,
					)
				: await installMcpServer(
						{ kind: "direct", url, name: nameOverride },
						{
							signal: c.req.raw.signal,
							idempotencyKey: c.req.header("Idempotency-Key"),
						},
						installDependencies,
					);

			const manifest = installResult.probe?.declaredManifest ?? null;

			// If autoPlace, find free grid position and update tray entry
			if (autoPlace && installResult.status === "completed") {
				const tray = loadAppTray();
				const entry = tray.find((e) => e.id === installResult.server.id);
				if (entry) {
					const occupiedPositions = tray.flatMap((e) =>
						e.state === "grid" && e.gridPosition && e.id !== installResult.server.id ? [e.gridPosition] : [],
					);

					const defaultSize = manifest?.defaultSize ?? entry.autoCard?.defaultSize ?? { w: 4, h: 3 };
					const pos = findFreeGridPosition(occupiedPositions, defaultSize.w, defaultSize.h);

					const idx = tray.findIndex((e) => e.id === installResult.server.id);
					if (idx >= 0) {
						tray[idx] = {
							...tray[idx],
							state: "grid",
							gridPosition: pos,
							updatedAt: new Date().toISOString(),
						};
						const agentsDir = resolveDefaultBasePath();
						const trayPath = join(agentsDir, "marketplace", "app-tray.json");
						writeFileSync(trayPath, JSON.stringify(tray, null, 2));
					}
				}
			}

			return c.json(
				{
					ok: true,
					widgetId: installResult.server.id,
					manifest,
					created: installResult.created,
					updated: installResult.updated,
					status: installResult.status,
					operationId: installResult.operationId,
				},
				installResult.status === "accepted" ? 202 : 200,
			);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("probe", `Install failed: ${msg}`);
			const status =
				error instanceof MarketplaceInstallError
					? error.code === "timeout"
						? 504
						: error.code === "missing_config"
							? 422
							: 400
					: 500;
			return c.json({ ok: false, widgetId: "", manifest: null, error: msg }, status);
		}
	});
}

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

function getMarketplaceDir(): string {
	return join(getAgentsDir(), "marketplace");
}

function ensureMarketplaceDir(): void {
	const dir = getMarketplaceDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

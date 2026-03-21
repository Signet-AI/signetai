/** App Tray API routes — CRUD for app tray entries and MCP install endpoint. */

import type { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AutoCardToolAction, AutoCardResource, SignetAppManifest } from "@signet/core";

import { isPrivateHostname } from "../url-validation.js";
import {
	loadAppTray,
	loadProbeResult,
	probeServer,
	reprobeServer,
	storeProbeResult,
} from "../mcp-probe.js";
import { logger } from "../logger.js";
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
	const collides = (
		x: number,
		y: number,
		w: number,
		h: number,
	): boolean => {
		for (const o of occupied) {
			if (
				x < o.x + o.w &&
				x + w > o.x &&
				y < o.y + o.h &&
				y + h > o.y
			) {
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
export function mountAppTrayRoutes(app: Hono): void {
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

		const missing = installed.filter(
			(s) => s.enabled && !trayIds.has(s.id),
		);

		if (missing.length > 0) {
			const now = new Date().toISOString();
			const stubs = missing.map((server) => ({
				id: server.id,
				name: server.name,
				icon: resolveServerIcon(server.source, server.catalogId),
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
					writeFileSync(
						join(getMarketplaceDir(), "app-tray.json"),
						JSON.stringify([...fresh, ...toAdd], null, 2),
					);
				}
				logger.info(
					"os",
					`Synced ${toAdd.length} installed server(s) to app tray`,
				);
			} catch (err) {
				logger.warn(
					"os",
					`Failed to persist auto-synced tray entries: ${err}`,
				);
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

		const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
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

		// Validate URL scheme and block private/loopback addresses (SSRF prevention)
		try {
			const parsed = new URL(url);
			if (!["https:", "http:"].includes(parsed.protocol)) {
				return c.json(
					{ ok: false, widgetId: "", manifest: null, error: "Only HTTP/HTTPS URLs are supported" },
					400,
				);
			}

			if (isPrivateHostname(parsed.hostname)) {
				return c.json(
					{ ok: false, widgetId: "", manifest: null, error: "Private/loopback addresses are not allowed" },
					400,
				);
			}
		} catch {
			return c.json(
				{ ok: false, widgetId: "", manifest: null, error: "Invalid URL format" },
				400,
			);
		}

		const nameOverride = body.name?.trim() || undefined;
		const autoPlace = body.autoPlace === true;

		try {
			const mcpServersOrgMatch = url.match(
				/^https?:\/\/(?:www\.)?mcpservers\.org\/servers\/(.+?)(?:\/|\?|#|$)/,
			);

			const installResult = mcpServersOrgMatch
				? await installViaCatalog(mcpServersOrgMatch[1], "mcpservers.org", nameOverride)
				: await installDirectHttp(url, nameOverride);

			// Probe the server
			const installed = readInstalledServersPublic();
			const server = installed.find((s) => s.id === installResult.serverId);

			let manifest: SignetAppManifest | null = null;
			if (server) {
				try {
					const probeResult = await probeServer(server);
					storeProbeResult(probeResult);
					manifest = probeResult.declaredManifest ?? null;
				} catch (err) {
					logger.warn(
						"probe",
						`Install probe failed for ${installResult.serverId}: ${err}`,
					);
					// Install still succeeds — auto-card will be used
				}
			}

			// If autoPlace, find free grid position and update tray entry
			if (autoPlace) {
				const tray = loadAppTray();
				const entry = tray.find((e) => e.id === installResult.serverId);
				if (entry) {
					const occupiedPositions = tray.flatMap((e) =>
					e.state === "grid" && e.gridPosition && e.id !== installResult.serverId
						? [e.gridPosition]
						: [],
				);

					const defaultSize = manifest?.defaultSize ??
						entry.autoCard?.defaultSize ?? { w: 4, h: 3 };
					const pos = findFreeGridPosition(
						occupiedPositions,
						defaultSize.w,
						defaultSize.h,
					);

					const idx = tray.findIndex(
						(e) => e.id === installResult.serverId,
					);
					if (idx >= 0) {
						tray[idx] = {
							...tray[idx],
							state: "grid",
							gridPosition: pos,
							updatedAt: new Date().toISOString(),
						};
						const agentsDir =
							process.env.SIGNET_PATH ||
							join(homedir(), ".agents");
						const trayPath = join(
							agentsDir,
							"marketplace",
							"app-tray.json",
						);
						writeFileSync(
							trayPath,
							JSON.stringify(tray, null, 2),
						);
					}
				}
			}

			return c.json({
				ok: true,
				widgetId: installResult.serverId,
				manifest,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("probe", `Install failed: ${msg}`);
			return c.json(
				{ ok: false, widgetId: "", manifest: null, error: msg },
				500,
			);
		}
	});
}

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getMarketplaceDir(): string {
	return join(getAgentsDir(), "marketplace");
}

function getInstalledMcpPath(): string {
	return join(getMarketplaceDir(), "mcp-servers.json");
}

function ensureMarketplaceDir(): void {
	const dir = getMarketplaceDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function sanitizeServerId(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.length > 0 ? normalized : "mcp-server";
}

function inferNameFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		// Use hostname without common prefixes
		let name = parsed.hostname
			.replace(/^(www|api|mcp)\./, "")
			.replace(/\.(com|org|io|dev|app|net)$/, "");
		// Add path hint if useful
		const pathParts = parsed.pathname
			.split("/")
			.filter((p) => p.length > 0 && p !== "mcp" && p !== "sse" && p !== "v1");
		if (pathParts.length > 0) {
			name = `${name}-${pathParts[0]}`;
		}
		return name
			.replace(/[-_]+/g, " ")
			.trim()
			.split(" ")
			.map((w) => (w.length > 0 ? `${w[0].toUpperCase()}${w.slice(1)}` : w))
			.join(" ");
	} catch {
		return "MCP Server";
	}
}

function inferCategory(text: string): string {
	const source = text.toLowerCase();
	if (/browser|scrap|crawl|web/.test(source)) return "Web";
	if (/slack|discord|email|sms|message|chat/.test(source)) return "Communication";
	if (/database|sql|postgres|mysql|sqlite|redis|vector/.test(source)) return "Database";
	if (/github|git|ci|deploy|build|code|dev/.test(source)) return "Development";
	if (/cloud|aws|gcp|azure|vercel|cloudflare/.test(source)) return "Cloud";
	if (/finance|stock|market|crypto|trading/.test(source)) return "Finance";
	if (/memory|knowledge|search|docs|rag/.test(source)) return "Knowledge";
	if (/file|storage|drive|s3|bucket/.test(source)) return "Storage";
	return "Other";
}

interface InstalledServer {
	readonly id: string;
	readonly source: string;
	readonly catalogId?: string;
	readonly name: string;
	readonly description: string;
	readonly category: string;
	readonly homepage?: string;
	readonly official: boolean;
	readonly enabled: boolean;
	readonly scope: { harnesses: string[]; workspaces: string[]; channels: string[] };
	readonly config: Record<string, unknown>;
	readonly installedAt: string;
	readonly updatedAt: string;
}

function readInstalledServersRaw(): InstalledServer[] {
	const path = getInstalledMcpPath();
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw as InstalledServer[];
	} catch {
		return [];
	}
}

function writeInstalledServersRaw(servers: InstalledServer[]): void {
	ensureMarketplaceDir();
	writeFileSync(getInstalledMcpPath(), JSON.stringify(servers, null, 2));
}

function makeUniqueServerId(
	baseId: string,
	installed: readonly InstalledServer[],
): string {
	if (!installed.some((s) => s.id === baseId)) return baseId;
	let i = 2;
	while (installed.some((s) => s.id === `${baseId}-${i}`)) {
		i++;
	}
	return `${baseId}-${i}`;
}

/**
 * Install a direct HTTP MCP server URL as a manual server.
 */
async function installDirectHttp(
	url: string,
	nameOverride?: string,
): Promise<{ serverId: string; isNew: boolean }> {
	const installed = readInstalledServersRaw();

	// Check if already installed by matching URL
	const existing = installed.find(
		(s) =>
			s.config &&
			typeof s.config === "object" &&
			"url" in s.config &&
			s.config.url === url,
	);
	if (existing) {
		// Update name if override provided
		if (nameOverride && nameOverride !== existing.name) {
			const updated = installed.map((s) =>
				s.id === existing.id
					? { ...s, name: nameOverride, updatedAt: new Date().toISOString() }
					: s,
			);
			writeInstalledServersRaw(updated);
		}
		return { serverId: existing.id, isNew: false };
	}

	const name = nameOverride ?? inferNameFromUrl(url);
	const baseId = sanitizeServerId(name);
	const id = makeUniqueServerId(baseId, installed);
	const now = new Date().toISOString();

	const server: InstalledServer = {
		id,
		source: "manual",
		name,
		description: `${name} MCP server`,
		category: inferCategory(name),
		homepage: url,
		official: false,
		enabled: true,
		scope: { harnesses: [], workspaces: [], channels: [] },
		config: {
			transport: "http",
			url,
			headers: {},
			timeoutMs: 20000,
		},
		installedAt: now,
		updatedAt: now,
	};

	writeInstalledServersRaw([...installed, server]);
	return { serverId: id, isNew: true };
}

/**
 * Install an MCP server from a catalog source (mcpservers.org).
 * Delegates to the existing /api/marketplace/mcp/install endpoint logic
 * by calling it internally via fetch.
 */
async function installViaCatalog(
	catalogId: string,
	source: "mcpservers.org" | "modelcontextprotocol/servers",
	nameOverride?: string,
): Promise<{ serverId: string; isNew: boolean }> {
	// Use internal HTTP call to the marketplace install endpoint.
	// This reuses all existing logic (config fetch, dedup, etc.) without
	// duplicating it.
	const port = process.env.SIGNET_PORT || "3850";
	const res = await fetch(`http://localhost:${port}/api/marketplace/mcp/install`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: `${source}:${catalogId}`,
			source,
			alias: nameOverride,
		}),
	});

	const data = (await res.json()) as {
		success?: boolean;
		server?: { id: string };
		updated?: boolean;
		error?: string;
	};

	if (!data.success || !data.server) {
		throw new Error(data.error ?? "Marketplace install failed");
	}

	return {
		serverId: data.server.id,
		isNew: !data.updated,
	};
}

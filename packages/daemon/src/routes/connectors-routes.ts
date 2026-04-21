import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CONNECTOR_PROVIDERS,
	type ConnectorConfig,
	type SyncCursor,
	findSignetForgeBinary,
	resolveSignetForgeManagedPath,
} from "@signet/core";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { createFilesystemConnector } from "../connectors/filesystem.js";
import {
	getConnector,
	listConnectors,
	registerConnector,
	removeConnector,
	updateConnectorStatus,
	updateCursor,
} from "../connectors/registry.js";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { AGENTS_DIR, SCRIPTS_DIR, authConfig, harnessLastSeen } from "./state.js";

type ConnectorSyncStartOutcome =
	| { status: "syncing" }
	| { status: "already-syncing" }
	| { status: "unsupported"; provider: string }
	| { status: "error"; error: string };

function startConnectorSync(connectorId: string, mode: "incremental" | "full"): ConnectorSyncStartOutcome {
	const accessor = getDbAccessor();
	const connectorRow = getConnector(accessor, connectorId);
	if (!connectorRow) {
		return { status: "error", error: "Connector not found" };
	}

	if (connectorRow.status === "syncing") {
		return { status: "already-syncing" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(connectorRow.config_json);
	} catch {
		return { status: "error", error: "Connector config is invalid JSON" };
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("provider" in parsed) ||
		typeof (parsed as Record<string, unknown>).provider !== "string" ||
		!(CONNECTOR_PROVIDERS as readonly string[]).includes((parsed as Record<string, unknown>).provider as string)
	) {
		return { status: "error", error: "Invalid connector config" };
	}
	const config = parsed as ConnectorConfig;

	if (config.provider !== "filesystem") {
		return { status: "unsupported", provider: config.provider };
	}

	updateConnectorStatus(accessor, connectorId, "syncing");
	const connector = createFilesystemConnector(config, accessor);

	let incrementalCursor: SyncCursor | null = null;
	if (mode === "incremental") {
		if (!connectorRow.cursor_json) {
			incrementalCursor = { lastSyncAt: new Date(0).toISOString() };
		} else {
			try {
				const cursorParsed: unknown = JSON.parse(connectorRow.cursor_json);
				if (
					typeof cursorParsed === "object" &&
					cursorParsed !== null &&
					"lastSyncAt" in cursorParsed &&
					typeof (cursorParsed as Record<string, unknown>).lastSyncAt === "string"
				) {
					incrementalCursor = cursorParsed as SyncCursor;
				} else {
					incrementalCursor = { lastSyncAt: new Date(0).toISOString() };
				}
			} catch {
				incrementalCursor = { lastSyncAt: new Date(0).toISOString() };
			}
		}
	}

	const syncPromise =
		mode === "full"
			? connector.syncFull()
			: connector.syncIncremental(incrementalCursor ?? { lastSyncAt: new Date(0).toISOString() });

	syncPromise
		.then((result) => {
			updateCursor(accessor, connectorId, result.cursor);
			updateConnectorStatus(accessor, connectorId, "idle");
			logger.info("connectors", mode === "full" ? "Full sync completed" : "Sync completed", {
				connectorId,
				added: result.documentsAdded,
				updated: result.documentsUpdated,
			});
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			updateConnectorStatus(accessor, connectorId, "error", msg);
			logger.error("connectors", mode === "full" ? "Full sync failed" : "Sync failed", new Error(msg));
		});

	return { status: "syncing" };
}

/** Escape LIKE special characters for safe prefix matching. */
export function escapeLikePrefix(value: string): string {
	return `${value.replace(/[%_\\]/g, "\\$&")}%`;
}

function findForgeBinaryPath(): string | null {
	return findSignetForgeBinary(AGENTS_DIR);
}

export function registerConnectorRoutes(app: Hono): void {
	// Permission guards — skip GET (public reads)
	app.use("/api/connectors", async (c, next) => {
		if (c.req.method === "GET") return next();
		return requirePermission("admin", authConfig)(c, next);
	});
	app.use("/api/connectors/*", async (c, next) => {
		if (c.req.method === "GET") return next();
		return requirePermission("admin", authConfig)(c, next);
	});

	app.get("/api/connectors", (c) => {
		try {
			const accessor = getDbAccessor();
			const connectors = listConnectors(accessor);
			return c.json({ connectors, count: connectors.length });
		} catch (e) {
			logger.error("connectors", "Failed to list", e as Error);
			return c.json({ error: "Failed to list connectors" }, 500);
		}
	});

	app.post("/api/connectors", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = (await c.req.json()) as Record<string, unknown>;
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const provider = body.provider as string | undefined;
		if (!provider || !["filesystem", "github-docs", "gdrive"].includes(provider)) {
			return c.json({ error: "provider must be filesystem, github-docs, or gdrive" }, 400);
		}

		const displayName = typeof body.displayName === "string" ? body.displayName : provider;
		const settings =
			typeof body.settings === "object" && body.settings !== null ? (body.settings as Record<string, unknown>) : {};

		try {
			const accessor = getDbAccessor();
			const config = {
				id: crypto.randomUUID(),
				provider: provider as "filesystem" | "github-docs" | "gdrive",
				displayName,
				settings,
				enabled: true,
			};

			const id = registerConnector(accessor, config);
			return c.json({ id }, 201);
		} catch (e) {
			logger.error("connectors", "Failed to register", e as Error);
			return c.json({ error: "Failed to register connector" }, 500);
		}
	});

	app.get("/api/connectors/:id", (c) => {
		const id = c.req.param("id");
		try {
			const accessor = getDbAccessor();
			const connector = getConnector(accessor, id);
			if (!connector) return c.json({ error: "Connector not found" }, 404);
			return c.json(connector);
		} catch (e) {
			logger.error("connectors", "Failed to get connector", e as Error);
			return c.json({ error: "Failed to get connector" }, 500);
		}
	});

	app.post("/api/connectors/:id/sync", async (c) => {
		const id = c.req.param("id");
		const outcome = startConnectorSync(id, "incremental");
		if (outcome.status === "error") return c.json({ error: outcome.error }, 404);
		if (outcome.status === "already-syncing") {
			return c.json({ status: "syncing", message: "Already syncing" });
		}
		if (outcome.status === "unsupported") {
			return c.json({ error: `Provider ${outcome.provider} not yet supported` }, 501);
		}
		return c.json({ status: "syncing" });
	});

	app.post("/api/connectors/resync", async (c) => {
		try {
			const accessor = getDbAccessor();
			const connectors = listConnectors(accessor);

			let started = 0;
			let alreadySyncing = 0;
			let unsupported = 0;
			let failed = 0;

			for (const conn of connectors) {
				const outcome = startConnectorSync(conn.id, "incremental");
				if (outcome.status === "syncing") started++;
				if (outcome.status === "already-syncing") alreadySyncing++;
				if (outcome.status === "unsupported") unsupported++;
				if (outcome.status === "error") failed++;
			}

			return c.json({
				status: "ok",
				total: connectors.length,
				started,
				alreadySyncing,
				unsupported,
				failed,
			});
		} catch (e) {
			logger.error("connectors", "Failed to trigger bulk resync", e instanceof Error ? e : new Error(String(e)));
			return c.json(
				{
					status: "error",
					error: "Failed to trigger connector re-sync",
					total: 0,
					started: 0,
					alreadySyncing: 0,
					unsupported: 0,
					failed: 0,
				},
				500,
			);
		}
	});

	app.post("/api/connectors/:id/sync/full", async (c) => {
		const id = c.req.param("id");
		const confirm = c.req.query("confirm");
		if (confirm !== "true") {
			return c.json({ error: "Full resync requires ?confirm=true" }, 400);
		}

		const outcome = startConnectorSync(id, "full");
		if (outcome.status === "error") return c.json({ error: outcome.error }, 404);
		if (outcome.status === "already-syncing") {
			return c.json({ status: "syncing", message: "Already syncing" });
		}
		if (outcome.status === "unsupported") {
			return c.json({ error: `Provider ${outcome.provider} not yet supported` }, 501);
		}

		return c.json({ status: "syncing" });
	});

	app.delete("/api/connectors/:id", (c) => {
		const id = c.req.param("id");
		const cascade = c.req.query("cascade") === "true";

		try {
			const accessor = getDbAccessor();
			const connectorRow = getConnector(accessor, id);
			if (!connectorRow) {
				return c.json({ error: "Connector not found" }, 404);
			}

			if (cascade) {
				const config = JSON.parse(connectorRow.config_json) as {
					settings?: { rootPath?: string };
				};
				const rootPath = config.settings?.rootPath;
				if (rootPath) {
					const docs = accessor.withReadDb((db) => {
						return db
							.prepare(
								`SELECT id FROM documents
								 WHERE source_url LIKE ? ESCAPE '\\'`,
							)
							.all(escapeLikePrefix(rootPath)) as ReadonlyArray<{ id: string }>;
					});
					const now = new Date().toISOString();
					for (const doc of docs) {
						accessor.withWriteTx((db) => {
							db.prepare(
								`UPDATE documents
								 SET status = 'deleted',
								     error = 'Connector removed',
								     updated_at = ?
								 WHERE id = ?`,
							).run(now, doc.id);
						});
					}
				}
			}

			const removed = removeConnector(accessor, id);
			return c.json({ deleted: removed });
		} catch (e) {
			logger.error("connectors", "Failed to remove", e as Error);
			return c.json({ error: "Failed to remove connector" }, 500);
		}
	});

	app.get("/api/connectors/:id/health", (c) => {
		const id = c.req.param("id");
		try {
			const accessor = getDbAccessor();
			const connectorRow = getConnector(accessor, id);
			if (!connectorRow) {
				return c.json({ error: "Connector not found" }, 404);
			}

			const docCount = accessor.withReadDb((db) => {
				const config = JSON.parse(connectorRow.config_json) as {
					settings?: { rootPath?: string };
				};
				const rootPath = config.settings?.rootPath;
				if (!rootPath) return 0;
				const row = db
					.prepare(
						`SELECT COUNT(*) AS cnt FROM documents
						 WHERE source_url LIKE ? ESCAPE '\\'`,
					)
					.get(escapeLikePrefix(rootPath)) as { cnt: number } | undefined;
				return row?.cnt ?? 0;
			});

			return c.json({
				id: connectorRow.id,
				status: connectorRow.status,
				lastSyncAt: connectorRow.last_sync_at,
				lastError: connectorRow.last_error,
				documentCount: docCount,
			});
		} catch (e) {
			logger.error("connectors", "Failed to get health", e as Error);
			return c.json({ error: "Failed to get connector health" }, 500);
		}
	});

	// Harnesses API

	app.get("/api/harnesses", async (c) => {
		const verifiedForgePath = findForgeBinaryPath();
		const configs = [
			{
				name: "Claude Code",
				id: "claude-code",
				path: join(homedir(), ".claude", "settings.json"),
				exists: existsSync(join(homedir(), ".claude", "settings.json")),
			},
			{
				name: "OpenCode",
				id: "opencode",
				path: join(homedir(), ".config", "opencode", "AGENTS.md"),
				exists: existsSync(join(homedir(), ".config", "opencode", "AGENTS.md")),
			},
			{
				name: "OpenClaw",
				id: "openclaw",
				path: join(AGENTS_DIR, "AGENTS.md"),
				exists: existsSync(join(AGENTS_DIR, "AGENTS.md")),
			},
			{
				name: "Forge",
				id: "forge",
				path: verifiedForgePath ?? resolveSignetForgeManagedPath(),
				exists: Boolean(verifiedForgePath),
			},
			{
				name: "Gemini CLI",
				id: "gemini",
				path: join(homedir(), ".gemini", "settings.json"),
				exists: existsSync(join(homedir(), ".gemini", "settings.json")),
			},
		];

		const harnesses = configs.map((config) => ({
			name: config.name,
			id: config.id,
			path: config.path,
			exists: config.exists,
			lastSeen: harnessLastSeen.get(config.id) ?? null,
		}));

		return c.json({ harnesses });
	});

	app.post("/api/harnesses/regenerate", async (c) => {
		return new Promise<Response>((resolve) => {
			const script = join(SCRIPTS_DIR, "generate-harness-configs.py");

			if (!existsSync(script)) {
				resolve(c.json({ success: false, error: "Regeneration script not found" }, 404));
				return;
			}

			const proc = spawn("python3", [script], {
				timeout: 10000,
				cwd: AGENTS_DIR,
				windowsHide: true,
			});

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code === 0) {
					logger.info("harness", "Harness configs regenerated");
					resolve(
						c.json({
							success: true,
							message: "Configs regenerated successfully",
							output: stdout,
						}),
					);
				} else {
					resolve(
						c.json(
							{
								success: false,
								error: stderr || `Script exited with code ${code}`,
							},
							500,
						),
					);
				}
			});

			proc.on("error", (err) => {
				resolve(c.json({ success: false, error: err.message }, 500));
			});
		});
	});
}

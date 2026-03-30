/**
 * MCP Server Registry routes.
 *
 * Manages the mcp_servers table — the Signet-owned registry of MCP servers
 * that are proxied through /mcp and compiled into standalone CLIs.
 *
 * Routes:
 *   GET    /api/mcp-servers              list all registered servers
 *   GET    /api/mcp-servers/discover     cross-harness discovery via mcporter
 *   GET    /api/mcp-servers/:id/tools    list tools for a server
 *   POST   /api/mcp-servers              register a server
 *   POST   /api/mcp-servers/import       import a discovered server
 *   POST   /api/mcp-servers/:id/generate-cli  compile to standalone CLI
 *   PATCH  /api/mcp-servers/:id          toggle enabled
 *   DELETE /api/mcp-servers/:id          remove
 */

import { spawn } from "child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { loadServerDefinitions } from "mcporter";
import type { DbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { type McpServerRow, listServerTools, mcpBinsDir, refreshProxyRuntime } from "../mcp/proxy-runtime.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

function validateName(name: unknown): name is string {
	return typeof name === "string" && name.length > 0 && name.length <= 128 && VALID_NAME.test(name);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function dbList(db: DbAccessor): McpServerRow[] {
	return db.withReadDb(
		(rdb) =>
			rdb
				.prepare(
					"SELECT id, name, transport, config, enabled, cli_path, created_at, updated_at FROM mcp_servers ORDER BY created_at DESC",
				)
				.all() as McpServerRow[],
	);
}

function dbGetById(db: DbAccessor, id: string): McpServerRow | undefined {
	return db.withReadDb(
		(rdb) =>
			rdb
				.prepare(
					"SELECT id, name, transport, config, enabled, cli_path, created_at, updated_at FROM mcp_servers WHERE id = ?",
				)
				.get(id) as McpServerRow | undefined,
	);
}

function dbGetByName(db: DbAccessor, name: string): McpServerRow | undefined {
	return db.withReadDb(
		(rdb) =>
			rdb
				.prepare(
					"SELECT id, name, transport, config, enabled, cli_path, created_at, updated_at FROM mcp_servers WHERE name = ?",
				)
				.get(name) as McpServerRow | undefined,
	);
}

function dbInsert(db: DbAccessor, id: string, name: string, transport: "stdio" | "http", config: string): McpServerRow {
	const now = new Date().toISOString();
	db.withWriteTx((wdb) => {
		wdb
			.prepare(
				"INSERT INTO mcp_servers (id, name, transport, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
			)
			.run(id, name, transport, config, now, now);
	});
	const row = dbGetById(db, id);
	if (row === undefined) throw new Error("Insert failed");
	return row;
}

function dbUpdate(db: DbAccessor, id: string, fields: Partial<{ enabled: number; cli_path: string }>): void {
	const sets: string[] = [];
	const vals: unknown[] = [];
	if (fields.enabled !== undefined) {
		sets.push("enabled = ?");
		vals.push(fields.enabled);
	}
	if (fields.cli_path !== undefined) {
		sets.push("cli_path = ?");
		vals.push(fields.cli_path);
	}
	if (sets.length === 0) return;
	sets.push("updated_at = ?");
	vals.push(new Date().toISOString());
	vals.push(id);
	db.withWriteTx((wdb) => {
		wdb.prepare(`UPDATE mcp_servers SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
	});
}

function dbDelete(db: DbAccessor, id: string): void {
	db.withWriteTx((wdb) => {
		wdb.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
	});
}

// ---------------------------------------------------------------------------
// CLI generation helper
// ---------------------------------------------------------------------------

function spawnGenerateCli(name: string, configPath: string, outputDir: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			"npx",
			["mcporter", "generate-cli", name, "--config", configPath, "--compile", "--output", outputDir],
			{ env: process.env, timeout: 120_000 },
		);

		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(join(outputDir, name));
			} else {
				reject(new Error(stderr || `mcporter generate-cli exited with code ${String(code)}`));
			}
		});
		proc.on("error", (err: Error) => reject(err));
	});
}

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

export function mountMcpServersRoutes(app: Hono, db: DbAccessor): void {
	// -------------------------------------------------------------------------
	// GET /api/mcp-servers — list all registered servers
	// -------------------------------------------------------------------------
	app.get("/api/mcp-servers", (c) => {
		try {
			const rows = dbList(db);
			return c.json({ servers: rows, count: rows.length });
		} catch (err) {
			logger.error("mcp-servers", "Failed to list servers", err instanceof Error ? err : new Error(String(err)));
			return c.json({ servers: [], count: 0, error: "Failed to list servers" }, 500);
		}
	});

	// -------------------------------------------------------------------------
	// GET /api/mcp-servers/discover — cross-harness discovery
	// Reads all ImportKinds and returns servers not already registered.
	// -------------------------------------------------------------------------
	app.get("/api/mcp-servers/discover", async (c) => {
		try {
			const defs = await loadServerDefinitions();
			const installed = new Set(dbList(db).map((r) => r.name));

			const discovered = defs.map((def) => {
				const source = def.source ?? def.sources?.[0];
				return {
					name: def.name,
					importKind: source?.importKind ?? "unknown",
					sourcePath: source?.path ?? "",
					alreadyInstalled: installed.has(def.name),
					// Store the normalized command back as a storable raw config
					rawConfig: serializeCommand(def),
				};
			});

			return c.json({ servers: discovered, count: discovered.length });
		} catch (err) {
			logger.error("mcp-servers", "Discovery failed", err instanceof Error ? err : new Error(String(err)));
			return c.json({ servers: [], count: 0, error: "Discovery failed" }, 500);
		}
	});

	// -------------------------------------------------------------------------
	// GET /api/mcp-servers/:id/tools — list tools for an installed server
	// -------------------------------------------------------------------------
	app.get("/api/mcp-servers/:id/tools", async (c) => {
		const id = c.req.param("id");
		const row = dbGetById(db, id);
		if (row === undefined) {
			return c.json({ error: "Server not found" }, 404);
		}

		const tools = await listServerTools(row);
		return c.json({ tools, count: tools.length });
	});

	// -------------------------------------------------------------------------
	// POST /api/mcp-servers — register a server manually
	// Body: { name: string, transport: "stdio"|"http", config: object }
	// -------------------------------------------------------------------------
	app.post("/api/mcp-servers", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (typeof body !== "object" || body === null) {
			return c.json({ error: "Body must be an object" }, 400);
		}
		const b = body as Record<string, unknown>;

		if (!validateName(b.name)) {
			return c.json({ error: "name must be 1-128 alphanumeric/dash/underscore chars" }, 400);
		}
		const transport = b.transport;
		if (transport !== "stdio" && transport !== "http") {
			return c.json({ error: "transport must be 'stdio' or 'http'" }, 400);
		}
		if (typeof b.config !== "object" || b.config === null) {
			return c.json({ error: "config must be an object" }, 400);
		}

		if (dbGetByName(db, b.name) !== undefined) {
			return c.json({ error: `Server '${b.name}' is already registered` }, 409);
		}

		try {
			const id = crypto.randomUUID();
			const row = dbInsert(db, id, b.name, transport, JSON.stringify(b.config));
			void refreshProxyRuntime(db);
			logger.info("mcp-servers", `Registered server '${b.name}'`);
			return c.json({ server: row }, 201);
		} catch (err) {
			logger.error("mcp-servers", "Failed to register server", err instanceof Error ? err : new Error(String(err)));
			return c.json({ error: "Failed to register server" }, 500);
		}
	});

	// -------------------------------------------------------------------------
	// POST /api/mcp-servers/import — import a discovered server
	// Body: { name: string, rawConfig: object }
	// -------------------------------------------------------------------------
	app.post("/api/mcp-servers/import", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (typeof body !== "object" || body === null) {
			return c.json({ error: "Body must be an object" }, 400);
		}
		const b = body as Record<string, unknown>;

		if (!validateName(b.name)) {
			return c.json({ error: "name must be 1-128 alphanumeric/dash/underscore chars" }, 400);
		}
		if (typeof b.rawConfig !== "object" || b.rawConfig === null) {
			return c.json({ error: "rawConfig must be an object" }, 400);
		}

		if (dbGetByName(db, b.name) !== undefined) {
			return c.json({ error: `Server '${b.name}' is already registered` }, 409);
		}

		// Infer transport from rawConfig
		const rc = b.rawConfig as Record<string, unknown>;
		const transport: "stdio" | "http" =
			typeof rc.url === "string" || typeof rc.baseUrl === "string" || typeof rc.serverUrl === "string"
				? "http"
				: "stdio";

		try {
			const id = crypto.randomUUID();
			const row = dbInsert(db, id, b.name, transport, JSON.stringify(b.rawConfig));
			void refreshProxyRuntime(db);
			logger.info("mcp-servers", `Imported server '${b.name}'`);
			return c.json({ server: row }, 201);
		} catch (err) {
			logger.error("mcp-servers", "Failed to import server", err instanceof Error ? err : new Error(String(err)));
			return c.json({ error: "Failed to import server" }, 500);
		}
	});

	// -------------------------------------------------------------------------
	// POST /api/mcp-servers/:id/generate-cli — compile to standalone binary
	// -------------------------------------------------------------------------
	app.post("/api/mcp-servers/:id/generate-cli", async (c) => {
		const id = c.req.param("id");
		const row = dbGetById(db, id);
		if (row === undefined) {
			return c.json({ error: "Server not found" }, 404);
		}

		let config: unknown;
		try {
			config = JSON.parse(row.config);
		} catch {
			return c.json({ error: "Server has invalid config" }, 500);
		}

		const tempPath = join(tmpdir(), `signet-mcp-cli-${randomBytes(6).toString("hex")}.json`);
		writeFileSync(tempPath, JSON.stringify({ mcpServers: { [row.name]: config } }), "utf-8");

		try {
			const outputDir = mcpBinsDir();
			const cliPath = await spawnGenerateCli(row.name, tempPath, outputDir);
			dbUpdate(db, id, { cli_path: cliPath });
			logger.info("mcp-servers", `Generated CLI for '${row.name}' at ${cliPath}`);
			return c.json({ success: true, path: cliPath });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(
				"mcp-servers",
				`CLI generation failed for '${row.name}'`,
				err instanceof Error ? err : new Error(msg),
			);
			return c.json({ success: false, error: msg }, 500);
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {
				/* best-effort */
			}
		}
	});

	// -------------------------------------------------------------------------
	// PATCH /api/mcp-servers/:id — toggle enabled
	// Body: { enabled: boolean }
	// -------------------------------------------------------------------------
	app.patch("/api/mcp-servers/:id", async (c) => {
		const id = c.req.param("id");
		const row = dbGetById(db, id);
		if (row === undefined) {
			return c.json({ error: "Server not found" }, 404);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (typeof body !== "object" || body === null) {
			return c.json({ error: "Body must be an object" }, 400);
		}
		const b = body as Record<string, unknown>;

		if (typeof b.enabled !== "boolean") {
			return c.json({ error: "enabled must be a boolean" }, 400);
		}

		dbUpdate(db, id, { enabled: b.enabled ? 1 : 0 });
		void refreshProxyRuntime(db);

		const updated = dbGetById(db, id);
		return c.json({ server: updated });
	});

	// -------------------------------------------------------------------------
	// DELETE /api/mcp-servers/:id — remove a server
	// -------------------------------------------------------------------------
	app.delete("/api/mcp-servers/:id", (c) => {
		const id = c.req.param("id");
		const row = dbGetById(db, id);
		if (row === undefined) {
			return c.json({ error: "Server not found" }, 404);
		}

		try {
			dbDelete(db, id);
			void refreshProxyRuntime(db);
			logger.info("mcp-servers", `Removed server '${row.name}'`);
			return c.json({ success: true, name: row.name });
		} catch (err) {
			logger.error("mcp-servers", "Failed to remove server", err instanceof Error ? err : new Error(String(err)));
			return c.json({ error: "Failed to remove server" }, 500);
		}
	});
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

/**
 * Convert a normalized ServerDefinition back to a storable RawEntry object
 * for discovered servers that we want to import.
 */
function serializeCommand(def: Awaited<ReturnType<typeof loadServerDefinitions>>[number]): Record<string, unknown> {
	const cmd = def.command;
	if (cmd.kind === "http") {
		const entry: Record<string, unknown> = { url: cmd.url.toString() };
		if (cmd.headers && Object.keys(cmd.headers).length > 0) {
			entry.headers = cmd.headers;
		}
		if (def.env) entry.env = def.env;
		if (def.auth) entry.auth = def.auth;
		return entry;
	}
	// stdio
	const entry: Record<string, unknown> = {
		command: cmd.command,
		args: cmd.args,
	};
	if (def.env) entry.env = def.env;
	return entry;
}

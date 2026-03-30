/**
 * Shared mcporter Runtime for proxying installed MCP servers.
 *
 * One Runtime instance lives for the daemon's lifetime, pooling connections
 * to all enabled mcp_servers rows. It is refreshed whenever a server is
 * installed, removed, or toggled.
 *
 * The /mcp route (stateless per-request) reads tools from this runtime
 * and registers them on each fresh McpServer instance.
 */

import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRuntime, loadServerDefinitions, type Runtime, type ServerToolInfo } from "mcporter";
import type { DbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerRow {
	readonly id: string;
	readonly name: string;
	readonly transport: "stdio" | "http";
	readonly config: string; // JSON RawEntry
	readonly enabled: number;
	readonly cli_path: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Module-level singleton + tool cache
// ---------------------------------------------------------------------------

let _runtime: Runtime | null = null;

/**
 * Cached tool list per server name. Built at initProxyRuntime time so
 * the stateless /mcp handler can register proxy tools synchronously.
 */
const _toolCache = new Map<string, readonly ServerToolInfo[]>();

/** Read-only snapshot of the tool cache for the MCP route. */
export function getProxyToolCache(): ReadonlyMap<string, readonly ServerToolInfo[]> {
	return _toolCache;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadEnabledServers(db: DbAccessor): McpServerRow[] {
	return db.withReadDb((rdb) =>
		rdb
			.prepare(
				"SELECT id, name, transport, config, enabled, cli_path, created_at, updated_at FROM mcp_servers WHERE enabled = 1",
			)
			.all() as McpServerRow[],
	);
}

/**
 * Write a temp mcporter config file from DB rows, load ServerDefinitions,
 * then remove the temp file. Returns the normalized definitions.
 */
async function buildDefinitions(
	rows: readonly McpServerRow[],
): Promise<Awaited<ReturnType<typeof loadServerDefinitions>>> {
	if (rows.length === 0) return [];

	// Build raw config object
	const mcpServers: Record<string, unknown> = {};
	for (const row of rows) {
		try {
			mcpServers[row.name] = JSON.parse(row.config);
		} catch {
			logger.warn("mcp-proxy", `Skipping server '${row.name}': invalid config JSON`);
		}
	}

	const tempPath = join(tmpdir(), `signet-mcp-${randomBytes(6).toString("hex")}.json`);
	writeFileSync(tempPath, JSON.stringify({ mcpServers }), "utf-8");

	try {
		return await loadServerDefinitions({ configPath: tempPath });
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// best-effort cleanup
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initProxyRuntime(db: DbAccessor): Promise<void> {
	_toolCache.clear();

	const rows = loadEnabledServers(db);
	if (rows.length === 0) {
		_runtime = null;
		return;
	}

	try {
		const defs = await buildDefinitions(rows);
		const runtime = await createRuntime({ servers: defs });
		_runtime = runtime;
		logger.info("mcp-proxy", `Runtime initialized with ${defs.length} server(s)`);

		// Pre-populate tool cache so /mcp handler can register tools synchronously
		await Promise.all(
			defs.map(async (def) => {
				try {
					const tools = await runtime.listTools(def.name, { includeSchema: true });
					_toolCache.set(def.name, tools);
					logger.info("mcp-proxy", `Cached ${tools.length} tool(s) for '${def.name}'`);
				} catch (err) {
					logger.warn("mcp-proxy", `Skipping tool cache for '${def.name}': ${err instanceof Error ? err.message : String(err)}`);
				}
			}),
		);
	} catch (err) {
		logger.error("mcp-proxy", "Failed to initialize proxy runtime", err instanceof Error ? err : new Error(String(err)));
		_runtime = null;
	}
}

export async function refreshProxyRuntime(db: DbAccessor): Promise<void> {
	if (_runtime !== null) {
		try {
			await _runtime.close();
		} catch {
			// best-effort
		}
		_runtime = null;
	}
	await initProxyRuntime(db);
}

export function getProxyRuntime(): Runtime | null {
	return _runtime;
}

/**
 * List tools from a single server by name.
 * Creates a temporary one-shot runtime scoped to that server.
 * Used by GET /api/mcp-servers/:id/tools — separate from the shared
 * proxy runtime so a single slow server doesn't block others.
 */
export async function listServerTools(
	row: McpServerRow,
): Promise<ServerToolInfo[]> {
	let config: unknown;
	try {
		config = JSON.parse(row.config);
	} catch {
		return [];
	}

	const mcpServers: Record<string, unknown> = { [row.name]: config };
	const tempPath = join(tmpdir(), `signet-mcp-tools-${randomBytes(6).toString("hex")}.json`);
	writeFileSync(tempPath, JSON.stringify({ mcpServers }), "utf-8");

	let runtime: Runtime | null = null;
	try {
		const defs = await loadServerDefinitions({ configPath: tempPath });
		if (defs.length === 0) return [];
		runtime = await createRuntime({ servers: defs });
		return await runtime.listTools(row.name, { includeSchema: true });
	} catch (err) {
		logger.warn("mcp-proxy", `Failed to list tools for '${row.name}': ${err instanceof Error ? err.message : String(err)}`);
		return [];
	} finally {
		try { unlinkSync(tempPath); } catch { /* best-effort */ }
		if (runtime !== null) {
			try { await runtime.close(); } catch { /* best-effort */ }
		}
	}
}

/** Ensure ~/.agents/mcp-bins/ exists and return its path. */
export function mcpBinsDir(): string {
	const dir = join(homedir(), ".agents", "mcp-bins");
	mkdirSync(dir, { recursive: true });
	return dir;
}

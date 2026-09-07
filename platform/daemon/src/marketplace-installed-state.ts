/**
 * Canonical owner for installed MCP server state.
 *
 * This module is the only reader and writer for marketplace/mcp-servers.json.
 * Reads normalize supported legacy representations into the canonical runtime
 * shape and exclude malformed rows from the active set. Invalid rows are
 * reported in diagnostics and are dropped by the next successful mutation;
 * unreadable or non-array files block writes so a read-modify-write cannot
 * overwrite unknown durable state.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath } from "@signet/core";

export type MarketplaceMcpTransport = "stdio" | "http";
export type MarketplaceMcpCatalogSource = "mcpservers.org" | "modelcontextprotocol/servers" | "github";
export type MarketplaceMcpSource = MarketplaceMcpCatalogSource | "manual";

export interface MarketplaceMcpScope {
	readonly harnesses: readonly string[];
	readonly workspaces: readonly string[];
	readonly channels: readonly string[];
}

export interface MarketplaceMcpConfigStdio {
	readonly transport: "stdio";
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
	readonly timeoutMs: number;
}

export interface MarketplaceMcpConfigHttp {
	readonly transport: "http";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}

export type MarketplaceMcpConfig = MarketplaceMcpConfigStdio | MarketplaceMcpConfigHttp;

export interface InstalledMarketplaceMcpServer {
	readonly id: string;
	readonly source: MarketplaceMcpSource;
	readonly catalogId?: string;
	readonly name: string;
	readonly description: string;
	readonly category: string;
	readonly homepage?: string;
	readonly official: boolean;
	readonly enabled: boolean;
	readonly scope: MarketplaceMcpScope;
	readonly config: MarketplaceMcpConfig;
	readonly installedAt: string;
	readonly updatedAt: string;
}

export interface InvalidInstalledServerEntry {
	readonly index: number | null;
	readonly reason: string;
}

export interface InstalledServerReadResult {
	readonly path: string;
	readonly readable: boolean;
	readonly servers: readonly InstalledMarketplaceMcpServer[];
	readonly invalidEntries: readonly InvalidInstalledServerEntry[];
}

export class InstalledServerStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InstalledServerStateError";
	}
}

export const DEFAULT_MCP_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

function emptyScope(): MarketplaceMcpScope {
	return { harnesses: [], workspaces: [], channels: [] };
}

function normalizeScopeValues(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;

	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of value) {
		const trimmed = item.trim();
		if (trimmed.length === 0) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(trimmed);
	}
	return normalized;
}

/** Normalize a persisted scope; omitted scope dimensions retain their defaults. */
export function normalizeScope(value: undefined): MarketplaceMcpScope;
export function normalizeScope(value: unknown): MarketplaceMcpScope | null;
export function normalizeScope(value: unknown): MarketplaceMcpScope | null {
	if (value === undefined) return emptyScope();
	if (!isRecord(value)) return null;

	const harnesses = normalizeScopeValues(value.harnesses);
	const workspaces = normalizeScopeValues(value.workspaces);
	const channels = normalizeScopeValues(value.channels);
	if (!harnesses || !workspaces || !channels) return null;

	return { harnesses, workspaces, channels };
}

function normalizeStringRecord(value: unknown): Record<string, string> | null {
	if (value === undefined) return {};
	if (!isRecord(value)) return null;

	const normalized: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") return null;
		normalized[key] = item;
	}
	return normalized;
}

function normalizeStringArray(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
	return [...value];
}

function normalizeTimeout(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return Math.max(1, Math.floor(value));
}

/**
 * Normalize canonical and supported legacy MCP config shapes.
 *
 * Legacy configs may omit `transport` (it is inferred from `url` or
 * `command`) and `timeoutMs` (the bounded default is supplied). Present
 * fields remain strict: conflicting transports, malformed arrays/records,
 * and invalid timeouts are rejected rather than partially filtered.
 */
export function normalizeMcpConfig(
	value: unknown,
	fallbackTimeoutMs = DEFAULT_MCP_TIMEOUT_MS,
): MarketplaceMcpConfig | null {
	if (!isRecord(value)) return null;

	const hasTransport = hasOwn(value, "transport");
	if (hasTransport && value.transport !== "stdio" && value.transport !== "http") return null;

	const hasUrl = hasOwn(value, "url");
	const hasCommand = hasOwn(value, "command");
	if (hasUrl && hasCommand) return null;

	const timeoutMs = normalizeTimeout(value.timeoutMs, fallbackTimeoutMs);
	if (timeoutMs === null) return null;

	if (value.transport === "http" || (!hasTransport && hasUrl)) {
		if (!hasUrl || typeof value.url !== "string") return null;
		const url = value.url.trim();
		if (url.length === 0) return null;
		const headers = normalizeStringRecord(value.headers);
		if (!headers) return null;
		if (hasOwn(value, "command") || hasOwn(value, "args") || hasOwn(value, "env") || hasOwn(value, "cwd")) return null;
		return { transport: "http", url, headers, timeoutMs };
	}

	if (value.transport === "stdio" || (!hasTransport && hasCommand)) {
		if (!hasCommand) return null;
		const commandParts = Array.isArray(value.command)
			? normalizeStringArray(value.command)
			: typeof value.command === "string"
				? [value.command]
				: null;
		if (!commandParts || commandParts.length === 0) return null;
		const command = commandParts[0]?.trim();
		if (!command) return null;
		const args = normalizeStringArray(value.args);
		const env = normalizeStringRecord(value.env);
		if (!args || !env) return null;
		if (hasOwn(value, "url") || hasOwn(value, "headers")) return null;
		if (hasOwn(value, "cwd") && typeof value.cwd !== "string") return null;
		const cwd = typeof value.cwd === "string" ? value.cwd : undefined;
		return {
			transport: "stdio",
			command,
			args: [...commandParts.slice(1), ...args],
			env,
			...(cwd === undefined ? {} : { cwd }),
			timeoutMs,
		};
	}

	return null;
}

function normalizeRequiredString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalString(record: Record<string, unknown>, key: string): string | undefined | null {
	if (!hasOwn(record, key) || record[key] === undefined) return undefined;
	return normalizeRequiredString(record[key]);
}

function normalizeTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	if (normalized.length === 0 || !Number.isFinite(Date.parse(normalized))) return null;
	return normalized;
}

function parseSource(value: unknown): MarketplaceMcpSource | null {
	if (
		value === "mcpservers.org" ||
		value === "modelcontextprotocol/servers" ||
		value === "github" ||
		value === "manual"
	) {
		return value;
	}
	return null;
}

type ParsedInstalledServer = { readonly server: InstalledMarketplaceMcpServer } | { readonly error: string };

function parseInstalledServerResult(value: unknown): ParsedInstalledServer {
	if (!isRecord(value)) return { error: "entry must be an object" };

	const id = normalizeRequiredString(value.id);
	if (!id) return { error: "id must be a non-empty string" };
	const source = parseSource(value.source);
	if (!source) return { error: "source is unsupported" };
	const name = normalizeRequiredString(value.name);
	if (!name) return { error: "name must be a non-empty string" };
	const description = normalizeRequiredString(value.description);
	if (!description) return { error: "description must be a non-empty string" };
	const category = normalizeRequiredString(value.category);
	if (!category) return { error: "category must be a non-empty string" };
	if (typeof value.official !== "boolean") return { error: "official must be a boolean" };
	if (typeof value.enabled !== "boolean") return { error: "enabled must be a boolean" };

	const catalogId = normalizeOptionalString(value, "catalogId");
	if (catalogId === null) return { error: "catalogId must be a non-empty string when present" };
	const homepage = normalizeOptionalString(value, "homepage");
	if (homepage === null) return { error: "homepage must be a non-empty string when present" };

	const scope = normalizeScope(value.scope);
	if (!scope) return { error: "scope must contain string arrays" };
	const config = normalizeMcpConfig(value.config);
	if (!config) return { error: "config has no valid transport" };
	const installedAt = normalizeTimestamp(value.installedAt);
	if (!installedAt) return { error: "installedAt must be a valid timestamp" };
	const updatedAt = normalizeTimestamp(value.updatedAt);
	if (!updatedAt) return { error: "updatedAt must be a valid timestamp" };

	return {
		server: {
			id,
			source,
			catalogId,
			name,
			description,
			category,
			homepage,
			official: value.official,
			enabled: value.enabled,
			scope,
			config,
			installedAt,
			updatedAt,
		},
	};
}

/** Parse one unknown persisted entry into the canonical installed-server type. */
export function parseInstalledServer(value: unknown): InstalledMarketplaceMcpServer | null {
	const parsed = parseInstalledServerResult(value);
	return "server" in parsed ? parsed.server : null;
}

export function getInstalledMcpPath(): string {
	return join(resolveDefaultBasePath(), "marketplace", "mcp-servers.json");
}

function unreadableResult(path: string, reason: string): InstalledServerReadResult {
	return {
		path,
		readable: false,
		servers: [],
		invalidEntries: [{ index: null, reason }],
	};
}

/** Read active installed servers and retain diagnostics for rejected state. */
export function readInstalledServersWithDiagnostics(): InstalledServerReadResult {
	const path = getInstalledMcpPath();
	if (!existsSync(path)) {
		return { path, readable: true, servers: [], invalidEntries: [] };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return unreadableResult(path, "file is not valid JSON");
	}
	if (!Array.isArray(raw)) return unreadableResult(path, "root value must be an array");

	const servers: InstalledMarketplaceMcpServer[] = [];
	const invalidEntries: InvalidInstalledServerEntry[] = [];
	const ids = new Set<string>();
	for (const [index, value] of raw.entries()) {
		const parsed = parseInstalledServerResult(value);
		if (!("server" in parsed)) {
			invalidEntries.push({ index, reason: parsed.error });
			continue;
		}
		if (ids.has(parsed.server.id)) {
			invalidEntries.push({ index, reason: `duplicate id: ${parsed.server.id}` });
			continue;
		}
		ids.add(parsed.server.id);
		servers.push(parsed.server);
	}

	return { path, readable: true, servers, invalidEntries };
}

/** Return only the canonical active set; malformed rows never reach callers. */
export function readInstalledServers(): InstalledMarketplaceMcpServer[] {
	return [...readInstalledServersWithDiagnostics().servers];
}

function normalizeServersForWrite(servers: readonly unknown[]): InstalledMarketplaceMcpServer[] {
	const normalized: InstalledMarketplaceMcpServer[] = [];
	const ids = new Set<string>();
	for (const [index, value] of servers.entries()) {
		const parsed = parseInstalledServerResult(value);
		if (!("server" in parsed)) {
			throw new InstalledServerStateError(
				`Refusing to write invalid installed MCP server at index ${index}: ${parsed.error}`,
			);
		}
		if (ids.has(parsed.server.id)) {
			throw new InstalledServerStateError(`Refusing to write duplicate installed MCP server id: ${parsed.server.id}`);
		}
		ids.add(parsed.server.id);
		normalized.push(parsed.server);
	}
	return normalized;
}

function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let committed = false;
	try {
		writeFileSync(temporaryPath, content, "utf8");
		renameSync(temporaryPath, path);
		committed = true;
	} finally {
		if (!committed) rmSync(temporaryPath, { force: true });
	}
}

/**
 * Validate and atomically replace installed-server state.
 *
 * Valid rows from a mixed array are intentionally written back without the
 * rejected rows, which is the quarantine policy for row-level corruption.
 * A malformed JSON/root value is not safely classifiable and therefore blocks
 * the write instead of silently destroying the existing file.
 */
export function writeInstalledServers(servers: readonly unknown[]): void {
	const current = readInstalledServersWithDiagnostics();
	if (!current.readable) {
		throw new InstalledServerStateError(
			`Refusing to overwrite unreadable installed MCP server state at ${current.path}: ${current.invalidEntries[0]?.reason ?? "unknown error"}`,
		);
	}

	const normalized = normalizeServersForWrite(servers);
	writeAtomic(current.path, `${JSON.stringify(normalized, null, 2)}\n`);
}

export function sanitizeServerId(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.length > 0 ? normalized : "mcp-server";
}

export function makeUniqueServerId(baseId: string, installed: readonly InstalledMarketplaceMcpServer[]): string {
	if (!installed.some((server) => server.id === baseId)) return baseId;
	let suffix = 2;
	while (installed.some((server) => server.id === `${baseId}-${suffix}`)) {
		suffix++;
	}
	return `${baseId}-${suffix}`;
}

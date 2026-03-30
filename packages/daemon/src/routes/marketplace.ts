/**
 * Marketplace API routes.
 *
 * Exposes MCP server catalog browsing, install state, and tool routing.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hono } from "hono";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { resolveScopedAgent } from "../request-scope.js";
import { probeServer, removeProbeResult, storeProbeResult } from "../mcp-probe.js";
import { getSecret } from "../secrets.js";

const CATALOG_PAGE_SIZE = 30;
const CATALOG_MAX_PAGES = 10;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const TOOLS_TTL_MS = 30 * 1000;
/** mcpservers.org locale prefix — shared across catalog listing, detail fetch, and homepage URLs. */
const MCPSERVERS_LOCALE = "en";

export type MarketplaceMcpTransport = "stdio" | "http";
export type MarketplaceMcpCatalogSource = "mcpservers.org" | "modelcontextprotocol/servers" | "github";
export type MarketplaceMcpExposureMode = "compact" | "hybrid" | "expanded";

export interface MarketplaceMcpScope {
	readonly harnesses: readonly string[];
	readonly workspaces: readonly string[];
	readonly channels: readonly string[];
}

export interface MarketplaceMcpExposurePolicy {
	readonly mode: MarketplaceMcpExposureMode;
	readonly maxExpandedTools: number;
	readonly maxSearchResults: number;
	readonly updatedAt: string;
}

export interface MarketplaceMcpScopeContext {
	readonly harness?: string;
	readonly workspace?: string;
	readonly channel?: string;
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
	readonly source: MarketplaceMcpCatalogSource | "manual";
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

export interface MarketplaceMcpCatalogEntry {
	readonly id: string;
	readonly source: MarketplaceMcpCatalogSource;
	readonly catalogId: string;
	readonly name: string;
	readonly description: string;
	readonly category: string;
	readonly official: boolean;
	readonly sponsor: boolean;
	readonly popularityRank: number;
	readonly sourceUrl: string;
}

interface MarketplaceToolsCache {
	readonly fetchedAt: number;
	readonly tools: readonly MarketplaceMcpTool[];
	readonly serverHealth: readonly MarketplaceMcpServerHealth[];
}

interface MarketplaceMcpTool {
	readonly id: string;
	readonly serverId: string;
	readonly serverName: string;
	readonly toolName: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: unknown;
}

interface MarketplaceMcpServerHealth {
	readonly serverId: string;
	readonly serverName: string;
	readonly ok: boolean;
	readonly toolCount: number;
	readonly error?: string;
}

interface ParsedCatalogPage {
	readonly total: number;
	readonly entries: readonly MarketplaceMcpCatalogEntry[];
}

interface DetailConfig {
	readonly nameHint?: string;
	readonly config?: MarketplaceMcpConfig;
	readonly githubUrl?: string;
	readonly description: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const SECRET_REF_PREFIX = "secret://";
// Sentinel: "never explicitly set" — not process start time, which would
// be misleading since this default is returned whenever no policy file exists.
const DEFAULT_EXPOSURE_POLICY: MarketplaceMcpExposurePolicy = {
	mode: "hybrid",
	maxExpandedTools: 12,
	maxSearchResults: 8,
	updatedAt: "1970-01-01T00:00:00.000Z",
};

const catalogCache = new Map<number, { fetchedAt: number; page: ParsedCatalogPage }>();
let referenceCatalogCache: {
	readonly fetchedAt: number;
	readonly entries: readonly MarketplaceMcpCatalogEntry[];
} | null = null;
const toolsCache = new Map<string, MarketplaceToolsCache>();

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getMarketplaceDir(): string {
	return join(getAgentsDir(), "marketplace");
}

function getInstalledMcpPath(): string {
	return join(getMarketplaceDir(), "mcp-servers.json");
}

function getExposurePolicyPath(): string {
	return join(getMarketplaceDir(), "mcp-policy.json");
}

function ensureMarketplaceDir(): void {
	const dir = getMarketplaceDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function normalizeScopeValues(values: unknown): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of toStringArray(values)) {
		const item = value.trim();
		if (item.length === 0) continue;
		const key = item.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(item);
	}
	return normalized;
}

function normalizeScope(value: unknown): MarketplaceMcpScope {
	if (!isRecord(value)) {
		return {
			harnesses: [],
			workspaces: [],
			channels: [],
		};
	}

	return {
		harnesses: normalizeScopeValues(value.harnesses),
		workspaces: normalizeScopeValues(value.workspaces),
		channels: normalizeScopeValues(value.channels),
	};
}

function normalizeScopeContextValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed;
}

function extractScopeContext(input: {
	harness?: string;
	workspace?: string;
	channel?: string;
}): MarketplaceMcpScopeContext {
	return {
		harness: normalizeScopeContextValue(input.harness),
		workspace: normalizeScopeContextValue(input.workspace),
		channel: normalizeScopeContextValue(input.channel),
	};
}

function normalizeWorkspaceScopeEntry(value: string): string {
	const trimmed = value.trim().replaceAll("\\", "/");
	return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function dimensionMatches(
	allowed: readonly string[],
	current: string | undefined,
	kind: "default" | "workspace",
): boolean {
	if (allowed.length === 0) return true;
	if (!current) return false;

	const currentLower = current.toLowerCase().replaceAll("\\", "/");
	for (const rawEntry of allowed) {
		const entry = rawEntry.toLowerCase();
		if (kind === "workspace") {
			const normalized = normalizeWorkspaceScopeEntry(entry);
			const wildcard = normalized.endsWith("*") ? normalizeWorkspaceScopeEntry(normalized.slice(0, -1)) : null;
			if (wildcard && (currentLower === wildcard || currentLower.startsWith(`${wildcard}/`))) {
				return true;
			}
			if (currentLower === normalized || currentLower.startsWith(`${normalized}/`)) {
				return true;
			}
			continue;
		}

		if (currentLower === entry) {
			return true;
		}
	}

	return false;
}

function scopeMatches(scope: MarketplaceMcpScope, context: MarketplaceMcpScopeContext): boolean {
	return (
		dimensionMatches(scope.harnesses, context.harness, "default") &&
		dimensionMatches(scope.channels, context.channel, "default") &&
		dimensionMatches(scope.workspaces, context.workspace, "workspace")
	);
}

function parseExposureMode(value: unknown): MarketplaceMcpExposureMode | null {
	if (value === "compact" || value === "hybrid" || value === "expanded") {
		return value;
	}
	return null;
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.round(value)));
}

function parseExposurePolicy(value: unknown, fallbackUpdatedAt?: string): MarketplaceMcpExposurePolicy | null {
	if (!isRecord(value)) return null;
	const mode = parseExposureMode(value.mode);
	if (!mode) return null;

	const maxExpandedTools = parsePositiveInt(value.maxExpandedTools, DEFAULT_EXPOSURE_POLICY.maxExpandedTools, 0, 100);
	const maxSearchResults = parsePositiveInt(value.maxSearchResults, DEFAULT_EXPOSURE_POLICY.maxSearchResults, 1, 50);
	// Prefer stored updatedAt, then caller-supplied fallback (file mtime),
	// then the default sentinel — never use process start time.
	const updatedAt =
		typeof value.updatedAt === "string" ? value.updatedAt : (fallbackUpdatedAt ?? DEFAULT_EXPOSURE_POLICY.updatedAt);

	return { mode, maxExpandedTools, maxSearchResults, updatedAt };
}

function readExposurePolicy(): MarketplaceMcpExposurePolicy {
	const path = getExposurePolicyPath();
	if (!existsSync(path)) {
		return DEFAULT_EXPOSURE_POLICY;
	}

	try {
		const mtime = statSync(path).mtime.toISOString();
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return parseExposurePolicy(raw, mtime) ?? DEFAULT_EXPOSURE_POLICY;
	} catch {
		return DEFAULT_EXPOSURE_POLICY;
	}
}

function writeExposurePolicy(policy: MarketplaceMcpExposurePolicy): void {
	ensureMarketplaceDir();
	writeFileSync(getExposurePolicyPath(), JSON.stringify(policy, null, 2));
}

function extractContextFromRequest(c: {
	req: {
		query: (key: string) => string | undefined;
		header: (key: string) => string | undefined;
	};
}): MarketplaceMcpScopeContext {
	return extractScopeContext({
		harness: c.req.query("harness") ?? c.req.header("x-signet-harness") ?? undefined,
		workspace: c.req.query("workspace") ?? c.req.header("x-signet-workspace") ?? undefined,
		channel: c.req.query("channel") ?? c.req.header("x-signet-channel") ?? undefined,
	});
}

function filterServersByScope(
	servers: readonly InstalledMarketplaceMcpServer[],
	context: MarketplaceMcpScopeContext,
): InstalledMarketplaceMcpServer[] {
	return servers.filter((server) => scopeMatches(server.scope, context));
}

function hasScopeContext(context: MarketplaceMcpScopeContext): boolean {
	return Boolean(context.harness || context.workspace || context.channel);
}

function parseSecretReference(value: string): string | null {
	if (!value.startsWith(SECRET_REF_PREFIX)) {
		return null;
	}
	const name = value.slice(SECRET_REF_PREFIX.length).trim();
	if (!name) {
		return null;
	}
	return name;
}

async function resolveSecretReferences(values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		const secretName = parseSecretReference(value);
		if (!secretName) {
			resolved[key] = value;
			continue;
		}
		resolved[key] = await getSecret(secretName);
	}
	return resolved;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
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

function makeCatalogEntryId(source: MarketplaceMcpCatalogSource, catalogId: string): string {
	return `${source}:${catalogId}`;
}

function catalogSelectionKey(source: MarketplaceMcpCatalogSource, catalogId: string): string {
	return `${source}:${catalogId}`;
}

function parseCatalogSelection(
	rawId: string,
	rawSource?: string,
): { source: MarketplaceMcpCatalogSource; catalogId: string } {
	if (rawId.startsWith("modelcontextprotocol/servers:")) {
		return {
			source: "modelcontextprotocol/servers",
			catalogId: rawId.slice("modelcontextprotocol/servers:".length),
		};
	}

	if (rawId.startsWith("mcpservers.org:")) {
		return {
			source: "mcpservers.org",
			catalogId: rawId.slice("mcpservers.org:".length),
		};
	}

	if (rawId.startsWith("github:")) {
		return {
			source: "github",
			catalogId: rawId.slice("github:".length),
		};
	}

	if (rawSource === "modelcontextprotocol/servers") {
		return { source: rawSource, catalogId: rawId };
	}

	if (rawSource === "github") {
		return { source: rawSource, catalogId: rawId };
	}

	return { source: "mcpservers.org", catalogId: rawId };
}

function makeUniqueServerId(baseId: string, installed: readonly InstalledMarketplaceMcpServer[]): string {
	if (!installed.some((s) => s.id === baseId)) return baseId;
	let i = 2;
	while (installed.some((s) => s.id === `${baseId}-${i}`)) {
		i++;
	}
	return `${baseId}-${i}`;
}

function inferNameFromCatalogId(catalogId: string): string {
	const repo = catalogId.split("/").at(-1) ?? catalogId;
	const cleaned = repo
		.replace(/^mcp[-_]?/i, "")
		.replace(/[-_]+/g, " ")
		.trim();
	if (!cleaned) return catalogId;
	return cleaned
		.split(" ")
		.map((w) => (w.length > 0 ? `${w[0].toUpperCase()}${w.slice(1)}` : w))
		.join(" ");
}

function inferCategory(text: string): string {
	const source = text.toLowerCase();
	if (/browser|scrap|crawl|web/.test(source)) return "Web";
	if (/slack|discord|email|sms|message|chat/.test(source)) {
		return "Communication";
	}
	if (/database|sql|postgres|mysql|sqlite|d1|redis|vector/.test(source)) {
		return "Database";
	}
	if (/github|git|ci|deploy|build|code|dev/.test(source)) {
		return "Development";
	}
	if (/cloud|aws|gcp|azure|vercel|cloudflare/.test(source)) {
		return "Cloud";
	}
	if (/finance|stock|market|crypto|trading/.test(source)) {
		return "Finance";
	}
	if (/memory|knowledge|search|docs|rag/.test(source)) return "Knowledge";
	if (/file|storage|drive|s3|bucket/.test(source)) return "Storage";
	return "Other";
}

function parseCatalogMarkdown(markdown: string, page: number): ParsedCatalogPage {
	const totalMatch = markdown.match(/of\s+(\d+)\s+servers/i);
	const total = totalMatch ? Number(totalMatch[1]) : 0;

	const entries: MarketplaceMcpCatalogEntry[] = [];
	const seen = new Set<string>();
	// Locale segment is intentionally loose ([a-z][a-z-]{1,9}) to cover BCP-47 codes (en, zh-cn, pt-br)
	const re = /\[([^\]]+)\]\((https:\/\/mcpservers\.org\/(?:[a-z][a-z-]{1,9}\/)?servers\/[^)]+)\)/g;
	let m: RegExpExecArray | null;

	while ((m = re.exec(markdown)) !== null) {
		const rawText = m[1].replace(/\s+/g, " ").trim();
		const url = m[2].trim();
		const catalogId = url.replace(/^https:\/\/mcpservers\.org\/(?:[a-z][a-z-]{1,9}\/)?servers\//, "");
		if (!catalogId || seen.has(catalogId)) continue;
		seen.add(catalogId);

		const official = /\bofficial\b/i.test(rawText);
		const sponsor = /\bsponsor\b/i.test(rawText);
		const cleaned = rawText
			.replace(/\bofficial\b/gi, "")
			.replace(/\bsponsor\b/gi, "")
			.replace(/\s+/g, " ")
			.trim();

		const name = inferNameFromCatalogId(catalogId);
		const description = cleaned.length > 0 ? cleaned : `${name} MCP server`;
		const category = inferCategory(`${name} ${description}`);
		const popularityRank = (page - 1) * CATALOG_PAGE_SIZE + entries.length + 1;

		entries.push({
			id: makeCatalogEntryId("mcpservers.org", catalogId),
			source: "mcpservers.org",
			catalogId,
			name,
			description,
			category,
			official,
			sponsor,
			popularityRank,
			sourceUrl: url,
		});
	}

	return { total, entries };
}

/**
 * Parse the modelcontextprotocol/servers README into catalog entries.
 * Extracts both official reference servers (src/ links) and third-party
 * servers (external GitHub links). Non-GitHub third-party URLs are skipped.
 */
export function parseReferenceServersMarkdown(markdown: string): MarketplaceMcpCatalogEntry[] {
	const entries: MarketplaceMcpCatalogEntry[] = [];
	// Shared across reference and third-party passes; IDs are namespaced
	// ("modelcontextprotocol/servers:slug" vs "github:org/repo") so no collisions.
	const seen = new Set<string>();

	// Parse reference servers (src/ links)
	const refStart = markdown.indexOf("## 🌟 Reference Servers");
	if (refStart >= 0) {
		const refAfter = markdown.slice(refStart);
		// Find earliest section boundary; empty filter → Math.min() → Infinity → use whole remainder
		const boundaries = [refAfter.indexOf("\n### Archived"), refAfter.indexOf("\n## ", 1)].filter((i) => i > 0);
		const refEnd = boundaries.length > 0 ? Math.min(...boundaries) : refAfter.length;
		const refSection = refAfter.slice(0, refEnd);
		const re = /^-\s+\*\*\[([^\]]+)\]\(src\/([^)]+)\)\*\*\s+-\s+(.+)$/gm;
		let m: RegExpExecArray | null;
		while ((m = re.exec(refSection)) !== null) {
			const name = m[1].trim();
			const path = m[2].trim();
			const desc = m[3].trim();
			const slug = path.split("/").at(-1) ?? path;
			if (!name || !slug) continue;
			const id = makeCatalogEntryId("modelcontextprotocol/servers", slug);
			if (seen.has(id)) continue;
			seen.add(id);
			entries.push({
				id,
				source: "modelcontextprotocol/servers",
				catalogId: slug,
				name,
				description: desc,
				category: inferCategory(`${name} ${desc}`),
				official: true,
				sponsor: false,
				popularityRank: entries.length + 1,
				sourceUrl: `https://github.com/modelcontextprotocol/servers/tree/main/src/${path}`,
			});
		}
	}

	// Parse third-party servers (external GitHub links)
	const tpStart = markdown.indexOf("## 🤝 Third-Party Servers");
	if (tpStart >= 0) {
		const tpAfter = markdown.slice(tpStart);
		const nextSection = tpAfter.indexOf("\n## ", 1);
		const tpSection = nextSection > 0 ? tpAfter.slice(0, nextSection) : tpAfter;
		const re = /^-\s+(?:<img[^>]*>\s*)?\*\*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\*\*\s+-\s+(.+)$/gm;
		let m: RegExpExecArray | null;
		let tpRank = 0;
		while ((m = re.exec(tpSection)) !== null) {
			const name = m[1].trim();
			const url = m[2].trim();
			let raw = m[3].replace(/!\[[^\]]*\]\([^)]*\)/g, "");
			// Strip HTML tags iteratively to prevent nested-tag bypass (e.g. <scr<script>ipt>)
			let prev = "";
			while (prev !== raw) {
				prev = raw;
				raw = raw.replace(/<[^>]*>/g, "");
			}
			const desc = raw.replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
			if (!name || !url) continue;
			const ghMatch = url.match(/github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/);
			if (!ghMatch) continue;
			const slug = ghMatch[1].replace(/\/$/, "");
			const id = makeCatalogEntryId("github", slug);
			if (seen.has(id)) continue;
			seen.add(id);
			tpRank++;
			entries.push({
				id,
				source: "github",
				catalogId: slug,
				name,
				description: desc,
				category: inferCategory(`${name} ${desc}`),
				official: false,
				sponsor: false,
				popularityRank: tpRank,
				sourceUrl: url,
			});
		}
	}

	return entries;
}

async function fetchReferenceCatalogEntries(): Promise<readonly MarketplaceMcpCatalogEntry[]> {
	const now = Date.now();
	if (referenceCatalogCache && now - referenceCatalogCache.fetchedAt < CATALOG_TTL_MS) {
		return referenceCatalogCache.entries;
	}

	const res = await fetch("https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md", {
		headers: { "User-Agent": "signet-daemon-marketplace" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) {
		throw new Error(`reference catalog fetch failed: ${res.status}`);
	}

	const markdown = await readCapped(res);
	const entries = parseReferenceServersMarkdown(markdown);
	referenceCatalogCache = { fetchedAt: now, entries };
	return entries;
}

async function fetchCatalogPage(page: number): Promise<ParsedCatalogPage> {
	const now = Date.now();
	const cached = catalogCache.get(page);
	if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) {
		return cached.page;
	}

	const url = `https://r.jina.ai/http://mcpservers.org/${MCPSERVERS_LOCALE}/all?page=${page}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "signet-daemon-marketplace" },
		signal: AbortSignal.timeout(20_000),
	});

	if (!res.ok) {
		throw new Error(`catalog page fetch failed: ${res.status}`);
	}

	const markdown = await readCapped(res);
	const parsed = parseCatalogMarkdown(markdown, page);
	catalogCache.set(page, { fetchedAt: now, page: parsed });
	return parsed;
}

function normalizeMcpConfig(value: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): MarketplaceMcpConfig | null {
	if (!isRecord(value)) return null;

	if (typeof value.url === "string") {
		return {
			transport: "http",
			url: value.url,
			headers: toStringRecord(value.headers),
			timeoutMs,
		};
	}

	if (typeof value.command === "string") {
		return {
			transport: "stdio",
			command: value.command,
			args: toStringArray(value.args),
			env: toStringRecord(value.env),
			cwd: typeof value.cwd === "string" ? value.cwd : undefined,
			timeoutMs,
		};
	}

	if (Array.isArray(value.command)) {
		const commandParts = toStringArray(value.command);
		if (commandParts.length === 0) return null;
		return {
			transport: "stdio",
			command: commandParts[0],
			args: [...commandParts.slice(1), ...toStringArray(value.args)],
			env: toStringRecord(value.env),
			cwd: typeof value.cwd === "string" ? value.cwd : undefined,
			timeoutMs,
		};
	}

	return null;
}

export function extractStandardMcpConfig(markdown: string): DetailConfig {
	const titleMatch = markdown.match(/^([^\n]+)\n[-=]{3,}\n/m);
	const title = titleMatch ? titleMatch[1].trim() : undefined;

	let description = "";
	if (titleMatch) {
		const headingStart = markdown.indexOf(titleMatch[0]);
		const rest = markdown.slice(headingStart + titleMatch[0].length);
		const descMatch = rest.match(/^([^\n]+)$/m);
		if (descMatch) {
			description = descMatch[1].trim();
		}
	}

	const githubMatch = markdown.match(/\[GitHub\]\((https:\/\/github\.com\/[^)]+)\)/i);
	const githubUrl = githubMatch ? githubMatch[1] : undefined;

	const idx = markdown.search(/standard config/i);
	const target = idx >= 0 ? markdown.slice(idx) : markdown;
	const codeBlockRe = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;

	let config: MarketplaceMcpConfig | null = null;
	let nameHint: string | undefined;
	let m: RegExpExecArray | null;

	while ((m = codeBlockRe.exec(target)) !== null) {
		const body = m[1].trim();
		if (!body.includes("mcpServers") && !body.includes('"mcp"')) continue;
		try {
			const parsed = JSON.parse(body) as unknown;
			if (!isRecord(parsed)) continue;

			let serversRecord: Record<string, unknown> | null = null;
			if (isRecord(parsed.mcpServers)) {
				serversRecord = parsed.mcpServers;
			} else if (isRecord(parsed.mcp) && isRecord(parsed.mcp.servers)) {
				serversRecord = parsed.mcp.servers;
			}

			if (!serversRecord) continue;
			const first = Object.entries(serversRecord)[0];
			if (!first) continue;
			nameHint = first[0];
			config = normalizeMcpConfig(first[1]);
			if (config) break;
		} catch {
			// Ignore non-JSON or non-standard blocks
		}
	}

	return {
		nameHint,
		config: config ?? undefined,
		githubUrl,
		description,
	};
}

function parseInstalledServer(value: unknown): InstalledMarketplaceMcpServer | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string") return null;
	if (
		value.source !== "mcpservers.org" &&
		value.source !== "modelcontextprotocol/servers" &&
		value.source !== "manual" &&
		value.source !== "github"
	)
		return null;
	if (typeof value.name !== "string") return null;
	if (typeof value.description !== "string") return null;
	if (typeof value.category !== "string") return null;
	if (typeof value.official !== "boolean") return null;
	if (typeof value.enabled !== "boolean") return null;
	if (typeof value.installedAt !== "string") return null;
	if (typeof value.updatedAt !== "string") return null;

	const config = normalizeMcpConfig(value.config);
	if (!config) return null;

	return {
		id: value.id,
		source: value.source,
		catalogId: typeof value.catalogId === "string" ? value.catalogId : undefined,
		name: value.name,
		description: value.description,
		category: value.category,
		homepage: typeof value.homepage === "string" ? value.homepage : undefined,
		official: value.official,
		enabled: value.enabled,
		scope: normalizeScope(value.scope),
		config,
		installedAt: value.installedAt,
		updatedAt: value.updatedAt,
	};
}

/** NOTE: marketplace-helpers.ts has a public copy of this function to avoid circular imports.
 *  If you change the path or format here, update marketplace-helpers.ts to match. */
function readInstalledServers(): InstalledMarketplaceMcpServer[] {
	const path = getInstalledMcpPath();
	if (!existsSync(path)) return [];

	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw
			.map((item) => parseInstalledServer(item))
			.filter((item): item is InstalledMarketplaceMcpServer => item !== null);
	} catch {
		return [];
	}
}

function writeInstalledServers(servers: readonly InstalledMarketplaceMcpServer[]): void {
	ensureMarketplaceDir();
	writeFileSync(getInstalledMcpPath(), JSON.stringify(servers, null, 2));
}

async function fetchMcpServersOrgDetail(catalogId: string): Promise<DetailConfig> {
	const url = `https://r.jina.ai/http://mcpservers.org/${MCPSERVERS_LOCALE}/servers/${catalogId}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "signet-daemon-marketplace" },
		signal: AbortSignal.timeout(25_000),
	});

	if (!res.ok) {
		throw new Error(`detail fetch failed: ${res.status}`);
	}

	const markdown = await readCapped(res);
	return extractStandardMcpConfig(markdown);
}

/** Fetch README from the modelcontextprotocol/servers repo for a reference server. */
async function fetchReferenceServerDetail(catalogId: string): Promise<DetailConfig> {
	const encodedPath = catalogId
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	const url = `https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/${encodedPath}/README.md`;
	const res = await fetch(url, {
		headers: { "User-Agent": "signet-daemon-marketplace" },
		signal: AbortSignal.timeout(25_000),
	});

	if (!res.ok) {
		throw new Error(`reference detail fetch failed: ${res.status}`);
	}

	const markdown = await readCapped(res);
	return extractStandardMcpConfig(markdown);
}

const GITHUB_RAW_HOST = "https://raw.githubusercontent.com" as const;
const MAX_README_BYTES = 2 * 1024 * 1024; // 2 MB cap on fetched READMEs

/** Read response body with a size cap to prevent memory exhaustion. */
async function readCapped(res: Response): Promise<string> {
	const len = res.headers.get("content-length");
	if (len && Number.parseInt(len, 10) > MAX_README_BYTES) {
		throw new Error(`response too large: ${len} bytes`);
	}
	const text = await res.text();
	if (text.length > MAX_README_BYTES) {
		throw new Error(`response too large: ${text.length} chars`);
	}
	return text;
}

/**
 * Fetch README.md from a GitHub repo to extract MCP server config.
 * Security: only fetches from raw.githubusercontent.com with strict
 * org/repo validation — no arbitrary URLs or redirects followed.
 */
async function fetchGithubServerDetail(catalogId: string): Promise<DetailConfig> {
	if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(catalogId)) {
		throw new Error("invalid github catalog id: expected org/repo");
	}
	const encodedPath = catalogId
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	const headers = { "User-Agent": "signet-daemon-marketplace" };
	const timeout = 25_000;
	const url = `${GITHUB_RAW_HOST}/${encodedPath}/main/README.md`;
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });

	if (!res.ok) {
		if (res.status === 404) {
			const fallback = `${GITHUB_RAW_HOST}/${encodedPath}/master/README.md`;
			const res2 = await fetch(fallback, { headers, signal: AbortSignal.timeout(timeout) });
			if (res2.ok) return extractStandardMcpConfig(await readCapped(res2));
			throw new Error(`github detail fetch failed: main 404, master ${res2.status}`);
		}
		throw new Error(`github detail fetch failed: ${res.status}`);
	}

	const markdown = await readCapped(res);
	return extractStandardMcpConfig(markdown);
}

/** Route detail fetch to the appropriate handler based on catalog source. */
function fetchDetailBySource(source: MarketplaceMcpCatalogSource, catalogId: string): Promise<DetailConfig> {
	if (source === "modelcontextprotocol/servers") return fetchReferenceServerDetail(catalogId);
	if (source === "github") return fetchGithubServerDetail(catalogId);
	return fetchMcpServersOrgDetail(catalogId);
}

async function withConnectedClient<T>(
	server: InstalledMarketplaceMcpServer,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const run = async (): Promise<T> => {
		const client = new Client({
			name: "signet-marketplace-router",
			version: "0.1.0",
		});

		if (server.config.transport === "stdio") {
			const runtimeEnv: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) {
				if (typeof v === "string") runtimeEnv[k] = v;
			}
			const resolvedEnv = await resolveSecretReferences(server.config.env);
			const transport = new StdioClientTransport({
				command: server.config.command,
				args: [...server.config.args],
				env: { ...runtimeEnv, ...resolvedEnv },
				cwd: server.config.cwd,
			});

			await client.connect(transport);
			try {
				return await fn(client);
			} finally {
				await client.close().catch(() => undefined);
			}
		}

		const resolvedHeaders = await resolveSecretReferences(server.config.headers);
		const transport = new StreamableHTTPClientTransport(new URL(server.config.url), {
			requestInit: {
				headers: resolvedHeaders,
			},
		});
		await client.connect(transport);
		try {
			return await fn(client);
		} finally {
			await client.close().catch(() => undefined);
		}
	};

	return withTimeout(run(), server.config.timeoutMs, `MCP server ${server.id}`);
}

function sanitizeToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_\-:.]/g, "_");
}

async function loadMarketplaceTools(
	installed: readonly InstalledMarketplaceMcpServer[],
): Promise<MarketplaceToolsCache> {
	const cacheKey = installed
		.filter((server) => server.enabled)
		.map((server) => `${server.id}:${server.updatedAt}`)
		.sort()
		.join("|");

	const cached = toolsCache.get(cacheKey);
	const now = Date.now();
	if (cached && now - cached.fetchedAt < TOOLS_TTL_MS) {
		return cached;
	}

	const enabled = installed.filter((s) => s.enabled);
	const toolBuckets = await Promise.all(
		enabled.map(
			async (
				server,
			): Promise<{
				tools: MarketplaceMcpTool[];
				health: MarketplaceMcpServerHealth;
			}> => {
				try {
					const listResult = await withConnectedClient(server, async (client) => {
						const result = (await client.listTools()) as {
							tools?: Array<{
								name: string;
								description?: string;
								inputSchema?: unknown;
								annotations?: { readOnlyHint?: boolean };
							}>;
						};
						return result.tools ?? [];
					});

					const tools = listResult
						.filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
						.map((tool) => ({
							id: `${server.id}:${sanitizeToolName(tool.name)}`,
							serverId: server.id,
							serverName: server.name,
							toolName: tool.name,
							description: tool.description ?? "",
							readOnly: tool.annotations?.readOnlyHint === true,
							inputSchema: tool.inputSchema ?? {},
						}));

					return {
						tools,
						health: {
							serverId: server.id,
							serverName: server.name,
							ok: true,
							toolCount: tools.length,
						},
					};
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					return {
						tools: [],
						health: {
							serverId: server.id,
							serverName: server.name,
							ok: false,
							toolCount: 0,
							error: msg,
						},
					};
				}
			},
		),
	);

	const nextCache: MarketplaceToolsCache = {
		fetchedAt: now,
		tools: toolBuckets.flatMap((b) => b.tools),
		serverHealth: toolBuckets.map((b) => b.health),
	};

	toolsCache.set(cacheKey, nextCache);
	return nextCache;
}

function invalidateMarketplaceToolsCache(): void {
	toolsCache.clear();
}

function tokenizeQuery(value: string): string[] {
	return value
		.toLowerCase()
		.split(/\s+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);
}

function rankMarketplaceTools(tools: readonly MarketplaceMcpTool[], query: string): MarketplaceMcpTool[] {
	const tokens = tokenizeQuery(query);
	if (tokens.length === 0) {
		return [...tools];
	}

	const scored = tools
		.map((tool) => {
			const haystack = `${tool.serverId} ${tool.serverName} ${tool.toolName} ${tool.description}`.toLowerCase();
			let score = 0;
			for (const token of tokens) {
				if (tool.toolName.toLowerCase() === token) score += 6;
				if (tool.toolName.toLowerCase().includes(token)) score += 4;
				if (tool.serverName.toLowerCase().includes(token)) score += 3;
				if (tool.description.toLowerCase().includes(token)) score += 2;
				if (haystack.includes(token)) score += 1;
			}
			return { tool, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return `${a.tool.serverId}:${a.tool.toolName}`.localeCompare(`${b.tool.serverId}:${b.tool.toolName}`);
		});

	return scored.map((entry) => entry.tool);
}

// ---------------------------------------------------------------------------
// Invocation tracking
// ---------------------------------------------------------------------------

interface McpInvocationRecord {
	readonly serverId: string;
	readonly toolName: string;
	readonly agentId: string;
	readonly source: string;
	readonly latencyMs: number;
	readonly success: boolean;
	readonly errorText?: string;
}

function recordMcpInvocation(record: McpInvocationRecord): void {
	try {
		const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO mcp_invocations (id, server_id, tool_name, agent_id, source, latency_ms, success, error_text, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
			).run(
				id,
				record.serverId,
				record.toolName,
				record.agentId,
				record.source,
				record.latencyMs,
				record.success ? 1 : 0,
				record.errorText ?? null,
			);
		});
	} catch (err) {
		logger.warn("skills", "Failed to record MCP invocation", err instanceof Error ? err : undefined);
	}
}

export function mountMarketplaceRoutes(app: Hono, authMode?: import("../auth/index.js").AuthMode): void {
	app.get("/api/marketplace/mcp", (c) => {
		const servers = readInstalledServers();
		const context = extractContextFromRequest(c);
		const scopedQuery = c.req.query("scoped");
		const scoped = scopedQuery === "1" ? true : scopedQuery === "0" ? false : hasScopeContext(context);
		const visible = scoped ? filterServersByScope(servers, context) : servers;
		return c.json({
			servers: visible,
			count: visible.length,
			scoped,
			context,
		});
	});

	app.get("/api/marketplace/mcp/policy", (c) => {
		const policy = readExposurePolicy();
		return c.json({ policy });
	});

	app.patch("/api/marketplace/mcp/policy", async (c) => {
		let body: {
			mode?: MarketplaceMcpExposureMode;
			maxExpandedTools?: number;
			maxSearchResults?: number;
		} = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const current = readExposurePolicy();
		const mode = body.mode ?? current.mode;
		if (!parseExposureMode(mode)) {
			return c.json({ error: "mode must be compact, hybrid, or expanded" }, 400);
		}

		const next: MarketplaceMcpExposurePolicy = {
			mode,
			maxExpandedTools: parsePositiveInt(body.maxExpandedTools, current.maxExpandedTools, 0, 100),
			maxSearchResults: parsePositiveInt(body.maxSearchResults, current.maxSearchResults, 1, 50),
			updatedAt: new Date().toISOString(),
		};

		writeExposurePolicy(next);
		return c.json({ success: true, policy: next });
	});

	app.get("/api/marketplace/mcp/browse", async (c) => {
		const rawPages = Number(c.req.query("pages") ?? "5");
		const pages = Math.max(1, Math.min(CATALOG_MAX_PAGES, Number.isFinite(rawPages) ? rawPages : 5));

		try {
			const [referenceEntries, pageResults] = await Promise.all([
				fetchReferenceCatalogEntries(),
				Promise.all(Array.from({ length: pages }, (_, i) => fetchCatalogPage(i + 1))),
			]);
			const mcpTotal = pageResults[0]?.total ?? 0;
			const total = mcpTotal + referenceEntries.length;

			const installedKeys = new Set(
				readInstalledServers().flatMap((s) => {
					if (!s.catalogId) return [];
					if (s.source === "manual") return [];
					return [catalogSelectionKey(s.source, s.catalogId)];
				}),
			);

			const seen = new Set<string>();
			const mcpEntries = pageResults
				.flatMap((p) => p.entries)
				.filter((entry) => {
					if (seen.has(entry.id)) return false;
					seen.add(entry.id);
					return true;
				});

			const combined = [...referenceEntries, ...mcpEntries].map((entry, index) => ({
				...entry,
				popularityRank: index + 1,
				installed: installedKeys.has(catalogSelectionKey(entry.source, entry.catalogId)),
			}));

			return c.json({
				total,
				shown: combined.length,
				pageSize: CATALOG_PAGE_SIZE,
				pages,
				results: combined,
			});
		} catch (error) {
			logger.error("skills", "Failed to browse MCP marketplace", error as Error);
			return c.json({
				total: 0,
				shown: 0,
				pageSize: CATALOG_PAGE_SIZE,
				pages: 0,
				results: [],
				error: "Failed to load catalog",
			});
		}
	});

	app.get("/api/marketplace/mcp/detail", async (c) => {
		const id = c.req.query("id");
		const source = c.req.query("source") ?? undefined;
		if (!id) {
			return c.json({ error: "Invalid catalog id" }, 400);
		}

		const selection = parseCatalogSelection(id, source);
		if (selection.catalogId.length === 0 || selection.catalogId.includes("..") || selection.catalogId.startsWith("/")) {
			return c.json({ error: "Invalid catalog id" }, 400);
		}

		try {
			const detail = await fetchDetailBySource(selection.source, selection.catalogId);
			return c.json({
				id: selection.catalogId,
				source: selection.source,
				name: detail.nameHint ?? inferNameFromCatalogId(selection.catalogId),
				description: detail.description,
				githubUrl: detail.githubUrl,
				defaultConfig: detail.config ?? null,
			});
		} catch (error) {
			logger.warn("skills", "Failed to load MCP detail", {
				id: selection.catalogId,
				source: selection.source,
				error: error instanceof Error ? error.message : String(error),
			});
			return c.json({ error: "Failed to load MCP detail" }, 502);
		}
	});

	app.post("/api/marketplace/mcp/test", async (c) => {
		let body: { config?: unknown } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ success: false, error: "Invalid JSON body" }, 400);
		}

		const config = normalizeMcpConfig(body.config);
		if (!config) {
			return c.json({ success: false, error: "config must include command/url" }, 400);
		}

		const testServer: InstalledMarketplaceMcpServer = {
			id: "test-server",
			source: "manual",
			name: "Test Server",
			description: "Temporary config test",
			category: "Other",
			official: false,
			enabled: true,
			scope: normalizeScope(undefined),
			config,
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		const startedAt = Date.now();
		try {
			const tools = await withConnectedClient(testServer, async (client) => {
				const result = (await client.listTools()) as {
					tools?: Array<{ name?: string }>;
				};
				return (result.tools ?? [])
					.map((tool) => (typeof tool.name === "string" ? tool.name : ""))
					.filter((name) => name.length > 0);
			});

			return c.json({
				success: true,
				toolCount: tools.length,
				tools: tools.slice(0, 30),
				latencyMs: Date.now() - startedAt,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ success: false, error: message, latencyMs: Date.now() - startedAt }, 400);
		}
	});

	app.post("/api/marketplace/mcp/install", async (c) => {
		let body: {
			id?: string;
			source?: MarketplaceMcpCatalogSource;
			alias?: string;
			config?: unknown;
			scope?: unknown;
		} = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.id) {
			return c.json({ error: "id is required" }, 400);
		}

		const selection = parseCatalogSelection(body.id, body.source);
		const catalogId = selection.catalogId;
		if (catalogId.includes("..") || catalogId.startsWith("/")) {
			return c.json({ error: "Invalid catalog id" }, 400);
		}

		let normalized = normalizeMcpConfig(body.config);
		let detail: DetailConfig | undefined;
		const scope = normalizeScope(body.scope);

		if (!normalized) {
			try {
				detail = await fetchDetailBySource(selection.source, catalogId);
			} catch (error) {
				return c.json({ error: `Failed to fetch server detail: ${String(error)}` }, 502);
			}
			normalized = detail?.config ?? null;
		}

		if (!normalized) {
			return c.json(
				{
					error: "No standard MCP config found for this server. Use manual registration instead.",
				},
				422,
			);
		}

		const now = new Date().toISOString();
		const installed = readInstalledServers();

		const existing = installed.find((s) => s.catalogId === catalogId && s.source === selection.source);
		if (existing) {
			const updated: InstalledMarketplaceMcpServer = {
				...existing,
				enabled: true,
				scope: body.scope === undefined ? existing.scope : scope,
				config: normalized,
				updatedAt: now,
			};
			const next = installed.map((s) => (s.id === existing.id ? updated : s));
			writeInstalledServers(next);
			invalidateMarketplaceToolsCache();
			// Fire-and-forget probe on install/update
			void probeServer(updated)
				.then(storeProbeResult)
				.catch((err) => {
					logger.warn("probe", `Post-install probe failed for ${updated.id}: ${err}`);
				});
			return c.json({ success: true, server: updated, updated: true });
		}

		const sourceName = body.alias?.trim() || detail?.nameHint || inferNameFromCatalogId(catalogId);
		const baseId = sanitizeServerId(body.alias?.trim() || sourceName);
		const id = makeUniqueServerId(baseId, installed);
		const homepage =
			selection.source === "modelcontextprotocol/servers"
				? `https://github.com/modelcontextprotocol/servers/tree/main/src/${catalogId}`
				: selection.source === "github"
					? `https://github.com/${catalogId}`
					: `https://mcpservers.org/${MCPSERVERS_LOCALE}/servers/${catalogId}`;

		const server: InstalledMarketplaceMcpServer = {
			id,
			source: selection.source,
			catalogId,
			name: sourceName,
			description: detail?.description ?? `${sourceName} MCP server`,
			category: inferCategory(`${sourceName} ${detail?.description ?? ""}`),
			homepage,
			official: selection.source === "modelcontextprotocol/servers",
			enabled: true,
			scope,
			config: normalized,
			installedAt: now,
			updatedAt: now,
		};

		writeInstalledServers([...installed, server]);
		invalidateMarketplaceToolsCache();
		// Fire-and-forget probe on new install
		void probeServer(server)
			.then(storeProbeResult)
			.catch((err) => {
				logger.warn("probe", `Post-install probe failed for ${server.id}: ${err}`);
			});
		return c.json({ success: true, server, updated: false });
	});

	app.post("/api/marketplace/mcp/register", async (c) => {
		let body: { name?: string; description?: string; category?: string; config?: unknown; scope?: unknown } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.name || body.name.trim().length === 0) {
			return c.json({ error: "name is required" }, 400);
		}

		const normalized = normalizeMcpConfig(body.config);
		if (!normalized) {
			return c.json({ error: "config must include command/url" }, 400);
		}

		const installed = readInstalledServers();
		const id = makeUniqueServerId(sanitizeServerId(body.name), installed);
		const now = new Date().toISOString();

		const server: InstalledMarketplaceMcpServer = {
			id,
			source: "manual",
			name: body.name.trim(),
			description: body.description?.trim() || `${body.name.trim()} MCP server`,
			category: body.category?.trim() || inferCategory(body.name),
			official: false,
			enabled: true,
			scope: normalizeScope(body.scope),
			config: normalized,
			installedAt: now,
			updatedAt: now,
		};

		writeInstalledServers([...installed, server]);
		invalidateMarketplaceToolsCache();
		// Fire-and-forget probe on manual register
		void probeServer(server)
			.then(storeProbeResult)
			.catch((err) => {
				logger.warn("probe", `Post-register probe failed for ${server.id}: ${err}`);
			});
		return c.json({ success: true, server });
	});

	app.get("/api/marketplace/mcp/tools", async (c) => {
		const installed = readInstalledServers();
		const context = extractContextFromRequest(c);
		const scopedInstalled = filterServersByScope(installed, context);
		const refresh = c.req.query("refresh") === "1";
		if (refresh) {
			invalidateMarketplaceToolsCache();
		}

		try {
			const cached = await loadMarketplaceTools(scopedInstalled);
			return c.json({
				tools: cached.tools,
				servers: cached.serverHealth,
				count: cached.tools.length,
				context,
				policy: readExposurePolicy(),
			});
		} catch (error) {
			logger.error("skills", "Failed to load marketplace MCP tools", error as Error);
			return c.json({ tools: [], servers: [], count: 0, error: "Failed to load tools", context }, 500);
		}
	});

	app.get("/api/marketplace/mcp/search", async (c) => {
		const query = (c.req.query("q") ?? "").trim();
		const refresh = c.req.query("refresh") === "1";
		const policy = readExposurePolicy();
		const rawLimit = Number(c.req.query("limit") ?? String(policy.maxSearchResults));
		const limit = parsePositiveInt(rawLimit, policy.maxSearchResults, 1, 50);

		if (query.length < 2) {
			return c.json({ query, count: 0, results: [], error: "query must be at least 2 characters" }, 400);
		}

		const context = extractContextFromRequest(c);
		const installed = filterServersByScope(readInstalledServers(), context);
		if (refresh) {
			invalidateMarketplaceToolsCache();
		}

		try {
			const cached = await loadMarketplaceTools(installed);
			const ranked = rankMarketplaceTools(cached.tools, query).slice(0, limit);
			return c.json({
				query,
				count: ranked.length,
				results: ranked,
				context,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ query, count: 0, results: [], error: message, context }, 500);
		}
	});

	app.post("/api/marketplace/mcp/call", async (c) => {
		let body: { serverId?: string; toolName?: string; args?: unknown } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.serverId || !body.toolName) {
			return c.json({ error: "serverId and toolName are required" }, 400);
		}

		const context = extractContextFromRequest(c);
		const installed = readInstalledServers();
		const server = installed.find((s) => s.id === body.serverId && s.enabled && scopeMatches(s.scope, context));
		if (!server) {
			return c.json({ error: "Server not found, disabled, or out of scope" }, 404);
		}

		const VALID_SOURCES = new Set(["cli", "agent", "mcp", "dashboard"]);
		const raw = c.req.header("x-signet-mcp-source") ?? "mcp";
		const source = VALID_SOURCES.has(raw) ? raw : "mcp";
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			authMode ?? "local",
			c.req.header("x-signet-agent-id") ?? undefined,
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const start = Date.now();

		try {
			const args = isRecord(body.args) ? body.args : {};
			const result = await withConnectedClient(server, async (client) => {
				return client.callTool({ name: body.toolName ?? "", arguments: args });
			});
			recordMcpInvocation({
				serverId: body.serverId ?? "",
				toolName: body.toolName ?? "",
				agentId,
				source,
				latencyMs: Date.now() - start,
				success: true,
			});
			return c.json({ success: true, result });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			recordMcpInvocation({
				serverId: body.serverId ?? "",
				toolName: body.toolName ?? "",
				agentId,
				source,
				latencyMs: Date.now() - start,
				success: false,
				errorText: msg,
			});
			return c.json({ success: false, error: msg }, 500);
		}
	});

	app.post("/api/marketplace/mcp/read-resource", async (c) => {
		let body: { serverId?: string; uri?: string } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.serverId || !body.uri) {
			return c.json({ error: "serverId and uri are required" }, 400);
		}

		const context = extractContextFromRequest(c);
		const installed = readInstalledServers();
		const server = installed.find((s) => s.id === body.serverId && s.enabled && scopeMatches(s.scope, context));
		if (!server) {
			return c.json({ error: "Server not found, disabled, or out of scope" }, 404);
		}

		try {
			const result = await withConnectedClient(server, async (client) => {
				return client.readResource({ uri: body.uri ?? "" });
			});
			return c.json({ success: true, contents: result });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return c.json({ success: false, error: msg }, 500);
		}
	});

	app.get("/api/marketplace/mcp/:id", (c) => {
		const id = c.req.param("id");
		const installed = readInstalledServers();
		const server = installed.find((item) => item.id === id);
		if (!server) {
			return c.json({ error: "Server not found" }, 404);
		}

		const context = extractContextFromRequest(c);
		if (hasScopeContext(context) && !scopeMatches(server.scope, context)) {
			return c.json({ error: "Server is out of scope for current context" }, 403);
		}

		return c.json({ server, context });
	});

	app.patch("/api/marketplace/mcp/:id", async (c) => {
		const id = c.req.param("id");
		let body: { enabled?: boolean; config?: unknown; name?: string; description?: string; scope?: unknown } = {};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const installed = readInstalledServers();
		const existing = installed.find((s) => s.id === id);
		if (!existing) return c.json({ error: "Server not found" }, 404);

		const normalized = body.config ? normalizeMcpConfig(body.config) : null;
		if (body.config && !normalized) {
			return c.json({ error: "Invalid config" }, 400);
		}

		const updated: InstalledMarketplaceMcpServer = {
			...existing,
			enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
			scope: body.scope === undefined ? existing.scope : normalizeScope(body.scope),
			config: normalized ?? existing.config,
			name: typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim() : existing.name,
			description:
				typeof body.description === "string" && body.description.trim().length > 0
					? body.description.trim()
					: existing.description,
			updatedAt: new Date().toISOString(),
		};

		writeInstalledServers(installed.map((s) => (s.id === id ? updated : s)));
		invalidateMarketplaceToolsCache();
		return c.json({ success: true, server: updated });
	});

	app.delete("/api/marketplace/mcp/:id", (c) => {
		const id = c.req.param("id");
		const installed = readInstalledServers();
		if (!installed.some((s) => s.id === id)) {
			return c.json({ error: "Server not found" }, 404);
		}
		writeInstalledServers(installed.filter((s) => s.id !== id));
		invalidateMarketplaceToolsCache();
		// Clean up probe result and app tray entry on uninstall
		removeProbeResult(id);
		return c.json({ success: true, id });
	});
}

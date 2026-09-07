/** Canonical MCP installation application service for all daemon install routes. */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpProbeResult } from "@signet/core";
import { resolveDefaultBasePath } from "@signet/core";
import { loadProbeResult, probeServer as defaultProbeServer, storeProbeResult } from "./mcp-probe.js";
import { invalidateMarketplaceToolsCache } from "./marketplace-tools-cache.js";
import { validatePublicHttpUrl } from "./url-validation.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DETAIL_TIMEOUT_MS = 25_000;
const MAX_README_BYTES = 2 * 1024 * 1024;
const GITHUB_RAW_HOST = "https://raw.githubusercontent.com";

export type MarketplaceMcpTransport = "stdio" | "http";
export type MarketplaceMcpCatalogSource = "mcpservers.org" | "modelcontextprotocol/servers" | "github";

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
	/** Stable key used to make a retried install a no-op. */
	readonly installKey?: string;
	/** Operation id returned when this install crossed the mutation boundary. */
	readonly installOperationId?: string;
}

export interface MarketplaceMcpDetail {
	readonly nameHint?: string;
	readonly config?: MarketplaceMcpConfig;
	readonly githubUrl?: string;
	readonly description: string;
}

export type MarketplaceMcpInstallRequest =
	| {
			readonly kind: "direct";
			readonly url: string;
			readonly name?: string;
	  }
	| {
			readonly kind: "catalog";
			readonly source: MarketplaceMcpCatalogSource;
			readonly catalogId: string;
			readonly alias?: string;
			readonly config?: unknown;
			readonly scope?: unknown;
	  };

export interface MarketplaceMcpInstallOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly idempotencyKey?: string;
}

export type MarketplaceMcpInstallMutation = "created" | "updated" | "unchanged";
export type MarketplaceMcpInstallStatus = "completed" | "accepted";

export interface MarketplaceMcpInstallResult {
	readonly status: MarketplaceMcpInstallStatus;
	readonly operationId: string;
	readonly server: InstalledMarketplaceMcpServer;
	readonly mutation: MarketplaceMcpInstallMutation;
	readonly created: boolean;
	readonly updated: boolean;
	readonly probe?: McpProbeResult;
}

export interface MarketplaceMcpProbeOptions {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly operationId?: string;
}

export interface MarketplaceMcpInstallDependencies {
	readonly readInstalledServers?: () => InstalledMarketplaceMcpServer[];
	readonly writeInstalledServers?: (servers: readonly InstalledMarketplaceMcpServer[]) => void;
	readonly fetchDetail?: (
		source: MarketplaceMcpCatalogSource,
		catalogId: string,
		options: { readonly signal: AbortSignal; readonly timeoutMs: number },
	) => Promise<MarketplaceMcpDetail>;
	readonly invalidateToolsCache?: () => void;
	readonly probeServer?: (
		server: InstalledMarketplaceMcpServer,
		options: MarketplaceMcpProbeOptions,
	) => Promise<McpProbeResult>;
	readonly storeProbeResult?: (result: McpProbeResult) => void;
	readonly loadProbeResult?: (serverId: string) => McpProbeResult | null;
}

export class MarketplaceInstallError extends Error {
	readonly code: "invalid_request" | "timeout" | "missing_config";

	constructor(message: string, code: "invalid_request" | "timeout" | "missing_config") {
		super(message);
		this.name = "MarketplaceInstallError";
		this.code = code;
	}
}

interface InstallContext {
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
	readonly expire: () => void;
	readonly cleanup: () => void;
}

interface InstallPlan {
	readonly server: InstalledMarketplaceMcpServer;
	readonly next: readonly InstalledMarketplaceMcpServer[];
	readonly mutation: MarketplaceMcpInstallMutation;
	readonly created: boolean;
	readonly idempotent: boolean;
}

const inFlightInstalls = new Map<string, Promise<MarketplaceMcpInstallResult>>();

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

function getMarketplaceDir(): string {
	return join(getAgentsDir(), "marketplace");
}

function getInstalledMcpPath(): string {
	return join(getMarketplaceDir(), "mcp-servers.json");
}

function ensureMarketplaceDir(): void {
	const dir = getMarketplaceDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item;
	}
	return out;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
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

export function normalizeScope(value: unknown): MarketplaceMcpScope {
	if (!isRecord(value)) {
		return { harnesses: [], workspaces: [], channels: [] };
	}
	return {
		harnesses: normalizeScopeValues(value.harnesses),
		workspaces: normalizeScopeValues(value.workspaces),
		channels: normalizeScopeValues(value.channels),
	};
}

export function normalizeMcpConfig(value: unknown, timeoutMs = 20_000): MarketplaceMcpConfig | null {
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
	let index = 2;
	while (installed.some((server) => server.id === `${baseId}-${index}`)) index++;
	return `${baseId}-${index}`;
}

export function inferNameFromCatalogId(catalogId: string): string {
	const repo = catalogId.split("/").at(-1) ?? catalogId;
	const cleaned = repo
		.replace(/^mcp[-_]?/i, "")
		.replace(/[-_]+/g, " ")
		.trim();
	if (!cleaned) return catalogId;
	return cleaned
		.split(" ")
		.map((word) => (word.length > 0 ? `${word[0].toUpperCase()}${word.slice(1)}` : word))
		.join(" ");
}

export function inferNameFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		let name = parsed.hostname.replace(/^(www|api|mcp)\./, "").replace(/\.(com|org|io|dev|app|net)$/, "");
		const pathParts = parsed.pathname
			.split("/")
			.filter((part) => part.length > 0 && part !== "mcp" && part !== "sse" && part !== "v1");
		if (pathParts.length > 0) name = `${name}-${pathParts[0]}`;
		return name
			.replace(/[-_]+/g, " ")
			.trim()
			.split(" ")
			.map((word) => (word.length > 0 ? `${word[0].toUpperCase()}${word.slice(1)}` : word))
			.join(" ");
	} catch {
		return "MCP Server";
	}
}

export function inferCategory(text: string): string {
	const source = text.toLowerCase();
	if (/browser|scrap|crawl|web/.test(source)) return "Web";
	if (/slack|discord|email|sms|message|chat/.test(source)) return "Communication";
	if (/database|sql|postgres|mysql|sqlite|d1|redis|vector/.test(source)) return "Database";
	if (/github|git|ci|deploy|build|code|dev/.test(source)) return "Development";
	if (/cloud|aws|gcp|azure|vercel|cloudflare/.test(source)) return "Cloud";
	if (/finance|stock|market|crypto|trading/.test(source)) return "Finance";
	if (/memory|knowledge|search|docs|rag/.test(source)) return "Knowledge";
	if (/file|storage|drive|s3|bucket/.test(source)) return "Storage";
	return "Other";
}

function parseInstalledServer(value: unknown): InstalledMarketplaceMcpServer | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || typeof value.name !== "string") return null;
	if (
		value.source !== "mcpservers.org" &&
		value.source !== "modelcontextprotocol/servers" &&
		value.source !== "manual" &&
		value.source !== "github"
	)
		return null;
	if (typeof value.description !== "string" || typeof value.category !== "string") return null;
	if (typeof value.official !== "boolean" || typeof value.enabled !== "boolean") return null;
	if (typeof value.installedAt !== "string" || typeof value.updatedAt !== "string") return null;

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
		installKey: typeof value.installKey === "string" ? value.installKey : undefined,
		installOperationId: typeof value.installOperationId === "string" ? value.installOperationId : undefined,
	};
}

export function readInstalledServers(): InstalledMarketplaceMcpServer[] {
	const path = getInstalledMcpPath();
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.map(parseInstalledServer).filter((item): item is InstalledMarketplaceMcpServer => item !== null);
	} catch {
		return [];
	}
}

export function writeInstalledServers(servers: readonly InstalledMarketplaceMcpServer[]): void {
	ensureMarketplaceDir();
	writeFileSync(getInstalledMcpPath(), JSON.stringify(servers, null, 2));
}

export function parseCatalogSelection(
	rawId: string,
	rawSource?: string,
): { source: MarketplaceMcpCatalogSource; catalogId: string } {
	if (rawId.startsWith("modelcontextprotocol/servers:")) {
		return { source: "modelcontextprotocol/servers", catalogId: rawId.slice("modelcontextprotocol/servers:".length) };
	}
	if (rawId.startsWith("mcpservers.org:")) {
		return { source: "mcpservers.org", catalogId: rawId.slice("mcpservers.org:".length) };
	}
	if (rawId.startsWith("github:")) {
		return { source: "github", catalogId: rawId.slice("github:".length) };
	}
	if (rawSource === "modelcontextprotocol/servers") return { source: rawSource, catalogId: rawId };
	if (rawSource === "github") return { source: rawSource, catalogId: rawId };
	return { source: "mcpservers.org", catalogId: rawId };
}

function isCatalogSource(value: string): value is MarketplaceMcpCatalogSource {
	return value === "mcpservers.org" || value === "modelcontextprotocol/servers" || value === "github";
}

function normalizeOptionalName(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeInstallRequest(request: MarketplaceMcpInstallRequest): MarketplaceMcpInstallRequest {
	if (request.kind === "direct") {
		const url = request.url.trim();
		const error = validatePublicHttpUrl(url);
		if (error) throw new MarketplaceInstallError(error, "invalid_request");
		return { kind: "direct", url, name: normalizeOptionalName(request.name) };
	}

	if (!isCatalogSource(request.source))
		throw new MarketplaceInstallError("Invalid marketplace source", "invalid_request");
	const catalogId = request.catalogId.trim();
	if (catalogId.length === 0 || catalogId.includes("..") || catalogId.startsWith("/")) {
		throw new MarketplaceInstallError("Invalid catalog id", "invalid_request");
	}
	return {
		kind: "catalog",
		source: request.source,
		catalogId,
		alias: normalizeOptionalName(request.alias),
		config: request.config,
		scope: request.scope,
	};
}

function hashInstallKey(value: string): string {
	return `mcp-install-key:${createHash("sha256").update(value).digest("hex")}`;
}

function deriveInstallKey(request: MarketplaceMcpInstallRequest): string {
	const raw =
		request.kind === "direct"
			? `direct:${request.url}:${request.name ?? ""}`
			: `catalog:${request.source}:${request.catalogId}:${request.alias ?? ""}`;
	return hashInstallKey(raw);
}

function normalizeIdempotencyKey(value: string | undefined, fallback: string): string {
	const normalized = value?.trim();
	if (!normalized || normalized.length > 256) return fallback;
	return hashInstallKey(`explicit:${normalized}`);
}

function resolveTimeout(value: number | undefined): number {
	if (!Number.isFinite(value) || value === undefined) return DEFAULT_TIMEOUT_MS;
	return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function createInstallContext(options: MarketplaceMcpInstallOptions): InstallContext {
	const timeoutMs = resolveTimeout(options.timeoutMs);
	const deadlineController = new AbortController();
	const deadlineTimer = setTimeout(
		() => deadlineController.abort(new DOMException("The MCP install deadline expired", "TimeoutError")),
		timeoutMs,
	);
	const signal = options.signal
		? AbortSignal.any([options.signal, deadlineController.signal])
		: deadlineController.signal;
	return {
		signal,
		deadlineAt: Date.now() + timeoutMs,
		expire: (): void => deadlineController.abort(new DOMException("The MCP install deadline expired", "TimeoutError")),
		cleanup: (): void => clearTimeout(deadlineTimer),
	};
}

function remainingMs(context: InstallContext): number {
	return Math.max(0, context.deadlineAt - Date.now());
}

function isActive(context: InstallContext): boolean {
	return !context.signal.aborted && remainingMs(context) > 0;
}

function requireActive(context: InstallContext, stage: string): void {
	if (!isActive(context)) {
		throw new MarketplaceInstallError(`MCP install timed out or was cancelled during ${stage}`, "timeout");
	}
}

async function waitForInstallStage<T>(promise: Promise<T>, context: InstallContext, stage: string): Promise<T> {
	const timeoutMs = remainingMs(context);
	requireActive(context, stage);
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	let onAbort: (() => void) | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				const rejectExpired = (): void => {
					context.expire();
					reject(new MarketplaceInstallError(`MCP install timed out or was cancelled during ${stage}`, "timeout"));
				};
				onAbort = rejectExpired;
				timeoutHandle = setTimeout(rejectExpired, timeoutMs);
				if (context.signal.aborted) {
					rejectExpired();
				} else {
					context.signal.addEventListener("abort", rejectExpired, { once: true });
					if (context.signal.aborted) rejectExpired();
				}
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (onAbort) context.signal.removeEventListener("abort", onAbort);
	}
}

function acceptedResult(operationId: string, plan: InstallPlan): MarketplaceMcpInstallResult {
	return {
		status: "accepted",
		operationId,
		server: plan.server,
		mutation: plan.mutation,
		created: plan.created,
		updated: plan.mutation === "updated",
	};
}

function completedResult(operationId: string, plan: InstallPlan, probe: McpProbeResult): MarketplaceMcpInstallResult {
	return {
		status: "completed",
		operationId,
		server: plan.server,
		mutation: plan.mutation,
		created: plan.created,
		updated: plan.mutation === "updated",
		probe,
	};
}

function idempotentResult(
	operationId: string,
	plan: InstallPlan,
	dependencies: Required<MarketplaceMcpInstallDependencies>,
): MarketplaceMcpInstallResult {
	const probe = dependencies.loadProbeResult(plan.server.id);
	const priorOperationId = plan.server.installOperationId ?? operationId;
	// An update keeps the server id, so an older probe file must not make a
	// timed-out update look completed.
	if (
		probe &&
		((plan.server.installOperationId !== undefined && probe.installOperationId === plan.server.installOperationId) ||
			(probe.installOperationId === undefined && probe.probedAt > plan.server.updatedAt))
	) {
		return completedResult(priorOperationId, plan, probe);
	}
	return acceptedResult(priorOperationId, plan);
}

function buildDirectPlan(
	request: Extract<MarketplaceMcpInstallRequest, { kind: "direct" }>,
	installed: readonly InstalledMarketplaceMcpServer[],
	operationId: string,
	installKey: string,
): InstallPlan {
	const existing = installed.find((server) => server.config.transport === "http" && server.config.url === request.url);
	if (existing) {
		if (existing.installKey === installKey) {
			return { server: existing, next: installed, mutation: "unchanged", created: false, idempotent: true };
		}
		const name = request.name ?? existing.name;
		const updated: InstalledMarketplaceMcpServer = {
			...existing,
			enabled: true,
			name,
			installKey,
			installOperationId: operationId,
			updatedAt: new Date().toISOString(),
		};
		return {
			server: updated,
			next: installed.map((server) => (server.id === existing.id ? updated : server)),
			mutation: "updated",
			created: false,
			idempotent: false,
		};
	}

	const name = request.name ?? inferNameFromUrl(request.url);
	const now = new Date().toISOString();
	const server: InstalledMarketplaceMcpServer = {
		id: makeUniqueServerId(sanitizeServerId(name), installed),
		source: "manual",
		name,
		description: `${name} MCP server`,
		category: inferCategory(name),
		homepage: request.url,
		official: false,
		enabled: true,
		scope: normalizeScope(undefined),
		config: { transport: "http", url: request.url, headers: {}, timeoutMs: 20_000 },
		installedAt: now,
		updatedAt: now,
		installKey,
		installOperationId: operationId,
	};
	return { server, next: [...installed, server], mutation: "created", created: true, idempotent: false };
}

function buildCatalogPlan(
	request: Extract<MarketplaceMcpInstallRequest, { kind: "catalog" }>,
	detail: MarketplaceMcpDetail | undefined,
	normalizedConfig: MarketplaceMcpConfig,
	installed: readonly InstalledMarketplaceMcpServer[],
	operationId: string,
	installKey: string,
): InstallPlan {
	const existing = installed.find(
		(server) => server.catalogId === request.catalogId && server.source === request.source,
	);
	if (existing) {
		if (existing.installKey === installKey) {
			return { server: existing, next: installed, mutation: "unchanged", created: false, idempotent: true };
		}
		const updated: InstalledMarketplaceMcpServer = {
			...existing,
			enabled: true,
			scope: request.scope === undefined ? existing.scope : normalizeScope(request.scope),
			config: normalizedConfig,
			installKey,
			installOperationId: operationId,
			updatedAt: new Date().toISOString(),
		};
		return {
			server: updated,
			next: installed.map((server) => (server.id === existing.id ? updated : server)),
			mutation: "updated",
			created: false,
			idempotent: false,
		};
	}

	const sourceName = request.alias ?? detail?.nameHint ?? inferNameFromCatalogId(request.catalogId);
	const homepage =
		request.source === "modelcontextprotocol/servers"
			? `https://github.com/modelcontextprotocol/servers/tree/main/src/${request.catalogId}`
			: request.source === "github"
				? `https://github.com/${request.catalogId}`
				: `https://mcpservers.org/en/servers/${request.catalogId}`;
	const now = new Date().toISOString();
	const server: InstalledMarketplaceMcpServer = {
		id: makeUniqueServerId(sanitizeServerId(sourceName), installed),
		source: request.source,
		catalogId: request.catalogId,
		name: sourceName,
		description: detail?.description ?? `${sourceName} MCP server`,
		category: inferCategory(`${sourceName} ${detail?.description ?? ""}`),
		homepage,
		official: request.source === "modelcontextprotocol/servers",
		enabled: true,
		scope: normalizeScope(request.scope),
		config: normalizedConfig,
		installedAt: now,
		updatedAt: now,
		installKey,
		installOperationId: operationId,
	};
	return { server, next: [...installed, server], mutation: "created", created: true, idempotent: false };
}

function resolveDependencies(input: MarketplaceMcpInstallDependencies): Required<MarketplaceMcpInstallDependencies> {
	return {
		readInstalledServers: input.readInstalledServers ?? readInstalledServers,
		writeInstalledServers: input.writeInstalledServers ?? writeInstalledServers,
		fetchDetail: input.fetchDetail ?? fetchDetailBySource,
		invalidateToolsCache: input.invalidateToolsCache ?? invalidateMarketplaceToolsCache,
		probeServer: input.probeServer ?? defaultProbeServer,
		storeProbeResult: input.storeProbeResult ?? storeProbeResult,
		loadProbeResult: input.loadProbeResult ?? loadProbeResult,
	};
}

async function preparePlan(
	request: MarketplaceMcpInstallRequest,
	context: InstallContext,
	operationId: string,
	installKey: string,
	dependencies: Required<MarketplaceMcpInstallDependencies>,
): Promise<InstallPlan> {
	requireActive(context, "preparation");
	const installed = dependencies.readInstalledServers();
	if (request.kind === "direct") return buildDirectPlan(request, installed, operationId, installKey);
	const existing = installed.find(
		(server) =>
			server.catalogId === request.catalogId && server.source === request.source && server.installKey === installKey,
	);
	if (existing) {
		return { server: existing, next: installed, mutation: "unchanged", created: false, idempotent: true };
	}

	let detail: MarketplaceMcpDetail | undefined;
	let normalizedConfig = normalizeMcpConfig(request.config);
	if (!normalizedConfig) {
		const timeoutMs = remainingMs(context);
		requireActive(context, "catalog detail fetch");
		try {
			detail = await waitForInstallStage(
				dependencies.fetchDetail(request.source, request.catalogId, {
					signal: context.signal,
					timeoutMs,
				}),
				context,
				"catalog detail fetch",
			);
		} catch (error) {
			if (!isActive(context)) {
				throw new MarketplaceInstallError(
					"MCP install timed out or was cancelled during catalog detail fetch",
					"timeout",
				);
			}
			throw error;
		}
		normalizedConfig = detail.config ?? null;
	}
	if (!normalizedConfig) {
		throw new MarketplaceInstallError(
			"No standard MCP config found for this server. Use manual registration instead.",
			"missing_config",
		);
	}
	return buildCatalogPlan(request, detail, normalizedConfig, installed, operationId, installKey);
}

async function runInstallWithinContext(
	request: MarketplaceMcpInstallRequest,
	context: InstallContext,
	installKey: string,
	dependencies: Required<MarketplaceMcpInstallDependencies>,
): Promise<MarketplaceMcpInstallResult> {
	const operationId = `mcp-install-${randomUUID()}`;
	const plan = await preparePlan(request, context, operationId, installKey, dependencies);
	if (plan.idempotent) return idempotentResult(operationId, plan, dependencies);

	// This synchronous call is the one canonical installed-state mutation. The
	// deadline fence immediately before it prevents a catalog fetch that timed
	// out from mutating state after the caller has received a failure.
	requireActive(context, "installed-state mutation");
	dependencies.writeInstalledServers(plan.next);
	dependencies.invalidateToolsCache();

	// The mutation is now accepted. If the caller deadline expires from here on,
	// return the operation id rather than allowing a detached probe-result write.
	if (!isActive(context)) return acceptedResult(operationId, plan);

	let probe: McpProbeResult;
	try {
		probe = await waitForInstallStage(
			dependencies.probeServer(plan.server, {
				signal: context.signal,
				timeoutMs: Math.max(1, remainingMs(context)),
				operationId,
			}),
			context,
			"probe",
		);
	} catch {
		return acceptedResult(operationId, plan);
	}

	if (!isActive(context)) return acceptedResult(operationId, plan);
	try {
		dependencies.storeProbeResult(probe);
	} catch {
		return acceptedResult(operationId, plan);
	}
	return completedResult(operationId, plan, probe);
}

async function runInstall(
	request: MarketplaceMcpInstallRequest,
	options: MarketplaceMcpInstallOptions,
	installKey: string,
	dependencies: Required<MarketplaceMcpInstallDependencies>,
): Promise<MarketplaceMcpInstallResult> {
	const context = createInstallContext(options);
	try {
		return await runInstallWithinContext(request, context, installKey, dependencies);
	} finally {
		context.cleanup();
	}
}

/**
 * Install a direct or catalog MCP server through one bounded, idempotent path.
 * Concurrent requests for the same stable key share one operation.
 */
export async function installMcpServer(
	input: MarketplaceMcpInstallRequest,
	options: MarketplaceMcpInstallOptions = {},
	dependencyInput: MarketplaceMcpInstallDependencies = {},
): Promise<MarketplaceMcpInstallResult> {
	const request = normalizeInstallRequest(input);
	const derivedKey = deriveInstallKey(request);
	const installKey = normalizeIdempotencyKey(options.idempotencyKey, derivedKey);
	const existing = inFlightInstalls.get(installKey);
	if (existing) return existing;

	const dependencies = resolveDependencies(dependencyInput);
	const operation = runInstall(request, options, installKey, dependencies);
	inFlightInstalls.set(installKey, operation);
	try {
		return await operation;
	} finally {
		if (inFlightInstalls.get(installKey) === operation) inFlightInstalls.delete(installKey);
	}
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function readCapped(response: Response): Promise<string> {
	const length = response.headers.get("content-length");
	if (length && Number.parseInt(length, 10) > MAX_README_BYTES) {
		throw new Error(`response too large: ${length} bytes`);
	}
	const text = await response.text();
	if (text.length > MAX_README_BYTES) throw new Error(`response too large: ${text.length} chars`);
	return text;
}

async function fetchText(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
	const response = await fetch(url, {
		headers: { "User-Agent": "signet-daemon-marketplace" },
		signal: combineSignal(signal, Math.min(timeoutMs, DETAIL_TIMEOUT_MS)),
	});
	if (!response.ok) throw new Error(`detail fetch failed: ${response.status}`);
	return readCapped(response);
}

/** Parse a standard MCP config from a catalog README/detail page. */
export function extractStandardMcpConfig(markdown: string): MarketplaceMcpDetail {
	const titleMatch = markdown.match(/^([^\n]+)\n[-=]{3,}\n/m);
	let description = "";
	if (titleMatch) {
		const rest = markdown.slice(markdown.indexOf(titleMatch[0]) + titleMatch[0].length);
		const descriptionMatch = rest.match(/^([^\n]+)$/m);
		if (descriptionMatch) description = descriptionMatch[1].trim();
	}

	const githubMatch = markdown.match(/\[GitHub\]\((https:\/\/github\.com\/[^)]+)\)/i);
	const githubUrl = githubMatch ? githubMatch[1] : undefined;
	const configSection = markdown.search(/standard config/i);
	const target = configSection >= 0 ? markdown.slice(configSection) : markdown;
	const codeBlockRe = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
	let config: MarketplaceMcpConfig | undefined;
	let nameHint: string | undefined;
	let match: RegExpExecArray | null;

	while ((match = codeBlockRe.exec(target)) !== null) {
		const body = match[1].trim();
		if (!body.includes("mcpServers") && !body.includes('"mcp"')) continue;
		try {
			const parsed = JSON.parse(body) as unknown;
			if (!isRecord(parsed)) continue;
			const servers = isRecord(parsed.mcpServers)
				? parsed.mcpServers
				: isRecord(parsed.mcp) && isRecord(parsed.mcp.servers)
					? parsed.mcp.servers
					: null;
			if (!servers) continue;
			const first = Object.entries(servers)[0];
			if (!first) continue;
			nameHint = first[0];
			config = normalizeMcpConfig(first[1]) ?? undefined;
			if (config) break;
		} catch {
			// Ignore non-JSON code blocks and continue looking for a standard block.
		}
	}

	return { nameHint, config, githubUrl, description };
}

async function fetchMcpServersOrgDetail(
	catalogId: string,
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<MarketplaceMcpDetail> {
	const markdown = await fetchText(
		`https://r.jina.ai/http://mcpservers.org/en/servers/${catalogId}`,
		options.signal,
		options.timeoutMs,
	);
	return extractStandardMcpConfig(markdown);
}

async function fetchReferenceServerDetail(
	catalogId: string,
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<MarketplaceMcpDetail> {
	const encodedPath = catalogId
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	const markdown = await fetchText(
		`https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/${encodedPath}/README.md`,
		options.signal,
		options.timeoutMs,
	);
	return extractStandardMcpConfig(markdown);
}

async function fetchGithubServerDetail(
	catalogId: string,
	options: { signal: AbortSignal; timeoutMs: number },
): Promise<MarketplaceMcpDetail> {
	if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(catalogId)) {
		throw new Error("invalid github catalog id: expected org/repo");
	}
	const encodedPath = catalogId
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	const headers = { "User-Agent": "signet-daemon-marketplace" };
	const signal = combineSignal(options.signal, Math.min(options.timeoutMs, DETAIL_TIMEOUT_MS));
	const main = await fetch(`${GITHUB_RAW_HOST}/${encodedPath}/main/README.md`, { headers, signal });
	if (main.ok) return extractStandardMcpConfig(await readCapped(main));
	if (main.status !== 404) throw new Error(`github detail fetch failed: ${main.status}`);

	const master = await fetch(`${GITHUB_RAW_HOST}/${encodedPath}/master/README.md`, { headers, signal });
	if (!master.ok) throw new Error(`github detail fetch failed: main 404, master ${master.status}`);
	return extractStandardMcpConfig(await readCapped(master));
}

/** Fetch and parse catalog detail under the caller's remaining deadline. */
export function fetchDetailBySource(
	source: MarketplaceMcpCatalogSource,
	catalogId: string,
	options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<MarketplaceMcpDetail> {
	const timeoutMs = Math.max(1, Math.min(DETAIL_TIMEOUT_MS, options.timeoutMs ?? DETAIL_TIMEOUT_MS));
	const signal = combineSignal(options.signal, timeoutMs);
	const fetchOptions = { signal, timeoutMs };
	if (source === "modelcontextprotocol/servers") return fetchReferenceServerDetail(catalogId, fetchOptions);
	if (source === "github") return fetchGithubServerDetail(catalogId, fetchOptions);
	return fetchMcpServersOrgDetail(catalogId, fetchOptions);
}

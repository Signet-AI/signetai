/**
 * MCP tool definitions for the Signet daemon.
 *
 * Creates an McpServer with memory operations exposed as MCP tools.
 * Tool handlers call the daemon's HTTP API — this avoids duplicating
 * the complex recall/remember logic and ensures feature parity.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	SIGNET_GRAPHIQ_PLUGIN_ID,
	applyRecallScoreThreshold,
	buildRecallRequestBody,
	buildRememberRequestBody,
	formatRecallText,
} from "@signet/core";
import { z } from "zod";
import { getActiveGraphiqDbPath, runGraphiqCli } from "../graphiq.js";
import { createDefaultPluginHost } from "../plugins/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerOptions {
	/** Daemon HTTP base URL (default: http://localhost:3850) */
	readonly daemonUrl?: string;
	/** Server version string */
	readonly version?: string;
	/** Register installed marketplace MCP tools as first-class MCP tools */
	readonly enableMarketplaceProxyTools?: boolean;
	/** Optional scope context used for marketplace filtering */
	readonly context?: {
		readonly harness?: string;
		readonly workspace?: string;
		readonly channel?: string;
	};
	/** Plugin policy source used to gate plugin-owned MCP surfaces */
	readonly pluginHost?: GraphiqPluginPolicyHost;
}

type GraphiqPluginPolicyHostProvider = () => GraphiqPluginPolicyHost;

interface GraphiqPluginPolicyHost {
	readonly get: (id: string) =>
		| {
				readonly state: string;
				readonly surfaces: {
					readonly mcpTools: ReadonlyArray<{ readonly name: string }>;
				};
		  }
		| undefined;
}

interface MarketplaceRoutedTool {
	readonly id: string;
	readonly serverId: string;
	readonly serverName: string;
	readonly toolName: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: unknown;
}

interface MarketplaceToolsResponse {
	readonly tools: ReadonlyArray<MarketplaceRoutedTool>;
	readonly servers: ReadonlyArray<unknown>;
	readonly count: number;
}

interface MarketplaceServerRecord {
	readonly id: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly source: string;
	readonly scope: {
		readonly harnesses: readonly string[];
		readonly workspaces: readonly string[];
		readonly channels: readonly string[];
	};
}

interface MarketplaceServersResponse {
	readonly servers: ReadonlyArray<MarketplaceServerRecord>;
	readonly count: number;
}

interface MarketplaceSearchResponse {
	readonly query: string;
	readonly count: number;
	readonly results: ReadonlyArray<MarketplaceRoutedTool>;
}

interface MarketplacePolicy {
	readonly mode: "compact" | "hybrid" | "expanded";
	readonly maxExpandedTools: number;
	readonly maxSearchResults: number;
	readonly updatedAt: string;
}

interface MarketplacePolicyResponse {
	readonly policy: MarketplacePolicy;
}

interface MarketplaceProxyState {
	baseUrl: string;
	enabled: boolean;
	names: Set<string>;
	signature: string;
	context: {
		readonly harness?: string;
		readonly workspace?: string;
		readonly channel?: string;
	};
	policy: MarketplacePolicy;
	contextKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DaemonResponse<T> {
	readonly ok: true;
	readonly data: T;
}

interface DaemonError {
	readonly ok: false;
	readonly error: string;
	readonly status: number;
}

type FetchResult<T> = DaemonResponse<T> | DaemonError;

const BASE_TOOL_NAMES = new Set<string>([
	"memory_search",
	"memory_store",
	"memory_get",
	"memory_list",
	"memory_modify",
	"memory_forget",
	"memory_feedback",
	"knowledge_expand",
	"knowledge_tree",
	"knowledge_list_entities",
	"knowledge_get_entity",
	"knowledge_list_aspects",
	"knowledge_list_groups",
	"knowledge_list_claims",
	"knowledge_list_attributes",
	"knowledge_hygiene_report",
	"entity_list",
	"entity_get",
	"entity_aspects",
	"entity_groups",
	"entity_claims",
	"entity_attributes",
	"knowledge_expand_session",
	"lcm_expand",
	"agent_peers",
	"agent_message_send",
	"agent_message_inbox",
	"secret_list",
	"secret_exec",
	"mcp_server_list",
	"mcp_server_call",
	"mcp_server_search",
	"mcp_server_enable",
	"mcp_server_disable",
	"mcp_server_scope_get",
	"mcp_server_scope_set",
	"mcp_server_policy_get",
	"mcp_server_policy_set",
	"session_bypass",
	"code_search",
	"code_context",
	"code_blast",
	"code_status",
	"code_doctor",
	"code_constants",
]);

const marketplaceProxyState = new WeakMap<McpServer, MarketplaceProxyState>();
const hotToolIdsByContext = new Map<string, Set<string>>();
const hotToolTouchedAt = new Map<string, number>();
const HOT_CONTEXT_TTL_MS = 30 * 60 * 1000;
const GRAPHIQ_SEARCH_TOP_DEFAULT = 10;
const GRAPHIQ_SEARCH_TOP_MAX = 100;
const GRAPHIQ_CONSTANTS_TOP_DEFAULT = 20;
const GRAPHIQ_CONSTANTS_TOP_MAX = 100;
const GRAPHIQ_BLAST_DEPTH_DEFAULT = 3;
const GRAPHIQ_BLAST_DEPTH_MAX = 10;
const GRAPHIQ_MCP_TOOL_NAMES = new Set([
	"code_search",
	"code_context",
	"code_blast",
	"code_status",
	"code_doctor",
	"code_constants",
]);

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

async function daemonFetch<T>(
	baseUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
		readonly extraHeaders?: Readonly<Record<string, string>>;
	} = {},
): Promise<FetchResult<T>> {
	const { method = "GET", body, timeout = 10_000, extraHeaders } = options;

	const init: RequestInit = {
		method,
		headers: {
			"Content-Type": "application/json",
			"x-signet-runtime-path": "plugin",
			"x-signet-actor": "mcp-server",
			"x-signet-actor-type": "harness",
			...extraHeaders,
		},
		signal: AbortSignal.timeout(timeout),
	};

	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}

	try {
		const res = await fetch(`${baseUrl}${path}`, init);
		if (!res.ok) {
			const text = await res.text().catch(() => "unknown error");
			return { ok: false, error: text, status: res.status };
		}
		const data = (await res.json()) as T;
		return { ok: true, data };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg, status: 0 };
	}
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [
			{
				type: "text" as const,
				text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
			},
		],
	};
}

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.trunc(value);
	if (rounded < 1) return 1;
	if (rounded > max) return max;
	return rounded;
}

function graphIqPositionalArg(
	value: string,
	label: string,
): { ok: true; value: string } | { ok: false; error: string } {
	if (value.trim().length === 0) {
		return { ok: false, error: `GraphIQ ${label} is required.` };
	}
	if (value.trimStart().startsWith("-")) {
		return { ok: false, error: `GraphIQ ${label} cannot start with '-' because it would be parsed as a CLI option.` };
	}
	return { ok: true, value };
}

function errorResult(msg: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true as const,
	};
}

async function graphIqToolResult(
	args: readonly string[],
	label: string,
	toolName: string,
	pluginHostProvider: GraphiqPluginPolicyHostProvider,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const access = graphIqToolAccess(toolName, pluginHostProvider());
	if (!access.ok) return errorResult(access.error);
	try {
		const result = await runGraphiqCli(args);
		const stderr = result.stderr.trim();
		const output = result.stdout.trim();
		const parts = [`Active project: ${result.activeProject}`];
		if (output) parts.push(output);
		if (stderr) parts.push(`stderr:\n${stderr}`);
		return textResult(parts.join("\n\n"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return errorResult(`${label}: ${message}`);
	}
}

function graphIqToolAccess(
	toolName: string,
	pluginHost: GraphiqPluginPolicyHost,
): { ok: true } | { ok: false; error: string } {
	const plugin = pluginHost.get(SIGNET_GRAPHIQ_PLUGIN_ID);
	const pluginActive = plugin?.state === "active" || plugin?.state === "degraded";
	if (!pluginActive) {
		const state = plugin?.state ?? "not registered";
		return { ok: false, error: `GraphIQ plugin is ${state}. Run \`signet index <path>\` after enabling GraphIQ.` };
	}
	if (!allowedGraphiqMcpTools(pluginHost).has(toolName)) {
		return { ok: false, error: `GraphIQ plugin has not granted MCP tool access for ${toolName}.` };
	}
	if (!getActiveGraphiqDbPath()) {
		return { ok: false, error: "GraphIQ has no active indexed project. Run `signet index <path>` first." };
	}
	return { ok: true };
}

function allowedGraphiqMcpTools(pluginHost: GraphiqPluginPolicyHost): ReadonlySet<string> {
	const plugin = pluginHost.get(SIGNET_GRAPHIQ_PLUGIN_ID);
	const active = plugin?.state === "active" || plugin?.state === "degraded";
	if (!active) return new Set();
	return new Set(plugin.surfaces.mcpTools.map((tool) => tool.name).filter((name) => GRAPHIQ_MCP_TOOL_NAMES.has(name)));
}

function sanitizeToolSegment(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized : "tool";
}

function buildProxyToolName(used: Set<string>, serverId: string, toolName: string): string {
	const base = `signet_${sanitizeToolSegment(serverId)}_${sanitizeToolSegment(toolName)}`;
	if (!used.has(base)) {
		used.add(base);
		return base;
	}

	let suffix = 2;
	while (used.has(`${base}_${suffix}`)) {
		suffix += 1;
	}
	const uniqueName = `${base}_${suffix}`;
	used.add(uniqueName);
	return uniqueName;
}

function getRegisteredToolsMap(server: McpServer): Record<string, unknown> | null {
	const internal = server as unknown as {
		_registeredTools?: Record<string, unknown>;
	};
	return internal._registeredTools ?? null;
}

function buildToolsSignature(tools: ReadonlyArray<MarketplaceRoutedTool>): string {
	return tools
		.map((tool) => `${tool.serverId}:${tool.toolName}:${tool.readOnly ? "ro" : "rw"}`)
		.sort()
		.join("|");
}

function normalizeContextValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeContext(context: McpServerOptions["context"]): {
	harness?: string;
	workspace?: string;
	channel?: string;
} {
	return {
		harness: normalizeContextValue(context?.harness),
		workspace: normalizeContextValue(context?.workspace),
		channel: normalizeContextValue(context?.channel),
	};
}

function buildContextKey(context: { harness?: string; workspace?: string; channel?: string }): string {
	return `${context.harness ?? "*"}|${context.workspace ?? "*"}|${context.channel ?? "*"}`;
}

function appendMarketplaceContext(
	path: string,
	context: { harness?: string; workspace?: string; channel?: string },
): string {
	const params = new URLSearchParams();
	if (context.harness) params.set("harness", context.harness);
	if (context.workspace) params.set("workspace", context.workspace);
	if (context.channel) params.set("channel", context.channel);

	if (params.size === 0) {
		return path;
	}
	const separator = path.includes("?") ? "&" : "?";
	return `${path}${separator}${params.toString()}`;
}

function cleanupHotContextCache(): void {
	const now = Date.now();
	for (const [key, touchedAt] of hotToolTouchedAt.entries()) {
		if (now - touchedAt <= HOT_CONTEXT_TTL_MS) continue;
		hotToolTouchedAt.delete(key);
		hotToolIdsByContext.delete(key);
	}
}

function getHotToolSet(contextKey: string): Set<string> {
	cleanupHotContextCache();
	const existing = hotToolIdsByContext.get(contextKey);
	if (existing) {
		hotToolTouchedAt.set(contextKey, Date.now());
		return existing;
	}
	const created = new Set<string>();
	hotToolIdsByContext.set(contextKey, created);
	hotToolTouchedAt.set(contextKey, Date.now());
	return created;
}

function trimHotToolSet(hotSet: Set<string>, max = 500): void {
	if (hotSet.size <= max) return;
	for (const value of hotSet) {
		hotSet.delete(value);
		if (hotSet.size <= max) break;
	}
}

function selectToolsByPolicy(
	tools: readonly MarketplaceRoutedTool[],
	state: MarketplaceProxyState,
): MarketplaceRoutedTool[] {
	if (state.policy.mode === "expanded") {
		return [...tools];
	}

	const hot = getHotToolSet(state.contextKey);
	const ordered = [...tools].sort((a, b) => `${a.serverId}:${a.toolName}`.localeCompare(`${b.serverId}:${b.toolName}`));
	const hotFirst = ordered.filter((tool) => hot.has(tool.id));

	if (state.policy.mode === "compact") {
		return hotFirst.slice(0, state.policy.maxSearchResults);
	}

	const max = Math.max(0, state.policy.maxExpandedTools);
	if (max === 0) {
		return [];
	}

	const selected: MarketplaceRoutedTool[] = [];
	const seen = new Set<string>();
	for (const tool of hotFirst) {
		if (seen.has(tool.id)) continue;
		selected.push(tool);
		seen.add(tool.id);
		if (selected.length >= max) {
			return selected;
		}
	}

	for (const tool of ordered) {
		if (seen.has(tool.id)) continue;
		selected.push(tool);
		seen.add(tool.id);
		if (selected.length >= max) {
			break;
		}
	}

	return selected;
}

async function fetchMarketplacePolicy(baseUrl: string): Promise<MarketplacePolicy | null> {
	const result = await daemonFetch<MarketplacePolicyResponse>(baseUrl, "/api/marketplace/mcp/policy", {
		timeout: 3_000,
	});
	if (!result.ok) {
		return null;
	}
	return result.data.policy;
}

export async function refreshMarketplaceProxyTools(
	server: McpServer,
	options?: {
		readonly notify?: boolean;
	},
): Promise<{ changed: boolean; count: number; error?: string }> {
	const state = marketplaceProxyState.get(server);
	if (!state || !state.enabled) {
		return { changed: false, count: 0 };
	}

	const notify = options?.notify ?? true;
	const registeredTools = getRegisteredToolsMap(server);
	const policy = await fetchMarketplacePolicy(state.baseUrl);
	if (policy) {
		state.policy = policy;
	}

	const routed = await daemonFetch<MarketplaceToolsResponse>(
		state.baseUrl,
		appendMarketplaceContext("/api/marketplace/mcp/tools?refresh=1", state.context),
		{
			timeout: 3_000,
		},
	);

	if (!routed.ok) {
		return { changed: false, count: state.names.size, error: routed.error };
	}

	const tools = selectToolsByPolicy(routed.data.tools, state);
	const signature = buildToolsSignature(tools);
	if (signature === state.signature) {
		return { changed: false, count: tools.length };
	}

	if (registeredTools) {
		for (const name of state.names) {
			delete registeredTools[name];
		}
	}

	const usedNames = new Set<string>(BASE_TOOL_NAMES);
	if (registeredTools) {
		for (const name of Object.keys(registeredTools)) {
			usedNames.add(name);
		}
	}

	const nextNames = new Set<string>();

	for (const tool of tools) {
		if (!tool.serverId || !tool.toolName) {
			continue;
		}

		const proxyName = buildProxyToolName(usedNames, tool.serverId, tool.toolName);
		const title = `Signet • ${tool.serverName} • ${tool.toolName}`;
		const description =
			tool.description && tool.description.trim().length > 0
				? tool.description
				: `Proxy tool ${tool.toolName} from MCP server ${tool.serverName}`;

		nextNames.add(proxyName);

		server.registerTool(
			proxyName,
			{
				title,
				description,
				inputSchema: z.object({}).passthrough(),
				annotations: { readOnlyHint: tool.readOnly },
			},
			async (args) => {
				const callResult = await daemonFetch<{
					success: boolean;
					result?: unknown;
					error?: string;
				}>(state.baseUrl, appendMarketplaceContext("/api/marketplace/mcp/call", state.context), {
					method: "POST",
					body: {
						serverId: tool.serverId,
						toolName: tool.toolName,
						args,
					},
					timeout: 60_000,
				});

				if (!callResult.ok) {
					return errorResult(`Tool server call failed: ${callResult.error}`);
				}

				if (!callResult.data.success) {
					return errorResult(`Tool server call failed: ${callResult.data.error ?? "unknown error"}`);
				}

				return textResult(callResult.data.result ?? { success: true });
			},
		);
	}

	state.names = nextNames;
	state.signature = signature;

	if (notify) {
		try {
			server.sendToolListChanged();
		} catch {
			// ignore notification errors for transports that do not support it yet
		}
	}

	return { changed: true, count: routed.data.tools.length };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createMcpServer(opts?: McpServerOptions): Promise<McpServer> {
	const baseUrl = opts?.daemonUrl ?? "http://localhost:3850";
	const version = opts?.version ?? "0.1.0";
	const enableMarketplaceProxyTools = opts?.enableMarketplaceProxyTools ?? true;
	const context = normalizeContext(opts?.context);
	const contextKey = buildContextKey(context);
	const pluginHostProvider: GraphiqPluginPolicyHostProvider = opts?.pluginHost
		? () => opts.pluginHost as GraphiqPluginPolicyHost
		: () => createDefaultPluginHost({ persistRegistry: false });

	const server = new McpServer({
		name: "signet",
		version,
	});

	marketplaceProxyState.set(server, {
		baseUrl,
		enabled: enableMarketplaceProxyTools,
		names: new Set<string>(),
		signature: "",
		context,
		contextKey,
		policy: {
			mode: "hybrid",
			maxExpandedTools: 12,
			maxSearchResults: 8,
			// Sentinel: "never explicitly set" — matches DEFAULT_EXPOSURE_POLICY.
			updatedAt: "1970-01-01T00:00:00.000Z",
		},
	});

	// ------------------------------------------------------------------
	// memory_search — hybrid vector + keyword search
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_search",
		{
			title: "Search Memories",
			description: "Search memories using hybrid vector + keyword search",
			inputSchema: z.object({
				query: z.string().describe("Search query text"),
				limit: z.number().optional().describe("Max results to return (default 10)"),
				project: z.string().optional().describe("Optional project path filter"),
				expand: z.boolean().optional().describe("Include lossless session transcripts as sources"),
				type: z.string().optional().describe("Filter by memory type"),
				tags: z.string().optional().describe("Filter by tags (comma-separated)"),
				who: z.string().optional().describe("Filter by author"),
				since: z.string().optional().describe("Only include memories created after this date"),
				until: z.string().optional().describe("Only include memories created before this date"),
				keyword_query: z.string().optional().describe("Override the keyword/FTS query used for recall"),
				pinned: z.boolean().optional().describe("Only return pinned memories"),
				importance_min: z.number().optional().describe("Minimum memory importance threshold"),
				min_score: z
					.number()
					.optional()
					.describe("Deprecated compatibility alias for importance_min; ignored when importance_min is also set"),
				score_min: z.number().optional().describe("Minimum recall score threshold (client-side)"),
			}),
		},
		async ({
			query,
			keyword_query,
			limit,
			project,
			type,
			tags,
			who,
			pinned,
			importance_min,
			since,
			until,
			min_score,
			score_min,
			expand,
		}) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/memory/recall", {
				method: "POST",
				body: buildRecallRequestBody(query, {
					keyword_query,
					limit: limit ?? 10,
					project,
					type,
					tags,
					who,
					pinned,
					importance_min: importance_min ?? min_score,
					since,
					until,
					expand,
				}),
			});

			if (!result.ok) {
				return errorResult(`Search failed: ${result.error}`);
			}
			// Score thresholds trim ranked matches, but intentionally keep
			// unscored supporting context in-band.
			return textResult(formatRecallText(applyRecallScoreThreshold(result.data, score_min)));
		},
	);

	// ------------------------------------------------------------------
	// memory_store — save a new memory
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_store",
		{
			title: "Store Memory",
			description: "Save a new memory",
			inputSchema: z.object({
				content: z.string().describe("Memory content to save"),
				type: z.string().optional().describe("Memory type (fact, preference, decision, etc.)"),
				importance: z.number().optional().describe("Importance score 0-1"),
				tags: z.string().optional().describe("Comma-separated tags for categorization"),
				pinned: z.boolean().optional().describe("Pin this memory — prevents decay, bypasses 0.95^days aging"),
				hints: z
					.array(z.string())
					.optional()
					.describe("Prospective recall hints and alternate phrasings for retrieving this memory later"),
				createdAt: z
					.string()
					.optional()
					.describe("Source ISO timestamp for imported/older memories; used for currentness and supersession."),
				transcript: z
					.string()
					.optional()
					.describe("Raw source text (conversation transcript) to preserve alongside extracted memory"),
				structured: z
					.object({
						entities: z
							.array(
								z.object({
									source: z.string(),
									sourceType: z.string().optional(),
									relationship: z.string(),
									target: z.string(),
									targetType: z.string().optional(),
									confidence: z.number().optional(),
								}),
							)
							.optional(),
						aspects: z
							.array(
								z.union([
									z.object({
										entityName: z.string(),
										entityType: z.string().optional(),
										aspect: z.string(),
										attributes: z.array(
											z.object({
												groupKey: z
													.string()
													.optional()
													.describe("Navigable subgroup within the aspect, like a dresser inside a room."),
												claimKey: z
													.string()
													.optional()
													.describe(
														"Stable identity for this claim within the entity/aspect/group, used for supersession.",
													),
												content: z.string(),
												confidence: z.number().optional(),
												importance: z.number().optional(),
											}),
										),
									}),
									z.object({
										entity: z.string(),
										aspect: z.string(),
										value: z.string(),
										groupKey: z.string().optional(),
										claimKey: z.string().optional(),
										confidence: z.number().optional(),
										importance: z.number().optional(),
									}),
								]),
							)
							.optional(),
						hints: z.array(z.string()).optional(),
					})
					.optional()
					.describe(
						"Pre-extracted structured data: entities, entity aspects with attributes, and hints. Skips pipeline extraction when provided.",
					),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ content, type, importance, tags, hints, transcript, structured, pinned, createdAt }) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/memory/remember", {
				method: "POST",
				body: buildRememberRequestBody(content, {
					type,
					importance,
					tags,
					hints,
					transcript,
					structured,
					pinned,
					createdAt,
				}),
			});

			if (!result.ok) {
				return errorResult(`Store failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_get — retrieve a memory by ID
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_get",
		{
			title: "Get Memory",
			description: "Get a single memory by its ID",
			inputSchema: z.object({
				id: z.string().describe("Memory ID to retrieve"),
			}),
		},
		async ({ id }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`);

			if (!result.ok) {
				return errorResult(`Get failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_list — list memories with optional filters
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_list",
		{
			title: "List Memories",
			description: "List memories with optional filters",
			inputSchema: z.object({
				limit: z.number().optional().describe("Max results (default 100)"),
				offset: z.number().optional().describe("Pagination offset"),
				type: z.string().optional().describe("Filter by memory type"),
			}),
		},
		async ({ limit, offset, type }) => {
			const params = new URLSearchParams();
			if (limit !== undefined) params.set("limit", String(limit));
			if (offset !== undefined) params.set("offset", String(offset));
			if (type !== undefined) params.set("type", type);

			const qs = params.toString();
			const path = `/api/memories${qs ? `?${qs}` : ""}`;
			const result = await daemonFetch<unknown>(baseUrl, path);

			if (!result.ok) {
				return errorResult(`List failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_modify — edit an existing memory
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_modify",
		{
			title: "Modify Memory",
			description: "Edit an existing memory by ID",
			inputSchema: z.object({
				id: z.string().describe("Memory ID to modify"),
				content: z.string().optional().describe("New content"),
				type: z.string().optional().describe("New type"),
				importance: z.number().optional().describe("New importance"),
				tags: z.string().optional().describe("New tags (comma-separated)"),
				pinned: z.boolean().optional().describe("Pin or unpin this memory"),
				reason: z.string().describe("Why this edit is being made"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ id, content, type, importance, tags, reason, pinned }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: {
					content,
					type,
					importance,
					tags,
					reason,
					pinned,
				},
			});

			if (!result.ok) {
				return errorResult(`Modify failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_forget — soft-delete a memory
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_forget",
		{
			title: "Forget Memory",
			description: "Soft-delete a memory by ID",
			inputSchema: z.object({
				id: z.string().describe("Memory ID to forget"),
				reason: z.string().describe("Why this memory should be forgotten"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ id, reason }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`, {
				method: "DELETE",
				body: { reason },
			});

			if (!result.ok) {
				return errorResult(`Forget failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// memory_feedback — rate relevance of injected memories
	// ------------------------------------------------------------------
	server.registerTool(
		"memory_feedback",
		{
			title: "Rate Memory Relevance",
			description:
				"Rate how relevant injected memories were to the conversation. " +
				"Scores from -1 (harmful) to 1 (directly helpful). 0 = unused.",
			inputSchema: z.object({
				session_key: z.string().describe("Current session key"),
				agent_id: z.string().optional().describe("Agent id scope (default: default)"),
				ratings: z.object({}).catchall(z.number()).describe("Map of memory ID to relevance score (-1 to 1)"),
				paths: z
					.object({})
					.catchall(
						z.object({
							entity_ids: z.array(z.string()).optional(),
							aspect_ids: z.array(z.string()).optional(),
							dependency_ids: z.array(z.string()).optional(),
						}),
					)
					.optional()
					.describe("Optional path provenance keyed by memory id"),
				rewards: z
					.object({})
					.catchall(
						z.object({
							forward_citation: z.number().optional(),
							update_after_retrieval: z.number().optional(),
							downstream_creation: z.number().optional(),
							dead_end: z.number().optional(),
						}),
					)
					.optional()
					.describe("Optional reward signals keyed by memory id"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ session_key, agent_id, ratings, paths, rewards }) => {
			const result = await daemonFetch<{ ok: boolean; recorded: number }>(baseUrl, "/api/memory/feedback", {
				method: "POST",
				body: {
					sessionKey: session_key,
					agentId: agent_id,
					feedback: ratings,
					paths,
					rewards,
				},
			});
			if (!result.ok) {
				return errorResult(`Feedback failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// agent_peers — list active peer sessions
	// ------------------------------------------------------------------
	server.registerTool(
		"agent_peers",
		{
			title: "List Peer Sessions",
			description:
				"List currently active Signet peer agent sessions. " +
				"Pass include_self: true to include sessions from the same agent (same agentId).",
			inputSchema: z.object({
				agent_id: z.string().optional().describe("Current agent id (default: default)"),
				session_key: z.string().optional().describe("Current session key (excluded from peers)"),
				include_self: z.boolean().optional().describe("Include sessions owned by the current agent (default false)"),
				project: z.string().optional().describe("Optional project path filter"),
				limit: z.number().optional().describe("Max sessions to return"),
			}),
		},
		async ({ agent_id, session_key, include_self, project, limit }) => {
			const params = new URLSearchParams();
			params.set("agent_id", agent_id ?? "default");
			if (session_key) params.set("session_key", session_key);
			params.set("include_self", String(include_self ?? false));
			if (project) params.set("project", project);
			if (typeof limit === "number" && Number.isFinite(limit)) {
				params.set("limit", String(Math.max(1, Math.min(200, Math.round(limit)))));
			}

			const result = await daemonFetch<unknown>(baseUrl, `/api/cross-agent/presence?${params.toString()}`);

			if (!result.ok) {
				return errorResult(`Peer list failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// agent_message_send — send message to another agent/session
	// ------------------------------------------------------------------
	server.registerTool(
		"agent_message_send",
		{
			title: "Send Agent Message",
			description:
				"Send a structured message to another Signet agent session. " +
				"Supports local daemon delivery or ACP relay for cross-provider communication.",
			inputSchema: z.object({
				from_agent_id: z.string().optional().describe("Sender agent id"),
				from_session_key: z.string().optional().describe("Sender session key"),
				to_agent_id: z.string().optional().describe("Target agent id"),
				to_session_key: z.string().optional().describe("Target session key"),
				broadcast: z.boolean().optional().describe("Broadcast to all active sessions"),
				type: z.enum(["assist_request", "decision_update", "info", "question"]).optional().describe("Message type"),
				content: z.string().describe("Message content"),
				via: z.enum(["local", "acp"]).optional().describe("Delivery path (default: local)"),
				acp_base_url: z.string().optional().describe("ACP server base URL (required when via='acp')"),
				acp_target_agent_name: z.string().optional().describe("ACP target agent name (required when via='acp')"),
				acp_timeout_ms: z.number().optional().describe("ACP request timeout"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({
			from_agent_id,
			from_session_key,
			to_agent_id,
			to_session_key,
			broadcast,
			type,
			content,
			via,
			acp_base_url,
			acp_target_agent_name,
			acp_timeout_ms,
		}) => {
			const body: Record<string, unknown> = {
				fromAgentId: from_agent_id,
				fromSessionKey: from_session_key,
				toAgentId: to_agent_id,
				toSessionKey: to_session_key,
				broadcast: broadcast ?? false,
				type,
				content,
				via: via ?? "local",
			};

			if ((via ?? "local") === "acp") {
				body.acp = {
					baseUrl: acp_base_url,
					targetAgentName: acp_target_agent_name,
					timeoutMs: acp_timeout_ms,
				};
			}

			const result = await daemonFetch<unknown>(baseUrl, "/api/cross-agent/messages", {
				method: "POST",
				body,
			});

			if (!result.ok) {
				return errorResult(`Send failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// agent_message_inbox — read recent inbound messages
	// ------------------------------------------------------------------
	server.registerTool(
		"agent_message_inbox",
		{
			title: "Read Agent Inbox",
			description: "Read recent cross-agent messages for the current or specified agent.",
			inputSchema: z.object({
				agent_id: z.string().optional().describe("Recipient agent id (default: default)"),
				session_key: z.string().optional().describe("Recipient session key"),
				since: z.string().optional().describe("ISO timestamp filter"),
				limit: z.number().optional().describe("Max messages to return"),
				include_sent: z.boolean().optional().describe("Include messages sent by this agent"),
				include_broadcast: z.boolean().optional().describe("Include broadcast messages"),
			}),
		},
		async ({ agent_id, session_key, since, limit, include_sent, include_broadcast }) => {
			const params = new URLSearchParams();
			params.set("agent_id", agent_id ?? "default");
			if (session_key) params.set("session_key", session_key);
			if (since) params.set("since", since);
			if (typeof limit === "number" && Number.isFinite(limit)) {
				params.set("limit", String(Math.max(1, Math.min(500, Math.round(limit)))));
			}
			if (typeof include_sent === "boolean") {
				params.set("include_sent", String(include_sent));
			}
			if (typeof include_broadcast === "boolean") {
				params.set("include_broadcast", String(include_broadcast));
			}

			const result = await daemonFetch<unknown>(baseUrl, `/api/cross-agent/messages?${params.toString()}`);

			if (!result.ok) {
				return errorResult(`Inbox read failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// secret_list — list available secret names
	// ------------------------------------------------------------------
	server.registerTool(
		"secret_list",
		{
			title: "List Secrets",
			description: "List available secret names. Returns names only — raw values are never exposed to agents.",
			inputSchema: z.object({}),
		},
		async () => {
			const result = await daemonFetch<{ secrets: ReadonlyArray<string> }>(baseUrl, "/api/secrets");

			if (!result.ok) {
				return errorResult(`Failed to list secrets: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// secret_exec — run a command with secrets injected as env vars
	// ------------------------------------------------------------------
	server.registerTool(
		"secret_exec",
		{
			title: "Execute with Secrets",
			description:
				"Run a shell command with secrets injected as environment variables. " +
				"Provide a secrets map where keys are env var names and values are Signet secret names or 1Password references (op://vault/item/field). " +
				"Output is automatically redacted — secret values never appear in results.",
			inputSchema: z.object({
				command: z.string().describe("Shell command to execute"),
				secrets: z
					.object({})
					.catchall(z.string())
					.describe(
						'Map of env var name → secret ref, e.g. { "OPENAI_API_KEY": "OPENAI_API_KEY" } or { "DB_PASSWORD": "op://vault/item/password" }',
					),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ command, secrets }) => {
			if (Object.keys(secrets).length === 0) {
				return errorResult("secrets map must contain at least one entry");
			}

			const result = await daemonFetch<{
				stdout: string;
				stderr: string;
				code: number;
			}>(baseUrl, "/api/secrets/exec", {
				method: "POST",
				body: { command, secrets },
				timeout: 30_000,
			});

			if (!result.ok) {
				return errorResult(`Exec failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// mcp_server_list — list routed marketplace MCP tools
	// ------------------------------------------------------------------
	const proxyState = marketplaceProxyState.get(server);
	if (!proxyState) {
		throw new Error("marketplace proxy state not initialized");
	}

	const contextPath = (path: string): string => appendMarketplaceContext(path, proxyState.context);

	server.registerTool(
		"mcp_server_list",
		{
			title: "List Tool Servers",
			description: "List installed external Tool Servers (MCP) and discover their routed tools.",
			inputSchema: z.object({
				refresh: z.boolean().optional().describe("Bypass cache and refresh live tool catalogs"),
			}),
		},
		async ({ refresh }) => {
			if (refresh && enableMarketplaceProxyTools) {
				await refreshMarketplaceProxyTools(server, { notify: true });
			}

			const path = refresh ? "/api/marketplace/mcp/tools?refresh=1" : "/api/marketplace/mcp/tools";
			const result = await daemonFetch<{
				count: number;
				tools: unknown[];
				servers: unknown[];
				policy?: MarketplacePolicy;
			}>(baseUrl, contextPath(path));

			if (!result.ok) {
				return errorResult(`Tool server list failed: ${result.error}`);
			}

			return textResult(result.data);
		},
	);

	server.registerTool(
		"mcp_server_search",
		{
			title: "Search Tool Servers",
			description:
				"Search routed MCP tools with lightweight matching and optionally promote matches into first-class tools.",
			inputSchema: z.object({
				query: z.string().min(2).describe("Search query text"),
				limit: z.number().optional().describe("Max results to return"),
				refresh: z.boolean().optional().describe("Refresh tool catalog before searching"),
				promote: z
					.boolean()
					.optional()
					.describe("Promote matches into expanded tool list (default true)")
					.default(true),
			}),
		},
		async ({ query, limit, refresh, promote }) => {
			const searchPath = new URLSearchParams();
			searchPath.set("q", query);
			if (typeof limit === "number" && Number.isFinite(limit)) {
				searchPath.set("limit", String(Math.max(1, Math.min(50, Math.round(limit)))));
			}
			if (refresh) {
				searchPath.set("refresh", "1");
			}

			const result = await daemonFetch<MarketplaceSearchResponse>(
				baseUrl,
				contextPath(`/api/marketplace/mcp/search?${searchPath.toString()}`),
			);

			if (!result.ok) {
				return errorResult(`Tool server search failed: ${result.error}`);
			}

			const shouldPromote = promote !== false;
			if (shouldPromote && enableMarketplaceProxyTools) {
				const hotSet = getHotToolSet(proxyState.contextKey);
				for (const tool of result.data.results) {
					hotSet.add(tool.id);
				}
				trimHotToolSet(hotSet);
				hotToolTouchedAt.set(proxyState.contextKey, Date.now());
				await refreshMarketplaceProxyTools(server, { notify: true });
			}

			return textResult({
				query: result.data.query,
				count: result.data.count,
				results: result.data.results,
				promoted: shouldPromote,
				mode: proxyState.policy.mode,
				maxExpandedTools: proxyState.policy.maxExpandedTools,
			});
		},
	);

	server.registerTool(
		"mcp_server_enable",
		{
			title: "Enable Tool Server",
			description: "Enable an installed MCP server for the current scope context.",
			inputSchema: z.object({
				server_id: z.string().describe("Installed Tool Server id"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ server_id }) => {
			const result = await daemonFetch<{ success: boolean; server?: unknown; error?: string }>(
				baseUrl,
				contextPath(`/api/marketplace/mcp/${encodeURIComponent(server_id)}`),
				{
					method: "PATCH",
					body: { enabled: true },
				},
			);

			if (!result.ok) {
				return errorResult(`Enable failed: ${result.error}`);
			}
			if (enableMarketplaceProxyTools) {
				await refreshMarketplaceProxyTools(server, { notify: true });
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"mcp_server_disable",
		{
			title: "Disable Tool Server",
			description: "Disable an installed MCP server for the current scope context.",
			inputSchema: z.object({
				server_id: z.string().describe("Installed Tool Server id"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ server_id }) => {
			const result = await daemonFetch<{ success: boolean; server?: unknown; error?: string }>(
				baseUrl,
				contextPath(`/api/marketplace/mcp/${encodeURIComponent(server_id)}`),
				{
					method: "PATCH",
					body: { enabled: false },
				},
			);

			if (!result.ok) {
				return errorResult(`Disable failed: ${result.error}`);
			}
			if (enableMarketplaceProxyTools) {
				await refreshMarketplaceProxyTools(server, { notify: true });
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"mcp_server_scope_get",
		{
			title: "Get Tool Server Scope",
			description: "Inspect scope rules for one server or all installed servers.",
			inputSchema: z.object({
				server_id: z.string().optional().describe("Optional server id"),
			}),
		},
		async ({ server_id }) => {
			if (server_id) {
				const result = await daemonFetch<{ server: MarketplaceServerRecord }>(
					baseUrl,
					contextPath(`/api/marketplace/mcp/${encodeURIComponent(server_id)}`),
				);
				if (!result.ok) {
					return errorResult(`Scope get failed: ${result.error}`);
				}
				return textResult(result.data);
			}

			const result = await daemonFetch<MarketplaceServersResponse>(
				baseUrl,
				contextPath("/api/marketplace/mcp?scoped=0"),
			);
			if (!result.ok) {
				return errorResult(`Scope list failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"mcp_server_scope_set",
		{
			title: "Set Tool Server Scope",
			description: "Set harness/workspace/channel scope for an installed MCP server.",
			inputSchema: z.object({
				server_id: z.string().describe("Installed Tool Server id"),
				harnesses: z.array(z.string()).optional().describe("Allowed harness names"),
				workspaces: z.array(z.string()).optional().describe("Allowed workspace paths"),
				channels: z.array(z.string()).optional().describe("Allowed channel ids"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ server_id, harnesses, workspaces, channels }) => {
			const result = await daemonFetch<{ success: boolean; server?: unknown; error?: string }>(
				baseUrl,
				contextPath(`/api/marketplace/mcp/${encodeURIComponent(server_id)}`),
				{
					method: "PATCH",
					body: {
						scope: {
							harnesses: harnesses ?? [],
							workspaces: workspaces ?? [],
							channels: channels ?? [],
						},
					},
				},
			);
			if (!result.ok) {
				return errorResult(`Scope set failed: ${result.error}`);
			}
			if (enableMarketplaceProxyTools) {
				await refreshMarketplaceProxyTools(server, { notify: true });
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"mcp_server_policy_get",
		{
			title: "Get MCP Exposure Policy",
			description: "Get compact/hybrid/expanded exposure policy for dynamic tool expansion.",
			inputSchema: z.object({}),
		},
		async () => {
			const result = await daemonFetch<MarketplacePolicyResponse>(baseUrl, "/api/marketplace/mcp/policy");
			if (!result.ok) {
				return errorResult(`Policy get failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"mcp_server_policy_set",
		{
			title: "Set MCP Exposure Policy",
			description: "Update compact/hybrid/expanded policy and expansion limits.",
			inputSchema: z.object({
				mode: z.enum(["compact", "hybrid", "expanded"]).optional(),
				max_expanded_tools: z.number().optional(),
				max_search_results: z.number().optional(),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ mode, max_expanded_tools, max_search_results }) => {
			const result = await daemonFetch<{ success: boolean; policy?: MarketplacePolicy; error?: string }>(
				baseUrl,
				"/api/marketplace/mcp/policy",
				{
					method: "PATCH",
					body: {
						mode,
						maxExpandedTools: max_expanded_tools,
						maxSearchResults: max_search_results,
					},
				},
			);
			if (!result.ok) {
				return errorResult(`Policy set failed: ${result.error}`);
			}
			if (enableMarketplaceProxyTools) {
				await refreshMarketplaceProxyTools(server, { notify: true });
			}
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// mcp_server_call — call a routed marketplace MCP tool
	// ------------------------------------------------------------------
	server.registerTool(
		"mcp_server_call",
		{
			title: "Call Tool Server",
			description:
				"Invoke a routed tool from an installed external Tool Server (MCP). " +
				"Use mcp_server_list first to discover server_id and tool names.",
			inputSchema: z.object({
				server_id: z.string().describe("Installed Tool Server id"),
				tool: z.string().describe("Tool name exposed by that server"),
				args: z.object({}).catchall(z.unknown()).optional().describe("Tool argument object"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ server_id, tool, args }) => {
			const result = await daemonFetch<{
				success: boolean;
				result?: unknown;
				error?: string;
			}>(baseUrl, contextPath("/api/marketplace/mcp/call"), {
				method: "POST",
				body: {
					serverId: server_id,
					toolName: tool,
					args: args ?? {},
				},
				timeout: 60_000,
				// x-signet-agent-id intentionally omitted — the MCP server is
				// workspace-level and lacks per-agent context. The marketplace
				// route derives agent_id from auth claims (Phase 2: per-agent MCP sessions).
				extraHeaders: { "x-signet-mcp-source": "agent" },
			});

			if (!result.ok) {
				return errorResult(`Tool server call failed: ${result.error}`);
			}

			if (!result.data.success) {
				return errorResult(`Tool server call failed: ${result.data.error ?? "unknown error"}`);
			}

			return textResult(result.data.result ?? { success: true });
		},
	);

	server.registerTool(
		"session_bypass",
		{
			title: "Toggle Session Bypass",
			description:
				"Disable or re-enable Signet memory for the current session. " +
				"When bypassed, all hooks return empty responses — no automatic " +
				"memory injection, extraction, or recall. MCP tools like " +
				"memory_search still work. Other sessions are unaffected.",
			inputSchema: z.object({
				session_key: z.string().describe("Session key to bypass"),
				enabled: z.boolean().describe("true = bypass (disable hooks), false = re-enable"),
				agent_id: z.string().optional().describe("Agent owning the session (defaults to current agent)"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ session_key, enabled, agent_id }) => {
			// Always thread agent_id so the scoped route resolves correctly.
			// Default to "default" matching other cross-agent MCP tools.
			const aid = agent_id ?? "default";
			const result = await daemonFetch<{ key: string; bypassed: boolean }>(
				baseUrl,
				`/api/sessions/${encodeURIComponent(session_key)}/bypass?agent_id=${encodeURIComponent(aid)}`,
				{ method: "POST", body: { enabled } },
			);
			if (!result.ok) return errorResult(`Bypass toggle failed: ${result.error}`);
			return textResult(result.data);
		},
	);

	// ------------------------------------------------------------------
	// knowledge_expand — drill deeper into a knowledge graph entity
	// ------------------------------------------------------------------
	server.registerTool(
		"knowledge_expand",
		{
			title: "Expand Entity",
			description:
				"Drill deeper into any entity in the knowledge graph. " +
				"Returns structured context: constraints, aspects, " +
				"attributes, dependencies, and related memories for " +
				"the named entity.",
			inputSchema: z.object({
				entity_name: z.string().describe("Entity name to expand (e.g., 'signetai', 'predictive_scorer')"),
				aspect_filter: z.string().optional().describe("Filter to a specific aspect by name substring"),
				question: z.string().optional().describe("What you want to know about this entity (for context)"),
				max_tokens: z.number().optional().describe("Response budget in tokens (default 2000)"),
			}),
		},
		async ({ entity_name, aspect_filter, question, max_tokens }) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/knowledge/expand", {
				method: "POST",
				body: {
					entity: entity_name,
					aspect: aspect_filter,
					question,
					maxTokens: max_tokens ?? 2000,
				},
			});

			if (!result.ok) {
				return errorResult(`Expand failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	const knowledgeTreeInput = z.object({
		entity: z.string().optional().describe("Entity name, e.g. Nicholai or Signet. Omit to list entities first."),
		depth: z.number().optional().describe("How deep to expand: 1=aspects, 2=groups, 3=claims. Default 3."),
		max_aspects: z.number().optional().describe("Max aspects/rooms to return, default 20"),
		max_groups: z.number().optional().describe("Max groups/dressers per aspect, default 20"),
		max_claims: z.number().optional().describe("Max claims/drawers per group, default 50"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const listEntitiesInput = z.object({
		query: z.string().optional().describe("Optional entity name filter"),
		type: z.string().optional().describe("Optional entity type filter"),
		limit: z.number().optional().describe("Max entities to return, default 50"),
		offset: z.number().optional().describe("Pagination offset, default 0"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const getEntityInput = z.object({
		name: z.string().describe("Entity name, e.g. Nicholai or Signet"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const listAspectsInput = z.object({
		entity: z.string().describe("Entity name"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const listGroupsInput = z.object({
		entity: z.string().describe("Entity name"),
		aspect: z.string().describe("Aspect/room name, e.g. food"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const listClaimsInput = z.object({
		entity: z.string().describe("Entity name"),
		aspect: z.string().describe("Aspect/room name"),
		group: z.string().describe("Group/dresser key, e.g. restaurants"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const listAttributesInput = z.object({
		entity: z.string().describe("Entity name"),
		aspect: z.string().describe("Aspect/room name"),
		group: z.string().describe("Group/dresser key"),
		claim: z.string().describe("Claim/drawer key, e.g. favorite_restaurant"),
		status: z.enum(["active", "superseded", "deleted", "all"]).optional().describe("Default active"),
		kind: z.enum(["attribute", "constraint"]).optional(),
		limit: z.number().optional().describe("Max attributes to return, default 50"),
		offset: z.number().optional().describe("Pagination offset, default 0"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});
	const hygieneReportInput = z.object({
		limit: z.number().optional().describe("Max rows per report section, default 50"),
		memory_limit: z.number().optional().describe("Recent memories to scan for safe mention candidates, default 200"),
		agent_id: z.string().optional().describe("Agent scope, default default"),
	});

	const fetchNavigation = async (path: string, params: URLSearchParams, label: string) => {
		const query = params.toString();
		const result = await daemonFetch<unknown>(baseUrl, query ? `${path}?${query}` : path);
		if (!result.ok) return errorResult(`${label} failed: ${result.error}`);
		return textResult(result.data);
	};
	const knowledgeTree = async ({
		entity,
		depth,
		max_aspects,
		max_groups,
		max_claims,
		agent_id,
	}: z.infer<typeof knowledgeTreeInput>) => {
		const params = new URLSearchParams();
		if (!entity) {
			if (max_aspects !== undefined) params.set("limit", String(max_aspects));
			if (agent_id) params.set("agent_id", agent_id);
			return fetchNavigation("/api/knowledge/navigation/entities", params, "Knowledge tree entity listing");
		}
		params.set("entity", entity);
		if (depth !== undefined) params.set("depth", String(depth));
		if (max_aspects !== undefined) params.set("max_aspects", String(max_aspects));
		if (max_groups !== undefined) params.set("max_groups", String(max_groups));
		if (max_claims !== undefined) params.set("max_claims", String(max_claims));
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/tree", params, "Knowledge tree");
	};
	const listEntities = async ({ query, type, limit, offset, agent_id }: z.infer<typeof listEntitiesInput>) => {
		const params = new URLSearchParams();
		if (query) params.set("q", query);
		if (type) params.set("type", type);
		if (limit !== undefined) params.set("limit", String(limit));
		if (offset !== undefined) params.set("offset", String(offset));
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/entities", params, "Entity list");
	};
	const getEntity = async ({ name, agent_id }: z.infer<typeof getEntityInput>) => {
		const params = new URLSearchParams({ name });
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/entity", params, "Entity get");
	};
	const listAspects = async ({ entity, agent_id }: z.infer<typeof listAspectsInput>) => {
		const params = new URLSearchParams({ entity });
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/aspects", params, "Entity aspects");
	};
	const listGroups = async ({ entity, aspect, agent_id }: z.infer<typeof listGroupsInput>) => {
		const params = new URLSearchParams({ entity, aspect });
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/groups", params, "Entity groups");
	};
	const listClaims = async ({ entity, aspect, group, agent_id }: z.infer<typeof listClaimsInput>) => {
		const params = new URLSearchParams({ entity, aspect, group });
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/claims", params, "Entity claims");
	};
	const listAttributes = async ({
		entity,
		aspect,
		group,
		claim,
		status,
		kind,
		limit,
		offset,
		agent_id,
	}: z.infer<typeof listAttributesInput>) => {
		const params = new URLSearchParams({ entity, aspect, group, claim });
		if (status) params.set("status", status);
		if (kind) params.set("kind", kind);
		if (limit !== undefined) params.set("limit", String(limit));
		if (offset !== undefined) params.set("offset", String(offset));
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/navigation/attributes", params, "Entity attributes");
	};
	const hygieneReport = async ({ limit, memory_limit, agent_id }: z.infer<typeof hygieneReportInput>) => {
		const params = new URLSearchParams();
		if (limit !== undefined) params.set("limit", String(limit));
		if (memory_limit !== undefined) params.set("memory_limit", String(memory_limit));
		if (agent_id) params.set("agent_id", agent_id);
		return fetchNavigation("/api/knowledge/hygiene", params, "Knowledge hygiene report");
	};

	server.registerTool(
		"knowledge_tree",
		{
			title: "Knowledge Tree",
			description:
				"Show a compact outline of the knowledge graph. " +
				"Use this when you know an entity and need tool-visible structure before choosing what to read. " +
				"It returns aspects/rooms, groups/dressers, claim drawers, counts, and active previews. " +
				"Omit entity to list top-level entities first.",
			inputSchema: knowledgeTreeInput,
			annotations: { readOnlyHint: true },
		},
		knowledgeTree,
	);

	server.registerTool(
		"knowledge_list_entities",
		{
			title: "Knowledge: List Entities",
			description:
				"List top-level knowledge graph entities, like folders or houses. " +
				"Use this first when you do not know the exact entity name.",
			inputSchema: listEntitiesInput,
			annotations: { readOnlyHint: true },
		},
		listEntities,
	);

	server.registerTool(
		"knowledge_get_entity",
		{
			title: "Knowledge: Get Entity",
			description:
				"Resolve one entity by name and return its structural summary. " +
				"Use knowledge_tree after this to scan the entity's rooms, dressers, and drawers.",
			inputSchema: getEntityInput,
			annotations: { readOnlyHint: true },
		},
		getEntity,
	);

	server.registerTool(
		"knowledge_list_aspects",
		{
			title: "Knowledge: List Aspects",
			description:
				"List aspects, which are broad rooms under an entity. " +
				"Use this before knowledge_list_groups when you want step-by-step navigation.",
			inputSchema: listAspectsInput,
			annotations: { readOnlyHint: true },
		},
		listAspects,
	);

	server.registerTool(
		"knowledge_list_groups",
		{
			title: "Knowledge: List Groups",
			description:
				"List groups, which are dresser-like subdivisions inside an aspect. " +
				"Use this to find the right subgroup before opening claim drawers.",
			inputSchema: listGroupsInput,
			annotations: { readOnlyHint: true },
		},
		listGroups,
	);

	server.registerTool(
		"knowledge_list_claims",
		{
			title: "Knowledge: List Claims",
			description:
				"List claim keys, which are drawers containing current and historical observations. " +
				"Use this before knowledge_list_attributes when you need the actual saved notes.",
			inputSchema: listClaimsInput,
			annotations: { readOnlyHint: true },
		},
		listClaims,
	);

	server.registerTool(
		"knowledge_list_attributes",
		{
			title: "Knowledge: List Attributes",
			description:
				"List the saved observations inside one entity/aspect/group/claim path. " +
				"Defaults to active/current rows; pass status=all when you need superseded history.",
			inputSchema: listAttributesInput,
			annotations: { readOnlyHint: true },
		},
		listAttributes,
	);

	server.registerTool(
		"knowledge_hygiene_report",
		{
			title: "Knowledge Hygiene Report",
			description:
				"Run a report-only scan for likely graph cleanup work. " +
				"Flags suspicious entities, duplicate canonical entities, missing group/claim/source fields, " +
				"and safe known-entity mention candidates without mutating the graph.",
			inputSchema: hygieneReportInput,
			annotations: { readOnlyHint: true },
		},
		hygieneReport,
	);

	server.registerTool(
		"entity_list",
		{
			title: "List Entities",
			description: "Compatibility alias for knowledge_list_entities.",
			inputSchema: listEntitiesInput,
			annotations: { readOnlyHint: true },
		},
		listEntities,
	);

	server.registerTool(
		"entity_get",
		{
			title: "Get Entity",
			description: "Compatibility alias for knowledge_get_entity.",
			inputSchema: getEntityInput,
			annotations: { readOnlyHint: true },
		},
		getEntity,
	);

	server.registerTool(
		"entity_aspects",
		{
			title: "List Entity Aspects",
			description: "Compatibility alias for knowledge_list_aspects.",
			inputSchema: listAspectsInput,
			annotations: { readOnlyHint: true },
		},
		listAspects,
	);

	server.registerTool(
		"entity_groups",
		{
			title: "List Entity Groups",
			description: "Compatibility alias for knowledge_list_groups.",
			inputSchema: listGroupsInput,
			annotations: { readOnlyHint: true },
		},
		listGroups,
	);

	server.registerTool(
		"entity_claims",
		{
			title: "List Entity Claims",
			description: "Compatibility alias for knowledge_list_claims.",
			inputSchema: listClaimsInput,
			annotations: { readOnlyHint: true },
		},
		listClaims,
	);

	server.registerTool(
		"entity_attributes",
		{
			title: "List Entity Attributes",
			description: "Compatibility alias for knowledge_list_attributes.",
			inputSchema: listAttributesInput,
			annotations: { readOnlyHint: true },
		},
		listAttributes,
	);

	// ------------------------------------------------------------------
	// knowledge_expand_session — temporal drill-down via session DAG
	// ------------------------------------------------------------------
	server.registerTool(
		"knowledge_expand_session",
		{
			title: "Expand Entity Sessions",
			description:
				"Drill into session summaries that reference a given " +
				"entity. Returns formatted session summary text linked " +
				"through memory→entity mentions.",
			inputSchema: z.object({
				entity_name: z.string().describe("Entity name to look up"),
				session_id: z.string().optional().describe("Filter to a specific session key"),
				time_range: z.string().optional().describe('Time range filter: "last_week", "last_month", or ISO date'),
				max_results: z.number().optional().describe("Max summaries to return (default 10)"),
			}),
		},
		async ({ entity_name, session_id, time_range, max_results }) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/knowledge/expand/session", {
				method: "POST",
				body: {
					entityName: entity_name,
					sessionId: session_id,
					timeRange: time_range,
					maxResults: max_results ?? 10,
				},
			});

			if (!result.ok) {
				return errorResult(`Session expansion failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"lcm_expand",
		{
			title: "Expand Temporal Node",
			description:
				"Expand a temporal MEMORY.md or session DAG node by id. " +
				"Returns parent and child lineage, linked memories, and " +
				"optionally transcript context for drill-down.",
			inputSchema: z.object({
				id: z.string().describe("Temporal node id from MEMORY.md or /api/sessions/summaries"),
				include_transcript: z.boolean().optional().describe("Include transcript context when available"),
				transcript_char_limit: z.number().optional().describe("Max transcript chars to return (default 2000)"),
			}),
		},
		async ({ id, include_transcript, transcript_char_limit }) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/sessions/summaries/expand", {
				method: "POST",
				body: {
					id,
					includeTranscript: include_transcript ?? true,
					transcriptCharLimit: transcript_char_limit,
				},
			});

			if (!result.ok) {
				return errorResult(`Temporal expansion failed: ${result.error}`);
			}
			return textResult(result.data);
		},
	);

	server.registerTool(
		"code_search",
		{
			title: "Search Code",
			description: "Search the active GraphIQ-indexed project for symbols and implementation context.",
			inputSchema: z.object({
				query: z.string().describe("Code search query"),
				top: z
					.number()
					.int()
					.min(1)
					.max(GRAPHIQ_SEARCH_TOP_MAX)
					.optional()
					.describe(`Max results to return (default ${GRAPHIQ_SEARCH_TOP_DEFAULT}, max ${GRAPHIQ_SEARCH_TOP_MAX})`),
				file: z.string().optional().describe("Optional file path filter"),
				debug: z.boolean().optional().describe("Include GraphIQ score/debug details"),
			}),
		},
		async ({ query, top, file, debug }) => {
			const safeQuery = graphIqPositionalArg(query, "query");
			if (!safeQuery.ok) return errorResult(safeQuery.error);
			const boundedTop = boundedInteger(top, GRAPHIQ_SEARCH_TOP_DEFAULT, GRAPHIQ_SEARCH_TOP_MAX);
			const args = ["search", safeQuery.value, "--top", String(boundedTop)];
			if (file) {
				const safeFile = graphIqPositionalArg(file, "file filter");
				if (!safeFile.ok) return errorResult(safeFile.error);
				args.push("--file", safeFile.value);
			}
			if (debug) args.push("--debug");
			return graphIqToolResult(args, "Code search failed", "code_search", pluginHostProvider);
		},
	);

	server.registerTool(
		"code_context",
		{
			title: "Code Context",
			description: "Read full source and structural neighborhood for a symbol in the active GraphIQ project.",
			inputSchema: z.object({
				symbol: z.string().describe("Symbol name to inspect"),
			}),
		},
		async ({ symbol }) => {
			const safeSymbol = graphIqPositionalArg(symbol, "symbol");
			if (!safeSymbol.ok) return errorResult(safeSymbol.error);
			return graphIqToolResult(
				["context", safeSymbol.value],
				"Code context failed",
				"code_context",
				pluginHostProvider,
			);
		},
	);

	server.registerTool(
		"code_blast",
		{
			title: "Code Blast Radius",
			description: "Analyze impact radius for a symbol in the active GraphIQ project.",
			inputSchema: z.object({
				symbol: z.string().describe("Symbol name to analyze"),
				depth: z
					.number()
					.int()
					.min(1)
					.max(GRAPHIQ_BLAST_DEPTH_MAX)
					.optional()
					.describe(`Traversal depth (default ${GRAPHIQ_BLAST_DEPTH_DEFAULT}, max ${GRAPHIQ_BLAST_DEPTH_MAX})`),
				direction: z.enum(["forward", "backward", "both"]).optional().describe("Traversal direction"),
			}),
		},
		async ({ symbol, depth, direction }) => {
			const safeSymbol = graphIqPositionalArg(symbol, "symbol");
			if (!safeSymbol.ok) return errorResult(safeSymbol.error);
			const boundedDepth = boundedInteger(depth, GRAPHIQ_BLAST_DEPTH_DEFAULT, GRAPHIQ_BLAST_DEPTH_MAX);
			const args = ["blast", safeSymbol.value, "--depth", String(boundedDepth), "--direction", direction ?? "both"];
			return graphIqToolResult(args, "Code blast failed", "code_blast", pluginHostProvider);
		},
	);

	server.registerTool(
		"code_status",
		{
			title: "Code Index Status",
			description: "Show GraphIQ status for the active indexed project.",
			inputSchema: z.object({}),
		},
		async () => graphIqToolResult(["status"], "Code status failed", "code_status", pluginHostProvider),
	);

	server.registerTool(
		"code_doctor",
		{
			title: "Code Index Doctor",
			description: "Diagnose GraphIQ artifact health for the active indexed project.",
			inputSchema: z.object({}),
		},
		async () => graphIqToolResult(["doctor"], "Code doctor failed", "code_doctor", pluginHostProvider),
	);

	server.registerTool(
		"code_constants",
		{
			title: "Code Constants",
			description: "Find shared numeric/string constants in the active GraphIQ project.",
			inputSchema: z.object({
				query: z.string().optional().describe("Optional constant/name filter"),
				top: z
					.number()
					.int()
					.min(1)
					.max(GRAPHIQ_CONSTANTS_TOP_MAX)
					.optional()
					.describe(
						`Max results to return (default ${GRAPHIQ_CONSTANTS_TOP_DEFAULT}, max ${GRAPHIQ_CONSTANTS_TOP_MAX})`,
					),
			}),
		},
		async ({ query, top }) => {
			const args = ["constants"];
			if (query) {
				const safeQuery = graphIqPositionalArg(query, "query");
				if (!safeQuery.ok) return errorResult(safeQuery.error);
				args.push(safeQuery.value);
			}
			const boundedTop = boundedInteger(top, GRAPHIQ_CONSTANTS_TOP_DEFAULT, GRAPHIQ_CONSTANTS_TOP_MAX);
			args.push("--top", String(boundedTop));
			return graphIqToolResult(args, "Code constants failed", "code_constants", pluginHostProvider);
		},
	);

	if (enableMarketplaceProxyTools) {
		await refreshMarketplaceProxyTools(server, { notify: false });
	}

	return server;
}

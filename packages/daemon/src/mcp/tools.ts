/**
 * MCP tool definitions for the Signet daemon.
 *
 * Creates an McpServer with memory operations exposed as MCP tools.
 * Tool handlers call the daemon's HTTP API — this avoids duplicating
 * the complex recall/remember logic and ensures feature parity.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
]);

const marketplaceProxyState = new WeakMap<McpServer, MarketplaceProxyState>();
const hotToolIdsByContext = new Map<string, Set<string>>();
const hotToolTouchedAt = new Map<string, number>();
const HOT_CONTEXT_TTL_MS = 30 * 60 * 1000;

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
	} = {},
): Promise<FetchResult<T>> {
	const { method = "GET", body, timeout = 10_000 } = options;

	const init: RequestInit = {
		method,
		headers: {
			"Content-Type": "application/json",
			"x-signet-runtime-path": "plugin",
			"x-signet-actor": "mcp-server",
			"x-signet-actor-type": "harness",
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

function errorResult(msg: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true as const,
	};
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
			updatedAt: new Date(0).toISOString(),
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
				type: z.string().optional().describe("Filter by memory type"),
				min_score: z.number().optional().describe("Minimum relevance score threshold"),
			}),
		},
		async ({ query, limit, type, min_score }) => {
			const result = await daemonFetch<unknown>(baseUrl, "/api/memory/recall", {
				method: "POST",
				body: {
					query,
					limit: limit ?? 10,
					type,
					importance_min: min_score,
				},
			});

			if (!result.ok) {
				return errorResult(`Search failed: ${result.error}`);
			}
			return textResult(result.data);
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
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ content, type, importance, tags }) => {
			// Prepend tags prefix if provided (daemon parses [tag1,tag2]: format)
			let body = content;
			if (tags) {
				body = `[${tags}]: ${content}`;
			}

			const result = await daemonFetch<unknown>(baseUrl, "/api/memory/remember", {
				method: "POST",
				body: {
					content: body,
					importance,
				},
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
				reason: z.string().describe("Why this edit is being made"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ id, content, type, importance, tags, reason }) => {
			const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`, {
				method: "PATCH",
				body: {
					content,
					type,
					importance,
					tags,
					reason,
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
				ratings: z
					.record(z.string(), z.number())
					.describe("Map of memory ID to relevance score (-1 to 1)"),
			}),
			annotations: { readOnlyHint: false },
		},
		async ({ session_key, ratings }) => {
			const result = await daemonFetch<{ ok: boolean; recorded: number }>(
				baseUrl,
				"/api/memory/feedback",
				{
					method: "POST",
					body: { sessionKey: session_key, feedback: ratings },
				},
			);
			if (!result.ok) {
				return errorResult(`Feedback failed: ${result.error}`);
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
					.record(z.string(), z.string())
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
				args: z.record(z.string(), z.unknown()).optional().describe("Tool argument object"),
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

	if (enableMarketplaceProxyTools) {
		await refreshMarketplaceProxyTools(server, { notify: false });
	}

	return server;
}

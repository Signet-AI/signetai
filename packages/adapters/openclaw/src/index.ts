/**
 * Signet Adapter for OpenClaw
 *
 * Runtime plugin integrating Signet's memory system with OpenClaw's
 * plugin API. Uses the register(api) pattern — tools via
 * api.registerTool(), lifecycle via api.on().
 *
 * All operations route through daemon APIs with the "plugin" runtime
 * path for dedup safety.
 */

import { Type } from "@sinclair/typebox";
import type {
	OpenClawPluginApi,
	OpenClawToolResult,
} from "./openclaw-types.js";

const DEFAULT_DAEMON_URL = "http://localhost:3850";
const RUNTIME_PATH = "plugin" as const;
const READ_TIMEOUT = 5000;
const WRITE_TIMEOUT = 10000;

// ============================================================================
// Types
// ============================================================================

export interface SignetConfig {
	enabled?: boolean;
	daemonUrl?: string;
}

export interface SessionStartResult {
	identity: {
		name: string;
		description?: string;
	};
	memories: Array<{
		id: string;
		content: string;
		type: string;
		importance: number;
		created_at: string;
	}>;
	recentContext?: string;
	inject: string;
}

export interface PreCompactionResult {
	summaryPrompt: string;
	guidelines: string;
}

export interface UserPromptSubmitResult {
	inject: string;
	memoryCount: number;
	queryTerms?: string;
	engine?: string;
}

export interface SessionEndResult {
	memoriesSaved: number;
}

interface MemoryRecord {
	id: string;
	content: string;
	type: string;
	importance: number;
	tags: string | null;
	pinned: number;
	who: string | null;
	created_at: string;
	updated_at: string;
}

interface RecallResult {
	id: string;
	content: string;
	type: string;
	importance: number;
	score: number;
	created_at: string;
}

// ============================================================================
// Shared fetch helper
// ============================================================================

function pluginHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-signet-runtime-path": RUNTIME_PATH,
		"x-signet-actor": "openclaw-plugin",
		"x-signet-actor-type": "harness",
	};
}

async function daemonFetch<T>(
	daemonUrl: string,
	path: string,
	options: {
		method?: string;
		body?: unknown;
		timeout?: number;
	} = {},
): Promise<T | null> {
	const { method = "GET", body, timeout = READ_TIMEOUT } = options;

	try {
		const init: RequestInit = {
			method,
			headers: pluginHeaders(),
			signal: AbortSignal.timeout(timeout),
		};

		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		const res = await fetch(`${daemonUrl}${path}`, init);

		if (!res.ok) {
			console.warn(`[signet] ${method} ${path} failed:`, res.status);
			return null;
		}

		return (await res.json()) as T;
	} catch (e) {
		console.warn(`[signet] ${method} ${path} error:`, e);
		return null;
	}
}

// ============================================================================
// Health check
// ============================================================================

export async function isDaemonRunning(
	daemonUrl = DEFAULT_DAEMON_URL,
): Promise<boolean> {
	try {
		const res = await fetch(`${daemonUrl}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ============================================================================
// Lifecycle callbacks
// ============================================================================

export async function onSessionStart(
	harness: string,
	options: {
		daemonUrl?: string;
		agentId?: string;
		context?: string;
		sessionKey?: string;
	} = {},
): Promise<SessionStartResult | null> {
	return daemonFetch(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		"/api/hooks/session-start",
		{
			method: "POST",
			body: {
				harness,
				agentId: options.agentId,
				context: options.context,
				sessionKey: options.sessionKey,
				runtimePath: RUNTIME_PATH,
			},
			timeout: READ_TIMEOUT,
		},
	);
}

export async function onUserPromptSubmit(
	harness: string,
	options: {
		daemonUrl?: string;
		userPrompt: string;
		sessionKey?: string;
		project?: string;
	},
): Promise<UserPromptSubmitResult | null> {
	return daemonFetch(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		"/api/hooks/user-prompt-submit",
		{
			method: "POST",
			body: {
				harness,
				userPrompt: options.userPrompt,
				sessionKey: options.sessionKey,
				project: options.project,
				runtimePath: RUNTIME_PATH,
			},
			timeout: READ_TIMEOUT,
		},
	);
}

export async function onPreCompaction(
	harness: string,
	options: {
		daemonUrl?: string;
		sessionContext?: string;
		messageCount?: number;
		sessionKey?: string;
	} = {},
): Promise<PreCompactionResult | null> {
	return daemonFetch(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		"/api/hooks/pre-compaction",
		{
			method: "POST",
			body: {
				harness,
				sessionContext: options.sessionContext,
				messageCount: options.messageCount,
				sessionKey: options.sessionKey,
				runtimePath: RUNTIME_PATH,
			},
			timeout: READ_TIMEOUT,
		},
	);
}

export async function onCompactionComplete(
	harness: string,
	summary: string,
	options: {
		daemonUrl?: string;
		sessionKey?: string;
	} = {},
): Promise<boolean> {
	const result = await daemonFetch<{ success: boolean }>(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		"/api/hooks/compaction-complete",
		{
			method: "POST",
			body: {
				harness,
				summary,
				sessionKey: options.sessionKey,
				runtimePath: RUNTIME_PATH,
			},
			timeout: WRITE_TIMEOUT,
		},
	);
	return result?.success === true;
}

export async function onSessionEnd(
	harness: string,
	options: {
		daemonUrl?: string;
		transcriptPath?: string;
		sessionKey?: string;
		sessionId?: string;
		cwd?: string;
		reason?: string;
	} = {},
): Promise<SessionEndResult | null> {
	return daemonFetch(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		"/api/hooks/session-end",
		{
			method: "POST",
			body: {
				harness,
				transcriptPath: options.transcriptPath,
				sessionKey: options.sessionKey,
				sessionId: options.sessionId,
				cwd: options.cwd,
				reason: options.reason,
				runtimePath: RUNTIME_PATH,
			},
			timeout: WRITE_TIMEOUT,
		},
	);
}

// ============================================================================
// Tool operations (call v2 daemon memory APIs directly)
// ============================================================================

export async function memorySearch(
	query: string,
	options: {
		daemonUrl?: string;
		limit?: number;
		type?: string;
		minScore?: number;
	} = {},
): Promise<RecallResult[]> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<{ results: RecallResult[] }>(
		daemonUrl,
		"/api/memory/recall",
		{
			method: "POST",
			body: {
				query,
				limit: options.limit || 10,
				type: options.type,
				min_score: options.minScore,
			},
			timeout: READ_TIMEOUT,
		},
	);
	return result?.results || [];
}

export async function memoryStore(
	content: string,
	options: {
		daemonUrl?: string;
		type?: string;
		importance?: number;
		tags?: string[];
		who?: string;
	} = {},
): Promise<string | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<{ id?: string; memoryId?: string }>(
		daemonUrl,
		"/api/memory/remember",
		{
			method: "POST",
			body: {
				content,
				type: options.type,
				importance: options.importance,
				tags: options.tags,
				who: options.who || "openclaw",
			},
			timeout: WRITE_TIMEOUT,
		},
	);
	return result?.id || result?.memoryId || null;
}

export async function memoryGet(
	id: string,
	options: { daemonUrl?: string } = {},
): Promise<MemoryRecord | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	return daemonFetch<MemoryRecord>(
		daemonUrl,
		`/api/memory/${encodeURIComponent(id)}`,
		{ timeout: READ_TIMEOUT },
	);
}

export async function memoryList(
	options: {
		daemonUrl?: string;
		limit?: number;
		offset?: number;
		type?: string;
	} = {},
): Promise<{ memories: MemoryRecord[]; stats: Record<string, number> }> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const params = new URLSearchParams();
	if (options.limit) params.set("limit", String(options.limit));
	if (options.offset) params.set("offset", String(options.offset));
	if (options.type) params.set("type", options.type);

	const qs = params.toString();
	const path = `/api/memories${qs ? `?${qs}` : ""}`;

	const result = await daemonFetch<{
		memories: MemoryRecord[];
		stats: Record<string, number>;
	}>(daemonUrl, path, { timeout: READ_TIMEOUT });

	return result || { memories: [], stats: {} };
}

export async function memoryModify(
	id: string,
	patch: {
		content?: string;
		type?: string;
		importance?: number;
		tags?: string;
		reason: string;
		if_version?: number;
	},
	options: { daemonUrl?: string } = {},
): Promise<boolean> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<{ success?: boolean }>(
		daemonUrl,
		`/api/memory/${encodeURIComponent(id)}`,
		{
			method: "PATCH",
			body: patch,
			timeout: WRITE_TIMEOUT,
		},
	);
	return result?.success === true;
}

export async function memoryForget(
	id: string,
	options: {
		daemonUrl?: string;
		reason: string;
		force?: boolean;
	},
): Promise<boolean> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const params = new URLSearchParams();
	params.set("reason", options.reason);
	if (options.force) params.set("force", "true");

	const result = await daemonFetch<{ success?: boolean }>(
		daemonUrl,
		`/api/memory/${encodeURIComponent(id)}?${params}`,
		{
			method: "DELETE",
			timeout: WRITE_TIMEOUT,
		},
	);
	return result?.success === true;
}

// ============================================================================
// Legacy aliases (kept for backwards compat)
// ============================================================================

export async function remember(
	content: string,
	options: {
		daemonUrl?: string;
		type?: string;
		importance?: number;
		tags?: string[];
		who?: string;
	} = {},
): Promise<string | null> {
	return memoryStore(content, options);
}

export async function recall(
	query: string,
	options: {
		daemonUrl?: string;
		limit?: number;
		type?: string;
		minScore?: number;
	} = {},
): Promise<RecallResult[]> {
	return memorySearch(query, options);
}

// ============================================================================
// Config schema (with parse() method for OpenClaw plugin API)
// ============================================================================

const signetConfigSchema = {
	parse(value: unknown): SignetConfig {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { daemonUrl: DEFAULT_DAEMON_URL };
		}
		const cfg = value as Record<string, unknown>;
		return {
			enabled: cfg.enabled !== false,
			daemonUrl:
				typeof cfg.daemonUrl === "string"
					? cfg.daemonUrl
					: DEFAULT_DAEMON_URL,
		};
	},
};

// ============================================================================
// Tool result helpers
// ============================================================================

function textResult(
	text: string,
	details?: Record<string, unknown>,
): OpenClawToolResult {
	return {
		content: [{ type: "text", text }],
		...(details ? { details } : {}),
	};
}

// ============================================================================
// Plugin definition (OpenClaw register(api) pattern)
// ============================================================================

const signetPlugin = {
	id: "signet-memory-openclaw",
	name: "Signet Memory",
	description:
		"Signet agent memory — persistent, searchable, identity-aware memory for AI agents",
	kind: "memory" as const,
	configSchema: signetConfigSchema,

	register(api: OpenClawPluginApi): void {
		const cfg = signetConfigSchema.parse(api.pluginConfig);
		const daemonUrl = cfg.daemonUrl || DEFAULT_DAEMON_URL;
		const opts = { daemonUrl };

		api.logger.info(`signet-memory: registered (daemon: ${daemonUrl})`);

		// ==================================================================
		// Tools
		// ==================================================================

		api.registerTool(
			{
				name: "memory_search",
				label: "Memory Search",
				description:
					"Search memories using hybrid vector + keyword search",
				parameters: Type.Object({
					query: Type.String({ description: "Search query text" }),
					limit: Type.Optional(
						Type.Number({
							description: "Max results to return (default 10)",
						}),
					),
					type: Type.Optional(
						Type.String({
							description: "Filter by memory type",
						}),
					),
					min_score: Type.Optional(
						Type.Number({
							description: "Minimum relevance score threshold",
						}),
					),
				}),
				async execute(_toolCallId, params) {
					const { query, limit, type, min_score } = params as {
						query: string;
						limit?: number;
						type?: string;
						min_score?: number;
					};
					try {
						const results = await memorySearch(query, {
							...opts,
							limit,
							type,
							minScore: min_score,
						});
						if (results.length === 0) {
							return textResult("No relevant memories found.", {
								count: 0,
							});
						}
						const text = results
							.map(
								(r, i) =>
									`${i + 1}. ${r.content} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id})`,
							)
							.join("\n");
						return textResult(
							`Found ${results.length} memories:\n\n${text}`,
							{ count: results.length, memories: results },
						);
					} catch (err) {
						return textResult(
							`Memory search failed: ${String(err)}`,
							{ error: String(err) },
						);
					}
				},
			},
			{ name: "memory_search" },
		);

		api.registerTool(
			{
				name: "memory_store",
				label: "Memory Store",
				description: "Save a new memory",
				parameters: Type.Object({
					content: Type.String({
						description: "Memory content to save",
					}),
					type: Type.Optional(
						Type.String({
							description:
								"Memory type (fact, preference, decision, etc.)",
						}),
					),
					importance: Type.Optional(
						Type.Number({
							description: "Importance score 0-1",
						}),
					),
					tags: Type.Optional(
						Type.String({
							description:
								"Comma-separated tags for categorization",
						}),
					),
				}),
				async execute(_toolCallId, params) {
					const { content, type, importance, tags } = params as {
						content: string;
						type?: string;
						importance?: number;
						tags?: string;
					};
					try {
						const id = await memoryStore(content, {
							...opts,
							type,
							importance,
							tags: tags
								? tags.split(",").map((t) => t.trim())
								: undefined,
						});
						if (id) {
							return textResult(
								`Memory saved successfully (id: ${id})`,
								{ id },
							);
						}
						return textResult("Failed to save memory.", {
							error: "no id returned",
						});
					} catch (err) {
						return textResult(
							`Memory store failed: ${String(err)}`,
							{ error: String(err) },
						);
					}
				},
			},
			{ name: "memory_store" },
		);

		api.registerTool(
			{
				name: "memory_get",
				label: "Memory Get",
				description: "Get a single memory by its ID",
				parameters: Type.Object({
					id: Type.String({
						description: "Memory ID to retrieve",
					}),
				}),
				async execute(_toolCallId, params) {
					const { id } = params as { id: string };
					try {
						const memory = await memoryGet(id, opts);
						if (memory) {
							return textResult(JSON.stringify(memory, null, 2), {
								memory,
							});
						}
						return textResult(`Memory ${id} not found.`, {
							error: "not found",
						});
					} catch (err) {
						return textResult(
							`Memory get failed: ${String(err)}`,
							{ error: String(err) },
						);
					}
				},
			},
			{ name: "memory_get" },
		);

		api.registerTool(
			{
				name: "memory_list",
				label: "Memory List",
				description: "List memories with optional filters",
				parameters: Type.Object({
					limit: Type.Optional(
						Type.Number({
							description: "Max results (default 100)",
						}),
					),
					offset: Type.Optional(
						Type.Number({ description: "Pagination offset" }),
					),
					type: Type.Optional(
						Type.String({
							description: "Filter by memory type",
						}),
					),
				}),
				async execute(_toolCallId, params) {
					const { limit, offset, type } = params as {
						limit?: number;
						offset?: number;
						type?: string;
					};
					try {
						const result = await memoryList({
							...opts,
							limit,
							offset,
							type,
						});
						return textResult(
							`${result.memories.length} memories:\n\n${result.memories.map((m) => `- [${m.type}] ${m.content} (id: ${m.id})`).join("\n")}`,
							{
								count: result.memories.length,
								stats: result.stats,
							},
						);
					} catch (err) {
						return textResult(
							`Memory list failed: ${String(err)}`,
							{ error: String(err) },
						);
					}
				},
			},
			{ name: "memory_list" },
		);

		api.registerTool(
			{
				name: "memory_modify",
				label: "Memory Modify",
				description: "Edit an existing memory by ID",
				parameters: Type.Object({
					id: Type.String({
						description: "Memory ID to modify",
					}),
					reason: Type.String({
						description: "Why this edit is being made",
					}),
					content: Type.Optional(
						Type.String({ description: "New content" }),
					),
					type: Type.Optional(
						Type.String({ description: "New type" }),
					),
					importance: Type.Optional(
						Type.Number({ description: "New importance" }),
					),
					tags: Type.Optional(
						Type.String({
							description: "New tags (comma-separated)",
						}),
					),
				}),
				async execute(_toolCallId, params) {
					const { id, reason, content, type, importance, tags } =
						params as {
							id: string;
							reason: string;
							content?: string;
							type?: string;
							importance?: number;
							tags?: string;
						};
					try {
						const ok = await memoryModify(
							id,
							{ content, type, importance, tags, reason },
							opts,
						);
						return textResult(
							ok
								? `Memory ${id} updated.`
								: `Failed to update memory ${id}.`,
							{ success: ok },
						);
					} catch (err) {
						return textResult(
							`Memory modify failed: ${String(err)}`,
							{ error: String(err) },
						);
					}
				},
			},
			{ name: "memory_modify" },
		);

		api.registerTool(
			{
				name: "memory_forget",
				label: "Memory Forget",
				description: "Soft-delete a memory by ID",
				parameters: Type.Object({
					id: Type.String({
						description: "Memory ID to forget",
					}),
					reason: Type.String({
						description: "Why this memory should be forgotten",
					}),
				}),
				async execute(_toolCallId, params) {
					const { id, reason } = params as {
						id: string;
						reason: string;
					};
					try {
						const ok = await memoryForget(id, {
							...opts,
							reason,
						});
						return textResult(
							ok
								? `Memory ${id} forgotten.`
								: `Failed to forget memory ${id}.`,
							{ success: ok },
						);
					} catch (err) {
						return textResult(
							`Memory forget failed: ${String(err)}`,
							{ error: String(err) },
						);
					}
				},
			},
			{ name: "memory_forget" },
		);

		// ==================================================================
		// Lifecycle hooks
		// ==================================================================

		api.on(
			"before_agent_start",
			async (
				event: Record<string, unknown>,
				ctx: unknown,
			): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const sessionKey = (
					ctx as Record<string, unknown> | undefined
				)?.sessionKey as string | undefined;

				// Session start — claim session with daemon
				await onSessionStart("openclaw", { ...opts, sessionKey });

				// If there's a prompt, do memory injection
				const prompt = event.prompt as string | undefined;
				if (prompt && prompt.length > 3) {
					const result = await onUserPromptSubmit("openclaw", {
						...opts,
						userPrompt: prompt,
						sessionKey,
					});
					if (result?.inject) {
						const queryAttr = result.queryTerms
							? ` query="${result.queryTerms.replace(/"/g, "'").slice(0, 100)}"`
							: "";
						const attrs = `source="auto-recall"${queryAttr} results="${result.memoryCount}" engine="${result.engine ?? "fts+decay"}"`;
						return {
							prependContext: `<signet-memory ${attrs}>\n${result.inject}\n</signet-memory>`,
						};
					}
				}

				return undefined;
			},
		);

		api.on(
			"agent_end",
			async (
				_event: Record<string, unknown>,
				ctx: unknown,
			): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const sessionKey = (
					ctx as Record<string, unknown> | undefined
				)?.sessionKey as string | undefined;

				await onSessionEnd("openclaw", { ...opts, sessionKey });
				return undefined;
			},
		);

		// ==================================================================
		// Service
		// ==================================================================

		api.registerService({
			id: "signet-memory-openclaw",
			start() {
				api.logger.info(
					`signet-memory: service started (daemon: ${daemonUrl})`,
				);
			},
			stop() {
				api.logger.info("signet-memory: service stopped");
			},
		});
	},
};

export default signetPlugin;

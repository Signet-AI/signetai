/**
 * Signet Adapter for OpenClaw
 *
 * Runtime plugin integrating Signet's memory system with OpenClaw's
 * lifecycle hooks and tool surface. This is the plugin-first path
 * (Phase G) — all operations route through daemon APIs with the
 * "plugin" runtime path for dedup safety.
 *
 * Usage in OpenClaw config:
 * ```json
 * {
 *   "plugins": {
 *     "entries": {
 *       "@signetai/adapter-openclaw": {
 *         "enabled": true,
 *         "config": {
 *           "daemonUrl": "http://localhost:3850"
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */

import {
	memorySearchSchema,
	memoryStoreSchema,
	memoryGetSchema,
	memoryListSchema,
	memoryModifySchema,
	memoryForgetSchema,
} from "./tool-schemas.js";

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
// Plugin factory
// ============================================================================

export interface ToolDefinition {
	fn: (...args: never[]) => Promise<unknown>;
	schema: Record<string, unknown>;
}

export function createPlugin(config: SignetConfig = {}) {
	const enabled = config.enabled !== false;
	const daemonUrl = config.daemonUrl || DEFAULT_DAEMON_URL;

	const opts = { daemonUrl };

	return {
		name: "@signetai/adapter-openclaw",

		// -- Lifecycle callbacks --

		async onSessionStart(ctx: {
			harness: string;
			sessionKey?: string;
			agentId?: string;
			context?: string;
		}) {
			if (!enabled) return null;
			return onSessionStart(ctx.harness, { ...opts, ...ctx });
		},

		async onUserPromptSubmit(ctx: {
			harness: string;
			userPrompt: string;
			sessionKey?: string;
			project?: string;
		}) {
			if (!enabled) return null;
			return onUserPromptSubmit(ctx.harness, { ...opts, ...ctx });
		},

		async onPreCompaction(ctx: {
			harness: string;
			sessionKey?: string;
			messageCount?: number;
			sessionContext?: string;
		}) {
			if (!enabled) return null;
			return onPreCompaction(ctx.harness, { ...opts, ...ctx });
		},

		async onCompactionComplete(ctx: {
			harness: string;
			summary: string;
			sessionKey?: string;
		}) {
			if (!enabled) return false;
			return onCompactionComplete(ctx.harness, ctx.summary, {
				...opts,
				sessionKey: ctx.sessionKey,
			});
		},

		async onSessionEnd(ctx: {
			harness: string;
			transcriptPath?: string;
			sessionKey?: string;
			sessionId?: string;
			cwd?: string;
			reason?: string;
		}) {
			if (!enabled) return null;
			return onSessionEnd(ctx.harness, { ...opts, ...ctx });
		},

		// -- Tool operations (for OpenClaw to expose as agent tools) --

		tools: {
			memory_search: {
				fn: (query: string, toolOpts?: Record<string, unknown>) =>
					memorySearch(query, { ...opts, ...toolOpts }),
				schema: memorySearchSchema,
			},
			memory_store: {
				fn: (content: string, toolOpts?: Record<string, unknown>) =>
					memoryStore(content, { ...opts, ...toolOpts }),
				schema: memoryStoreSchema,
			},
			memory_get: {
				fn: (id: string) => memoryGet(id, opts),
				schema: memoryGetSchema,
			},
			memory_list: {
				fn: (toolOpts?: Record<string, unknown>) =>
					memoryList({ ...opts, ...toolOpts }),
				schema: memoryListSchema,
			},
			memory_modify: {
				fn: (
					id: string,
					patch: {
						content?: string;
						type?: string;
						importance?: number;
						tags?: string;
						reason: string;
						if_version?: number;
					},
				) => memoryModify(id, patch, opts),
				schema: memoryModifySchema,
			},
			memory_forget: {
				fn: (
					id: string,
					forgetOpts: { reason: string; force?: boolean },
				) => memoryForget(id, { ...opts, ...forgetOpts }),
				schema: memoryForgetSchema,
			},
		} satisfies Record<string, ToolDefinition>,

		// -- Legacy compat (kept for now) --

		remember: (content: string, legacyOpts = {}) =>
			memoryStore(content, { ...opts, ...legacyOpts }),
		recall: (query: string, legacyOpts = {}) =>
			memorySearch(query, { ...opts, ...legacyOpts }),
	};
}

export default createPlugin;

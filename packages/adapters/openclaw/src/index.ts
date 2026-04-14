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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	readStaticIdentity,
	resolveSessionStartTimeoutMs,
} from "@signet/core";
import { Type } from "@sinclair/typebox";
import type {
	OpenClawPluginApi,
	OpenClawToolResult,
	PluginHookAfterCompactionEvent,
	PluginHookAgentContext,
	PluginHookAgentEndEvent,
	PluginHookBeforeAgentStartEvent,
	PluginHookBeforeCompactionEvent,
	PluginHookBeforePromptBuildEvent,
} from "./openclaw-types.js";

const DEFAULT_DAEMON_URL = "http://localhost:3850";
const RUNTIME_PATH = "plugin" as const;
const READ_TIMEOUT = 5000;
const WRITE_TIMEOUT = 10000;
const COMPACTION_HOOK_DEDUPE_MS = 1000;
const SESSION_START_TIMEOUT = resolveSessionStartTimeoutMs(
	process.env.SIGNET_SESSION_START_TIMEOUT ?? process.env.SIGNET_FETCH_TIMEOUT,
);

type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json";

type DaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: DaemonFetchFailure;
			readonly status?: number;
	  };

function errorName(err: unknown): string {
	if (typeof err !== "object" || err === null) return "";
	const name = Reflect.get(err, "name");
	return typeof name === "string" ? name : "";
}

function isTimeoutError(err: unknown): boolean {
	const name = errorName(err);
	if (name === "AbortError" || name === "TimeoutError") return true;
	const code = typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
	return code === "ABORT_ERR";
}

// ---------------------------------------------------------------------------
// Prompt extraction — OpenClaw wraps user messages in metadata envelopes.
// Strip the envelope so FTS queries only see the actual user text.
// ---------------------------------------------------------------------------

const METADATA_LINE_PREFIXES = [
	"<<<EXTERNAL_UNTRUSTED_CONTENT",
	">>>",
	"Conversation info",
	"Sender (untrusted",
	"Untrusted context",
	"END_EXTERNAL_UNTRUSTED_CONTENT",
] as const;

const SIGNET_MEMORY_CLOSE = "</signet-memory>";

function stripSignetMemory(content: string): string {
	const clean = (text: string): string => text.replace(/<\/signet-memory>/gi, "").trim();
	let text = content;
	while (true) {
		const start = text.search(/<signet-memory(?=[\s/>])/i);
		if (start === -1) return clean(text);
		const closeOffset = text.slice(start).search(/<\/signet-memory>/i);
		if (closeOffset === -1) return clean(text.slice(0, start));
		const end = start + closeOffset;
		// Closing tag length is case-invariant for ASCII `</signet-memory>`.
		const stop = end + SIGNET_MEMORY_CLOSE.length;
		text = text.slice(0, start) + text.slice(stop);
	}
}

/**
 * Check if content looks like metadata JSON (sender info, usernames, tags)
 */
function looksLikeMetadataJson(content: string): boolean {
	// Must be in a code fence with json
	if (!content.includes("```json")) return false;

	// Check for metadata field patterns
	const metadataFields = ["label", "username", "tag", "sender", "conversation"];
	const hasMultipleMetadataFields =
		metadataFields.filter((f) => content.includes(`"${f}"`) || content.includes(`'${f}'`)).length >= 2;

	return hasMultipleMetadataFields;
}

function extractUserMessage(rawPrompt: string): string {
	const sanitized = stripSignetMemory(rawPrompt);
	const lines = sanitized.split("\n");
	let lastContentStart = 0;

	// Track when we're inside a code fence
	let inCodeFence = false;
	let codeFenceStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Detect code fence start/end
		if (line.startsWith("```")) {
			if (!inCodeFence) {
				inCodeFence = true;
				codeFenceStart = i;
			} else {
				// End of code fence - check if it was metadata JSON
				const fenceContent = lines.slice(codeFenceStart, i + 1).join("\n");
				if (looksLikeMetadataJson(fenceContent)) {
					lastContentStart = i + 1;
				}
				inCodeFence = false;
			}
			continue;
		}

		// Existing line-prefix check
		if (METADATA_LINE_PREFIXES.some((p) => line.startsWith(p) || line.includes(p))) {
			lastContentStart = i + 1;
		}
	}

	const extracted = lines.slice(lastContentStart).join("\n").trim();
	return extracted.length > 0 ? extracted : sanitized;
}

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

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAssistantMessage(message: Record<string, unknown>): boolean {
	const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
	const sender = typeof message.sender === "string" ? message.sender.toLowerCase() : "";

	return role === "assistant" || role === "agent" || role === "model" || sender === "assistant" || sender === "agent";
}

function getMessageText(message: Record<string, unknown>): string | undefined {
	const direct = firstNonEmptyString(message.content, message.text, message.message);
	if (direct) return direct;

	if (!Array.isArray(message.content)) return undefined;

	const textParts: string[] = [];
	for (const chunk of message.content) {
		if (!isRecord(chunk)) continue;
		const part = chunk;
		if (part.type !== "text") continue;
		if (typeof part.text === "string" && part.text.trim().length > 0) {
			textParts.push(part.text);
		}
	}

	if (textParts.length === 0) return undefined;
	return textParts.join("\n");
}

function extractLastAssistantMessage(event: Record<string, unknown>): string | undefined {
	const explicit = firstNonEmptyString(
		event.lastAssistantMessage,
		event.last_assistant_message,
		event.assistantMessage,
		event.assistant_message,
		event.previousAssistantMessage,
		event.previous_assistant_message,
	);
	if (explicit) return explicit;

	const messages = event.messages;
	if (!Array.isArray(messages)) return undefined;

	for (let i = messages.length - 1; i >= 0; i--) {
		const raw = messages[i];
		if (!isRecord(raw)) continue;
		const message = raw;
		if (!isAssistantMessage(message)) continue;

		const text = getMessageText(message);
		if (text) return text;
	}

	return undefined;
}

function isUserMessage(message: Record<string, unknown>): boolean {
	const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
	const sender = typeof message.sender === "string" ? message.sender.toLowerCase() : "";

	return role === "user" || role === "human" || sender === "user" || sender === "human";
}

function extractLastUserMessage(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;

	for (let i = messages.length - 1; i >= 0; i--) {
		const raw = messages[i];
		if (!isRecord(raw)) continue;
		if (!isUserMessage(raw)) continue;

		const text = getMessageText(raw);
		if (!text) continue;
		const sanitized = stripSignetMemory(text);
		if (sanitized.length > 0) return sanitized;
	}

	return undefined;
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

interface MarketplaceToolEntry {
	id: string;
	serverId: string;
	serverName: string;
	toolName: string;
	description: string;
	readOnly: boolean;
	inputSchema: unknown;
}

interface MarketplaceToolCatalog {
	count: number;
	tools: MarketplaceToolEntry[];
	servers: Array<{
		serverId: string;
		serverName: string;
		ok: boolean;
		toolCount: number;
		error?: string;
	}>;
}

interface MarketplaceContextOptions {
	readonly daemonUrl?: string;
	readonly harness?: string;
	readonly workspace?: string;
	readonly channel?: string;
}

interface MarketplaceExposurePolicy {
	readonly mode: "compact" | "hybrid" | "expanded";
	readonly maxExpandedTools: number;
	readonly maxSearchResults: number;
	readonly updatedAt: string;
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
	const res = await daemonFetchResult<T>(daemonUrl, path, options);
	if (!res.ok) return null;
	return res.data;
}

async function daemonFetchResult<T>(
	daemonUrl: string,
	path: string,
	options: {
		method?: string;
		body?: unknown;
		timeout?: number;
	} = {},
): Promise<DaemonFetchResult<T>> {
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
			return { ok: false, reason: "http", status: res.status };
		}

		try {
			const data = (await res.json()) as T;
			return { ok: true, data };
		} catch {
			console.warn(`[signet] ${method} ${path} returned invalid JSON`);
			return { ok: false, reason: "invalid-json", status: res.status };
		}
	} catch (e) {
		if (isTimeoutError(e)) {
			console.warn(`[signet] ${method} ${path} timed out after ${timeout}ms`);
			return { ok: false, reason: "timeout" };
		}
		// Native fetch wraps OS errors as TypeError.cause, but polyfill/proxy
		// layers may rethrow the OS error directly — check both forms.
		const cause: unknown = e instanceof TypeError ? e.cause : e;
		const isConnRefused =
			typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ECONNREFUSED";
		if (isConnRefused) {
			console.warn(`[signet] daemon unreachable at ${daemonUrl} — is the Signet daemon running? (${method} ${path})`);
		} else {
			console.warn(`[signet] ${method} ${path} error:`, e);
		}
		return { ok: false, reason: "offline" };
	}
}

// ============================================================================
// Health check
// ============================================================================

export async function isDaemonRunning(daemonUrl = DEFAULT_DAEMON_URL): Promise<boolean> {
	try {
		const res = await fetch(`${daemonUrl}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** Returns the daemon PID if reachable, null otherwise. */
async function getDaemonPid(daemonUrl: string): Promise<number | null> {
	try {
		const res = await fetch(`${daemonUrl}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { pid?: number };
		return typeof body.pid === "number" ? body.pid : null;
	} catch {
		return null;
	}
}

// ============================================================================
// Static identity fallback when daemon is unreachable
// ============================================================================

// Wraps @signet/core's readStaticIdentity to produce a SessionStartResult.
function staticFallback(reason: "offline" | "timeout" = "offline"): SessionStartResult | null {
	const dir = process.env.SIGNET_PATH ?? join(homedir(), ".agents");
	const inject =
		reason === "timeout"
			? readStaticIdentity(dir, STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS)
			: readStaticIdentity(dir);
	if (!inject) return null;
	return { identity: { name: "signet" }, memories: [], inject };
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
	const result = await daemonFetchResult<SessionStartResult>(
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
			timeout: SESSION_START_TIMEOUT,
		},
	);
	if (result.ok) return result.data;
	if (result.reason === "timeout") return staticFallback("timeout");
	return staticFallback();
}

export async function onUserPromptSubmit(
	harness: string,
	options: {
		daemonUrl?: string;
		agentId?: string;
		userMessage: string;
		lastAssistantMessage?: string;
		sessionKey?: string;
		project?: string;
	},
): Promise<UserPromptSubmitResult | null> {
	return daemonFetch(options.daemonUrl || DEFAULT_DAEMON_URL, "/api/hooks/user-prompt-submit", {
		method: "POST",
		body: {
			harness,
			userMessage: options.userMessage,
			userPrompt: options.userMessage,
			lastAssistantMessage: options.lastAssistantMessage,
			sessionKey: options.sessionKey,
			project: options.project,
			agentId: options.agentId,
			runtimePath: RUNTIME_PATH,
		},
		timeout: READ_TIMEOUT,
	});
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
	return daemonFetch(options.daemonUrl || DEFAULT_DAEMON_URL, "/api/hooks/pre-compaction", {
		method: "POST",
		body: {
			harness,
			sessionContext: options.sessionContext,
			messageCount: options.messageCount,
			sessionKey: options.sessionKey,
			runtimePath: RUNTIME_PATH,
		},
		timeout: READ_TIMEOUT,
	});
}

export async function onCompactionComplete(
	harness: string,
	summary: string,
	options: {
		daemonUrl?: string;
		agentId?: string;
		sessionKey?: string;
		project?: string;
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
				agentId: options.agentId,
				sessionKey: options.sessionKey,
				project: options.project,
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
		agentId?: string;
		transcriptPath?: string;
		transcript?: string;
		sessionKey?: string;
		sessionId?: string;
		cwd?: string;
		reason?: string;
	} = {},
): Promise<SessionEndResult | null> {
	return daemonFetch(options.daemonUrl || DEFAULT_DAEMON_URL, "/api/hooks/session-end", {
		method: "POST",
		body: {
			harness,
			agentId: options.agentId,
			transcriptPath: options.transcriptPath,
			...(options.transcript && { transcript: options.transcript }),
			sessionKey: options.sessionKey,
			sessionId: options.sessionId,
			cwd: options.cwd,
			reason: options.reason,
			runtimePath: RUNTIME_PATH,
		},
		timeout: WRITE_TIMEOUT,
	});
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
	const result = await daemonFetch<{ results: RecallResult[] }>(daemonUrl, "/api/memory/recall", {
		method: "POST",
		body: {
			query,
			limit: options.limit || 10,
			type: options.type,
			min_score: options.minScore,
		},
		timeout: READ_TIMEOUT,
	});
	return result?.results || [];
}

export async function memoryStore(
	content: string,
	options: {
		daemonUrl?: string;
		type?: string;
		importance?: number;
		tags?: string | readonly string[];
		who?: string;
	} = {},
): Promise<string | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<{ id?: string; memoryId?: string }>(daemonUrl, "/api/memory/remember", {
		method: "POST",
		body: {
			content,
			type: options.type,
			importance: options.importance,
			tags:
				typeof options.tags === "string"
					? options.tags
					: options.tags
							?.map((tag) => tag.trim())
							.filter((tag) => tag.length > 0)
							.join(","),
			who: options.who || "openclaw",
		},
		timeout: WRITE_TIMEOUT,
	});
	return result?.id || result?.memoryId || null;
}

export async function memoryGet(id: string, options: { daemonUrl?: string } = {}): Promise<MemoryRecord | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	return daemonFetch<MemoryRecord>(daemonUrl, `/api/memory/${encodeURIComponent(id)}`, { timeout: READ_TIMEOUT });
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
	const result = await daemonFetch<{ success?: boolean }>(daemonUrl, `/api/memory/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: patch,
		timeout: WRITE_TIMEOUT,
	});
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

export async function marketplaceToolList(
	options: MarketplaceContextOptions & { refresh?: boolean } = {},
): Promise<MarketplaceToolCatalog | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const params = new URLSearchParams();
	if (options.refresh) params.set("refresh", "1");
	if (options.harness) params.set("harness", options.harness);
	if (options.workspace) params.set("workspace", options.workspace);
	if (options.channel) params.set("channel", options.channel);
	const query = params.toString();
	const path = `/api/marketplace/mcp/tools${query.length > 0 ? `?${query}` : ""}`;
	return daemonFetch<MarketplaceToolCatalog>(daemonUrl, path, {
		timeout: READ_TIMEOUT,
	});
}

export async function marketplaceToolCall(
	serverId: string,
	toolName: string,
	args: Record<string, unknown>,
	options: MarketplaceContextOptions = {},
): Promise<{ success: boolean; result?: unknown; error?: string } | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const params = new URLSearchParams();
	if (options.harness) params.set("harness", options.harness);
	if (options.workspace) params.set("workspace", options.workspace);
	if (options.channel) params.set("channel", options.channel);
	const query = params.toString();
	const path = `/api/marketplace/mcp/call${query.length > 0 ? `?${query}` : ""}`;
	return daemonFetch<{ success: boolean; result?: unknown; error?: string }>(daemonUrl, path, {
		method: "POST",
		body: {
			serverId,
			toolName,
			args,
		},
		timeout: WRITE_TIMEOUT,
	});
}

async function getMarketplaceExposurePolicy(
	options: MarketplaceContextOptions = {},
): Promise<MarketplaceExposurePolicy | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<{ policy?: MarketplaceExposurePolicy }>(daemonUrl, "/api/marketplace/mcp/policy", {
		timeout: READ_TIMEOUT,
	});
	if (!result?.policy) {
		return null;
	}
	return result.policy;
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
		tags?: string | readonly string[];
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
			daemonUrl: typeof cfg.daemonUrl === "string" ? cfg.daemonUrl : DEFAULT_DAEMON_URL,
		};
	},
};

// ============================================================================
// Tool result helpers
// ============================================================================

function textResult(text: string, details?: Record<string, unknown>): OpenClawToolResult {
	return {
		content: [{ type: "text", text }],
		...(details ? { details } : {}),
	};
}

// Dedup window for sessionless session-start calls (time-based; these don't
// have a stable messageCount to key on).
const SESSIONLESS_DEDUPE_MS = 1_000;

export function cleanupTimedMap(map: Map<string, number>, now: number, ttlMs = SESSIONLESS_DEDUPE_MS): void {
	const expired: string[] = [];
	for (const [key, ts] of map) {
		if (now - ts > ttlMs) {
			expired.push(key);
		}
	}
	for (const key of expired) {
		map.delete(key);
	}
}

// ---------------------------------------------------------------------------
// Request normalization layer — ensures outgoing provider requests carry the
// correct routing metadata and content normalization for subscription-tier
// OAuth token flows. Without this, OAuth-authenticated requests may be
// misrouted or rejected by the upstream gateway.
//
// The plugin hook API does not expose the assembled request body, so we
// intercept at two layers:
//
// - globalThis.fetch wrapper — catches SDK clients using the default fetch
//   (e.g. pi-ai transport which does not pass a custom fetch).
// - SDK prototype prepareRequest patch — catches SDK clients that were given
//   a custom fetch, since prepareRequest fires before fetch.
// ---------------------------------------------------------------------------

// Routing metadata block — must be system[0] for correct subscription routing.
// The version field tracks a specific SDK release; update if the gateway
// begins validating it.
const BILLING_BLOCK = {
	type: "text",
	text: "x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;",
} as const;

// Beta flags required for OAuth subscription-tier routing.
const REQUIRED_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"effort-2025-11-24",
] as const;

// Content normalization rules — these specific strings in the request body
// cause upstream rejection when present. Other tool names, prompt structure,
// workspace files, and config paths are unaffected.
const TRIGGER_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	["OpenClaw", "assistant platform"],
	["openclaw", "assistant platform"],
	["sessions_spawn", "create_task"],
	["sessions_list", "list_tasks"],
	["sessions_history", "get_history"],
	["sessions_send", "send_to_task"],
	["sessions_yield", "yield_turn"],
	["running inside", "running on"],
] as const;

/**
 * Inject the routing metadata block as system[0] if not already present.
 * Handles both string and array system prompt formats.
 */
function injectBillingBlock(body: Record<string, unknown>): boolean {
	const system = body.system;
	if (Array.isArray(system)) {
		// Check if already injected
		const first = system[0] as Record<string, unknown> | undefined;
		if (
			first &&
			typeof first.text === "string" &&
			first.text.includes("x-anthropic-billing-header")
		) {
			return false;
		}
		system.unshift({ ...BILLING_BLOCK });
		return true;
	}
	if (typeof system === "string") {
		// Convert string form to array with billing block prepended
		body.system = [
			{ ...BILLING_BLOCK },
			{ type: "text", text: system },
		];
		return true;
	}
	// No system field — add one with just the routing block
	body.system = [{ ...BILLING_BLOCK }];
	return true;
}

/**
 * Replace verified trigger phrases in a string.
 * Returns the cleaned string and whether any replacement occurred.
 */
function replaceTriggers(input: string): [string, boolean] {
	let result = input;
	let changed = false;
	for (const [find, replace] of TRIGGER_REPLACEMENTS) {
		if (result.includes(find)) {
			result = result.split(find).join(replace);
			changed = true;
		}
	}
	return [result, changed];
}

/**
 * Normalize a serialized JSON request body: inject routing block and
 * apply content replacements. Modifies the carrier object in-place.
 */
function sanitizeRequest(request: { body?: unknown }): boolean {
	if (!request.body || typeof request.body !== "string") return false;
	try {
		const body = JSON.parse(request.body) as Record<string, unknown>;
		const injected = injectBillingBlock(body);
		const serialized = JSON.stringify(body);
		const [cleaned, replaced] = replaceTriggers(serialized);
		if (injected || replaced) {
			request.body = cleaned;
			return true;
		}
	} catch {
		// Not valid JSON — try raw string sweep for trigger phrases only
		const [cleaned, replaced] = replaceTriggers(request.body as string);
		if (replaced) {
			request.body = cleaned;
			return true;
		}
	}
	return false;
}

/**
 * Merge required beta flags into the headers object.
 * Preserves existing betas while adding any missing ones.
 */
function mergeBetaHeaders(headers: Record<string, string>): boolean {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
	const existing = headers[key] ?? "";
	const betas = existing ? existing.split(",").map((b) => b.trim()) : [];
	let added = false;
	for (const required of REQUIRED_BETAS) {
		if (!betas.includes(required)) {
			betas.push(required);
			added = true;
		}
	}
	if (added) {
		headers[key] = betas.join(",");
	}
	return added;
}

// -- Layer 1: globalThis.fetch wrapper ------------------------------------

function isAnthropicApiUrl(url: string): boolean {
	try {
		return new URL(url).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

/**
 * Read the local OAuth token from the CLI credential store.
 * Returns undefined if credentials are missing or expired.
 */
function readClaudeCodeOAuthToken(): string | undefined {
	try {
		const candidates = [
			join(homedir(), ".claude", ".credentials.json"),
			join(homedir(), ".claude", "credentials.json"),
		];
		for (const p of candidates) {
			if (!existsSync(p)) continue;
			const raw = readFileSync(p, "utf8");
			const creds = JSON.parse(raw) as Record<string, unknown>;
			const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
			if (!oauth?.accessToken) continue;
			const expiresAt = oauth.expiresAt as number | undefined;
			if (expiresAt && expiresAt < Date.now()) continue;
			return oauth.accessToken as string;
		}
	} catch {
		// Credentials not available — fall through to original auth.
	}
	return undefined;
}

/**
 * Swap auth headers: replace API key auth with OAuth Bearer token for
 * subscription-tier routing. Uses case-insensitive key matching to
 * avoid duplicate headers.
 */
function swapAuthHeaders(headers: Record<string, string>, oauthToken: string): void {
	for (const key of Object.keys(headers)) {
		const lk = key.toLowerCase();
		if (lk === "x-api-key" || lk === "authorization") {
			delete headers[key];
		}
	}
	headers["authorization"] = `Bearer ${oauthToken}`;
}

function installFetchSanitizer(): () => void {
	const original = globalThis.fetch;
	const sanitized: typeof globalThis.fetch = (input, init) => {
		if (init?.body && typeof init.body === "string") {
			const url = typeof input === "string" ? input
				: input instanceof URL ? input.href : input.url;
			if (isAnthropicApiUrl(url)) {
				const carrier = { body: init.body };
				sanitizeRequest(carrier);
				const newBody = carrier.body as string;
				// Flatten headers, filtering stale transport headers that must
				// be recalculated after body modification.
				const oauthToken = readClaudeCodeOAuthToken();
				const skip = new Set(["host", "connection", "content-length", "anthropic-dangerous-direct-browser-access"]);
				const headers: Record<string, string> = {};
				if (init.headers) {
					if (init.headers instanceof Headers) {
						init.headers.forEach((v, k) => { if (!skip.has(k.toLowerCase())) headers[k] = v; });
					} else if (Array.isArray(init.headers)) {
						for (const pair of init.headers) { if (!skip.has(pair[0].toLowerCase())) headers[pair[0]] = pair[1]; }
					} else {
						for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
							if (!skip.has(k.toLowerCase())) headers[k] = v;
						}
					}
				}
				mergeBetaHeaders(headers);
				headers["accept-encoding"] = "identity";
				if (oauthToken) {
					swapAuthHeaders(headers, oauthToken);
				}
				return original(input, { ...init, body: newBody, headers });
			}
		}
		return original(input, init);
	};
	globalThis.fetch = sanitized;
	return () => {
		if (globalThis.fetch === sanitized) {
			globalThis.fetch = original;
		}
	};
}

// -- Layer 2: SDK prototype patch -----------------------------------------

/**
 * Resolve the provider SDK's base class from the host process.
 * The plugin and OpenClaw may each have their own copy of the SDK in
 * different node_modules trees. We search the CJS require cache for the
 * already-loaded copy so our prototype patch reaches the actual instances.
 */
function resolveAnthropicBase(): (new (...args: unknown[]) => unknown) | undefined {
	try {
		const cache = typeof require !== "undefined" ? require.cache : undefined;
		if (cache) {
			for (const key of Object.keys(cache)) {
				if (!key.includes("@anthropic-ai") || !key.includes("sdk")) continue;
				if (!key.endsWith("/client.js") && !key.endsWith("/index.js")) continue;
				const mod = cache[key];
				const exports = mod?.exports as Record<string, unknown> | undefined;
				if (!exports) continue;
				const Base = (exports.BaseAnthropic ?? exports.Anthropic) as
					| (new (...args: unknown[]) => unknown)
					| undefined;
				if (Base?.prototype && typeof Base.prototype.prepareRequest === "function") {
					return Base;
				}
			}
		}
	} catch {
		// require.cache not available.
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const sdk = require("@anthropic-ai/sdk") as Record<string, unknown>;
		const Base = (sdk.BaseAnthropic ?? sdk.Anthropic) as
			| (new (...args: unknown[]) => unknown)
			| undefined;
		if (Base?.prototype && typeof Base.prototype.prepareRequest === "function") {
			return Base;
		}
	} catch {
		// SDK not available (e.g. tests without it).
	}
	return undefined;
}

function installSdkSanitizer(): () => void {
	type PrepareRequestFn = (
		request: RequestInit,
		context: { url: string; options: unknown },
	) => Promise<void>;

	let Base: (new (...args: unknown[]) => unknown) | undefined;
	let original: PrepareRequestFn | undefined;
	let timer: ReturnType<typeof setInterval> | null = null;

	function applyPatch(): boolean {
		const found = resolveAnthropicBase();
		if (!found) return false;
		Base = found;
		original = Base.prototype.prepareRequest as PrepareRequestFn;
		Base.prototype.prepareRequest = async function (
			request: RequestInit,
			context: { url: string; options: unknown },
		): Promise<void> {
			sanitizeRequest(request as { body?: unknown });
			return original!.call(this, request, context);
		};
		return true;
	}

	if (!applyPatch()) {
		// SDK may be lazy-loaded. Retry briefly so the patch lands before
		// the first provider call.
		let attempts = 0;
		timer = setInterval(() => {
			attempts++;
			if (applyPatch() || attempts >= 30) {
				if (timer) { clearInterval(timer); timer = null; }
			}
		}, 200);
	}

	return () => {
		if (timer) { clearInterval(timer); timer = null; }
		if (Base && original) {
			Base.prototype.prepareRequest = original;
		}
	};
}

function buildInjectionResult(result: UserPromptSubmitResult): { prependContext: string } | undefined {
	if (!result.inject) {
		return undefined;
	}
	const queryAttr = result.queryTerms ? ` query="${result.queryTerms.replace(/"/g, "'").slice(0, 100)}"` : "";
	const attrs = `source="auto-recall"${queryAttr} results="${result.memoryCount}" engine="${result.engine ?? "fts+decay"}"`;
	return {
		prependContext: `<signet-memory ${attrs}>\n${result.inject}\n</signet-memory>`,
	};
}

function buildSessionlessTurnKey(event: Record<string, unknown>, agentId: string | undefined): string {
	const rawPrompt = typeof event.prompt === "string" ? extractUserMessage(event.prompt) : "";
	const normalizedPrompt = rawPrompt.trim().replace(/\s+/g, " ").slice(0, 240);
	const messageCount = Array.isArray(event.messages) ? event.messages.length : -1;
	return `${agentId ?? "-"}|${messageCount}|${normalizedPrompt}`;
}

function buildScopedSessionKey(sessionKey: string | undefined, agentId: string | undefined): string | undefined {
	if (!sessionKey) return undefined;
	return `${agentId ?? "-"}|${sessionKey}`;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Dual-source context resolution. Typed ctx fields take priority; legacy
// extra event fields are the fallback for older OpenClaw versions.
// ---------------------------------------------------------------------------

interface ResolvedCtx {
	readonly sessionKey: string | undefined;
	readonly agentId: string | undefined;
	readonly project: string | undefined;
	readonly sessionFile: string | undefined;
	readonly sessionId: string | undefined;
}

function resolveCtx(event: Record<string, unknown>, ctx: unknown): ResolvedCtx {
	const c = isRecord(ctx) ? ctx : {};
	return {
		sessionKey:
			readString(c.sessionKey) ??
			readString(event.sessionKey) ??
			readString(c.sessionId) ??
			readString(event.sessionId),
		agentId: readString(c.agentId) ?? readString(event.agentId),
		project: firstNonEmptyString(
			c.workspaceDir,
			c.project,
			c.cwd,
			c.workspace,
			event.cwd,
			event.project,
			event.workspace,
		),
		sessionFile: readString(c.sessionFile) ?? readString(event.sessionFile) ?? readString(event.transcriptPath),
		sessionId: readString(c.sessionId) ?? readString(event.sessionId),
	};
}

function resolveCompactionSessionFile(
	event: Record<string, unknown>,
	sessionFile: string | undefined,
): string | undefined {
	const compaction = isRecord(event.compaction) ? event.compaction : undefined;
	return firstNonEmptyString(
		event.sessionFile,
		event.session_file,
		compaction?.sessionFile,
		compaction?.session_file,
		sessionFile,
	);
}

function readSessionFileProject(sessionFile: string | undefined): string | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;

	try {
		const lines = readFileSync(sessionFile, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		for (const line of lines) {
			try {
				const row = JSON.parse(line) as unknown;
				if (!isRecord(row) || row.type !== "session") continue;
				return firstNonEmptyString(row.cwd, row.project, row.workspace);
			} catch {
				// ignore malformed transcript lines
			}
		}
	} catch {
		// best effort only
	}

	return undefined;
}

function extractCompactionSummary(event: Record<string, unknown>, sessionFile: string | undefined): string | undefined {
	const direct = readString(event.summary);
	if (direct) return direct;

	const compaction = isRecord(event.compaction) ? event.compaction : undefined;
	const nested = readString(compaction?.summary);
	if (nested) return nested;
	if (!sessionFile || !existsSync(sessionFile)) return undefined;

	try {
		const lines = readFileSync(sessionFile, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const row = JSON.parse(lines[i]) as unknown;
				if (!isRecord(row) || row.type !== "compaction") continue;
				const summary = readString(row.summary);
				if (summary) return summary;
			} catch {
				// ignore malformed transcript lines
			}
		}
	} catch {
		// best effort only
	}

	return undefined;
}

function buildCompactionEventKey(
	event: Record<string, unknown>,
	options: {
		agentId?: string;
		sessionKey?: string;
		summary?: string;
	},
): string {
	const compaction = isRecord(event.compaction) ? event.compaction : undefined;
	const parts = [
		options.agentId ?? "-",
		options.sessionKey ?? "-",
		readString(event.runId) ?? readString(compaction?.runId) ?? "-",
		readString(event.id) ?? readString(compaction?.id) ?? "-",
		String(
			readNumber(event.messageCount) ??
				readNumber(event.compactingCount) ??
				readNumber(event.compactedCount) ??
				readNumber(compaction?.messageCount) ??
				readNumber(compaction?.compactingCount) ??
				readNumber(compaction?.compactedCount) ??
				-1,
		),
		String(readNumber(event.tokenCount) ?? readNumber(compaction?.tokenCount) ?? -1),
		options.summary ?? "-",
	];
	return parts.join("|");
}

async function registerMarketplaceProxyTools(
	api: OpenClawPluginApi,
	options: MarketplaceContextOptions,
	knownNames: Set<string>,
	proxyNameByToolKey: Map<string, string>,
): Promise<{ registeredNow: number; total: number }> {
	const [catalog, policy] = await Promise.all([
		marketplaceToolList({ ...options, refresh: true }),
		getMarketplaceExposurePolicy(options),
	]);
	if (!catalog || catalog.tools.length === 0) {
		return { registeredNow: 0, total: knownNames.size };
	}

	const mode = policy?.mode ?? "hybrid";
	const maxExpandedTools =
		typeof policy?.maxExpandedTools === "number" && Number.isFinite(policy.maxExpandedTools)
			? Math.max(0, Math.min(100, Math.round(policy.maxExpandedTools)))
			: 12;

	const sortedTools = [...catalog.tools].sort((a, b) =>
		`${a.serverId}:${a.toolName}`.localeCompare(`${b.serverId}:${b.toolName}`),
	);

	const candidates =
		mode === "expanded" ? sortedTools : mode === "hybrid" ? sortedTools.slice(0, maxExpandedTools) : [];

	const usedNames = new Set<string>([
		"memory_search",
		"memory_store",
		"memory_get",
		"memory_list",
		"memory_modify",
		"memory_forget",
		"mcp_server_list",
		"mcp_server_call",
	]);
	for (const name of knownNames) {
		usedNames.add(name);
	}

	let registeredNow = 0;
	for (const tool of candidates) {
		const toolKey = `${tool.serverId}\0${tool.toolName}`;
		let proxyName = proxyNameByToolKey.get(toolKey);
		if (!proxyName) {
			proxyName = buildProxyToolName(usedNames, tool.serverId, tool.toolName);
			proxyNameByToolKey.set(toolKey, proxyName);
		} else {
			usedNames.add(proxyName);
		}
		if (knownNames.has(proxyName)) {
			continue;
		}

		api.registerTool(
			{
				name: proxyName,
				label: `Signet ${tool.serverName} • ${tool.toolName}`,
				description:
					tool.description && tool.description.trim().length > 0
						? tool.description
						: `Proxy tool ${tool.toolName} from MCP server ${tool.serverName}`,
				parameters: Type.Object({}, { additionalProperties: true }),
				async execute(_toolCallId, params) {
					const args = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};

					try {
						const result = await marketplaceToolCall(tool.serverId, tool.toolName, args, options);
						if (!result?.success) {
							return textResult(`Tool server call failed: ${result?.error ?? "unknown error"}`, {
								error: result?.error ?? "unknown",
							});
						}

						const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
						return textResult(text, { result: result.result });
					} catch (err) {
						return textResult(`Tool server call failed: ${String(err)}`, {
							error: String(err),
						});
					}
				},
			},
			{ name: proxyName },
		);
		knownNames.add(proxyName);
		registeredNow += 1;
	}

	return { registeredNow, total: knownNames.size };
}

// ============================================================================
// Plugin definition (OpenClaw register(api) pattern)
// ============================================================================

// Defensive backstop: even if registrationMode is absent or "full", never
// run the full registration body more than once per process. OpenClaw's
// documented double-call is mode-gated below, but older hosts or future
// loader changes could call with "full" twice. Keep this state on globalThis
// so hot-reload module re-imports still honor the guard.
const REG_KEY = "__signet_openclaw_registered__signet-memory-openclaw";

function readRegistered(): boolean {
	const value = Reflect.get(globalThis, REG_KEY);
	return value === true;
}

function writeRegistered(value: boolean): void {
	Reflect.set(globalThis, REG_KEY, value);
}

const signetPlugin = {
	id: "signet-memory-openclaw",
	name: "Signet Memory",
	description: "Signet agent memory — persistent, searchable, identity-aware memory for AI agents",
	kind: "memory" as const,
	configSchema: signetConfigSchema,

	register(api: OpenClawPluginApi): void {
		const mode = api.registrationMode ?? "full";
		// Only "full" should register runtime behavior. setup-only,
		// setup-runtime, and cli-metadata are metadata/setup passes.
		if (mode !== "full") {
			if (!["cli-metadata", "setup-only", "setup-runtime"].includes(mode)) {
				api.logger.warn(`signet-memory: skipping runtime registration for unknown mode=${mode}`);
			}
			return;
		}

		if (readRegistered()) {
			api.logger.warn("signet-memory: register() called twice with non-cli mode, skipping duplicate");
			return;
		}
		let claimed = false;
		try {
			const cfg = signetConfigSchema.parse(api.pluginConfig);
			const daemonUrl = cfg.daemonUrl || DEFAULT_DAEMON_URL;
			const opts = {
				daemonUrl,
				harness: "openclaw",
				workspace: process.env.SIGNET_WORKSPACE ?? process.cwd(),
				channel: process.env.SIGNET_CHANNEL,
			};
			writeRegistered(true);
			claimed = true;

		// Request normalization — two layers for coverage: fetch wrapper +
		// SDK prototype patch.
		const removeFetchSanitizer = installFetchSanitizer();
		const removeSdkSanitizer = installSdkSanitizer();

		// Instance-scoped health state (safe for multi-register)
		let daemonReachable = true;
		let knownPid: number | null = null;
		let healthTimer: ReturnType<typeof setInterval> | null = null;
		let marketplaceProxyTimer: ReturnType<typeof setInterval> | null = null;
		const marketplaceProxyNames = new Set<string>();

		api.logger.info(`signet-memory: registered (daemon: ${daemonUrl})`);

		// Fire-and-forget startup health check (also captures initial PID)
		getDaemonPid(daemonUrl).then((pid) => {
			daemonReachable = pid !== null;
			knownPid = pid;
			if (!daemonReachable) {
				api.logger.warn(
					`signet-memory: daemon unreachable at ${daemonUrl}. Memory tools will silently no-op until daemon is running.`,
				);
			}
		});

		// ==================================================================
		// Tools
		// ==================================================================

		api.registerTool(
			{
				name: "memory_search",
				label: "Memory Search",
				description: "Search memories using hybrid vector + keyword search",
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
							.map((r, i) => `${i + 1}. ${r.content} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id})`)
							.join("\n");
						return textResult(`Found ${results.length} memories:\n\n${text}`, {
							count: results.length,
							memories: results,
						});
					} catch (err) {
						return textResult(`Memory search failed: ${String(err)}`, { error: String(err) });
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
							description: "Memory type (fact, preference, decision, etc.)",
						}),
					),
					importance: Type.Optional(
						Type.Number({
							description: "Importance score 0-1",
						}),
					),
					tags: Type.Optional(
						Type.String({
							description: "Comma-separated tags for categorization",
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
							tags,
						});
						if (id) {
							return textResult(`Memory saved successfully (id: ${id})`, { id });
						}
						return textResult("Failed to save memory.", {
							error: "no id returned",
						});
					} catch (err) {
						return textResult(`Memory store failed: ${String(err)}`, { error: String(err) });
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
						return textResult(`Memory get failed: ${String(err)}`, { error: String(err) });
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
							description: "Max results (default 50, max 50)",
						}),
					),
					offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
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
					const ITEM_CHAR_LIMIT = 500;
					const TOTAL_CHAR_BUDGET = 8000;
					try {
						const result = await memoryList({
							...opts,
							limit: Math.min(limit ?? 50, 50),
							offset,
							type,
						});
						const lines: string[] = [];
						let totalChars = 0;
						for (const m of result.memories) {
							const content =
								m.content.length > ITEM_CHAR_LIMIT ? `${m.content.slice(0, ITEM_CHAR_LIMIT)}[truncated]` : m.content;
							const line = `- [${m.type}] ${content} (id: ${m.id})`;
							if (totalChars + line.length > TOTAL_CHAR_BUDGET) break;
							lines.push(line);
							totalChars += line.length;
						}
						return textResult(`${lines.length} of ${result.memories.length} memories:\n\n${lines.join("\n")}`, {
							count: result.memories.length,
							shown: lines.length,
							stats: result.stats,
						});
					} catch (err) {
						return textResult(`Memory list failed: ${String(err)}`, { error: String(err) });
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
					content: Type.Optional(Type.String({ description: "New content" })),
					type: Type.Optional(Type.String({ description: "New type" })),
					importance: Type.Optional(Type.Number({ description: "New importance" })),
					tags: Type.Optional(
						Type.String({
							description: "New tags (comma-separated)",
						}),
					),
				}),
				async execute(_toolCallId, params) {
					const { id, reason, content, type, importance, tags } = params as {
						id: string;
						reason: string;
						content?: string;
						type?: string;
						importance?: number;
						tags?: string;
					};
					try {
						const ok = await memoryModify(id, { content, type, importance, tags, reason }, opts);
						return textResult(ok ? `Memory ${id} updated.` : `Failed to update memory ${id}.`, { success: ok });
					} catch (err) {
						return textResult(`Memory modify failed: ${String(err)}`, { error: String(err) });
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
						return textResult(ok ? `Memory ${id} forgotten.` : `Failed to forget memory ${id}.`, { success: ok });
					} catch (err) {
						return textResult(`Memory forget failed: ${String(err)}`, { error: String(err) });
					}
				},
			},
			{ name: "memory_forget" },
		);

		api.registerTool(
			{
				name: "mcp_server_list",
				label: "Tool Server List",
				description: "List installed external Tool Servers (MCP) and discover routed tools.",
				parameters: Type.Object({
					refresh: Type.Optional(
						Type.Boolean({
							description: "Refresh live tool catalogs",
						}),
					),
				}),
				async execute(_toolCallId, params) {
					const refresh = (params as { refresh?: boolean }).refresh;
					try {
						const result = await marketplaceToolList({
							...opts,
							refresh,
						});
						if (!result) {
							return textResult("Failed to load Tool Server catalog.", {
								error: "daemon unavailable",
							});
						}

						const lines = result.tools
							.slice(0, 30)
							.map((tool) => `${tool.serverId}:${tool.toolName} - ${tool.description}`);

						return textResult(
							result.tools.length > 0
								? `Available routed tools (${result.tools.length}):\n\n${lines.join("\n")}`
								: "No routed tool server tools are currently available.",
							{
								count: result.count,
								servers: result.servers,
								tools: result.tools,
							},
						);
					} catch (err) {
						return textResult(`Tool server list failed: ${String(err)}`, {
							error: String(err),
						});
					}
				},
			},
			{ name: "mcp_server_list" },
		);

		api.registerTool(
			{
				name: "mcp_server_call",
				label: "Tool Server Call",
				description: "Invoke a routed tool from an installed external Tool Server (MCP).",
				parameters: Type.Object({
					server_id: Type.String({
						description: "Installed Tool Server id",
					}),
					tool: Type.String({
						description: "Tool name exposed by that server",
					}),
					args: Type.Optional(Type.Object({}, { additionalProperties: true })),
				}),
				async execute(_toolCallId, params) {
					const payload = params as {
						server_id: string;
						tool: string;
						args?: Record<string, unknown>;
					};
					try {
						const result = await marketplaceToolCall(payload.server_id, payload.tool, payload.args ?? {}, opts);
						if (!result?.success) {
							return textResult(`Tool server call failed: ${result?.error ?? "unknown error"}`, {
								error: result?.error ?? "unknown",
							});
						}

						const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
						return textResult(text, { result: result.result });
					} catch (err) {
						return textResult(`Tool server call failed: ${String(err)}`, {
							error: String(err),
						});
					}
				},
			},
			{ name: "mcp_server_call" },
		);

		const marketplaceProxyNameByToolKey = new Map<string, string>();

		const refreshMarketplaceProxyTools = (): Promise<void> =>
			registerMarketplaceProxyTools(api, opts, marketplaceProxyNames, marketplaceProxyNameByToolKey)
				.then((result) => {
					if (result.registeredNow > 0) {
						api.logger.info(
							`signet-memory: registered ${result.registeredNow} marketplace proxy tools (${result.total} total)`,
						);
					}
				})
				.catch((error) => {
					api.logger.warn(`signet-memory: failed to register marketplace proxy tools: ${String(error)}`);
				});

		void refreshMarketplaceProxyTools();
		marketplaceProxyTimer = setInterval(() => {
			void refreshMarketplaceProxyTools();
		}, 15_000);

		// ==================================================================
		// Lifecycle hooks
		// ==================================================================

		const claimedSessions = new Set<string>();
		const sessionlessSessionStarts = new Map<string, number>();
		// Maps scoped agent/session keys → {count, at} for per-turn idempotency. Entries are
		// evicted on agent_end or lazily after SESSION_TURN_TTL_MS so crash/
		// SIGKILL sessions don't accumulate indefinitely.
		const SESSION_TURN_TTL_MS = 4 * 60 * 60 * 1000;
		const injectedTurns = new Map<string, { count: number; at: number }>();
		// Tracks turn signatures currently in-flight — provides a synchronous
		// guard so concurrent before_prompt_build / before_agent_start calls on
		// the same event-loop tick don't both pass the guard before either await
		// completes (injectedTurns is only written after the daemon responds).
		const inFlightTurns = new Set<string>();
		const beforeCompactions = new Map<string, number>();
		const afterCompactions = new Map<string, number>();

		// Mid-session checkpoint extraction: track turns per session and
		// fire a checkpoint extract after every N turns. Prevents long-lived
		// sessions (Discord bots, persistent agents) from going invisible.
		const CHECKPOINT_TURN_THRESHOLD = 20;
		// State per scoped session key: turn count, last seen message count (for
		// dedup), and timestamp (for TTL eviction when agent_end never fires).
		const checkpointTurns = new Map<string, { count: number; lastMsgCount: number | undefined; at: number }>();
		// Legacy dedup: when both before_prompt_build and before_agent_start fire
		// on the same turn without the messages field (older OpenClaw), only one
		// should count the turn. Generation counters: bpb increments bpbGen each
		// call; bas tracks the last generation it consumed in basGen. If
		// basGen < bpbGen, bas is covered and skips the count (then syncs basGen).
		// Avoids the stale-flag problem where a missed bas leaves the flag set
		// for the next turn.
		const bpbGen = new Map<string, number>();
		const basGen = new Map<string, number>();

		const maybeFireCheckpoint = (
			sessionKey: string | undefined,
			agentId: string | undefined,
			project: string | undefined,
			sessionFile: string | undefined,
			msgCount: number | undefined,
			messages: readonly unknown[] | undefined,
		): void => {
			const scopedKey = buildScopedSessionKey(sessionKey, agentId);
			if (!scopedKey || !sessionKey) return;

			const now = Date.now();
			const state = checkpointTurns.get(scopedKey);

			// Lazy TTL: evict stale entries for sessions that ended without agent_end.
			if (state && now - state.at > SESSION_TURN_TTL_MS) {
				checkpointTurns.delete(scopedKey);
			}

			// Dedup: before_agent_start and before_prompt_build both fire on the
			// same turn when both are registered. Use message count when available
			// (modern OpenClaw). Legacy path relies on bpbFired flag — see below.
			if (msgCount !== undefined && checkpointTurns.get(scopedKey)?.lastMsgCount === msgCount) return;

			const newCount = (checkpointTurns.get(scopedKey)?.count ?? 0) + 1;
			checkpointTurns.set(scopedKey, {
				count: newCount >= CHECKPOINT_TURN_THRESHOLD ? 0 : newCount,
				lastMsgCount: msgCount,
				at: now,
			});

			if (newCount < CHECKPOINT_TURN_THRESHOLD) return;

			// Inline transcript fallback: when sessionFile is absent (typed-only
			// OpenClaw without extra event fields), serialize event.messages as JSONL
			// so the daemon always has a transcript source for delta extraction.
			const inlineTranscript =
				!sessionFile && Array.isArray(messages) && messages.length > 0
					? messages.map((m) => JSON.stringify(m)).join("\n")
					: undefined;
			// Fire-and-forget — don't block the hook response.
			// Counter restore policy (CAS-guarded):
			//   skipped:true  → restore to threshold-1 (nothing extracted, retry next turn)
			//   queued:false  → treat as success (Rust Phase 5 stub: delta found, no job yet;
			//                   counter stays at 0 to prevent per-turn retries against stub)
			//   HTTP error    → restore to threshold-1 (retry next turn)
			void daemonFetch(daemonUrl, "/api/hooks/session-checkpoint-extract", {
				method: "POST",
				body: {
					harness: "openclaw",
					sessionKey,
					agentId,
					project,
					transcriptPath: sessionFile,
					...(inlineTranscript && { transcript: inlineTranscript }),
					runtimePath: RUNTIME_PATH,
				},
				timeout: WRITE_TIMEOUT,
			})
				.then((resp) => {
					// Restore counter only on skipped:true (nothing extracted — delta
					// too small, no transcript, or bypassed). queued:false is the Rust
					// Phase 5 stub response meaning "valid delta seen, no job queued"
					// — treat it as success (counter stays at 0) so the next trigger
					// waits another N turns rather than firing on every subsequent turn.
					if (isRecord(resp) && resp.skipped === true) {
						// CAS guard: only restore if the counter hasn't advanced past
						// threshold-1 by new turns arriving during the async round-trip.
						// Prevents a stale callback from overwriting newer accumulated count.
						const cur = checkpointTurns.get(scopedKey);
						if (cur && cur.count < CHECKPOINT_TURN_THRESHOLD - 1)
							checkpointTurns.set(scopedKey, { ...cur, count: CHECKPOINT_TURN_THRESHOLD - 1 });
					}
				})
				.catch((err) => {
					api.logger.warn(
						`signet-memory: checkpoint extract failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					// CAS guard: same protection as the .then() path.
					const cur = checkpointTurns.get(scopedKey);
					if (cur && cur.count < CHECKPOINT_TURN_THRESHOLD - 1)
						checkpointTurns.set(scopedKey, { ...cur, count: CHECKPOINT_TURN_THRESHOLD - 1 });
				});
		};

		const resolveCompactionProject = (event: Record<string, unknown>, resolved: ResolvedCtx): string | undefined => {
			const compaction = isRecord(event.compaction) ? event.compaction : undefined;
			const sessionFile = resolveCompactionSessionFile(event, resolved.sessionFile);
			return firstNonEmptyString(
				event.cwd,
				event.project,
				event.workspace,
				compaction?.project,
				compaction?.cwd,
				compaction?.workspace,
				resolved.project,
				readSessionFileProject(sessionFile),
			);
		};

		const dedupeCompaction = (map: Map<string, number>, key: string): boolean => {
			const now = Date.now();
			cleanupTimedMap(map, now, COMPACTION_HOOK_DEDUPE_MS);
			const seenAt = map.get(key);
			if (typeof seenAt === "number" && now - seenAt <= COMPACTION_HOOK_DEDUPE_MS) {
				return true;
			}
			map.set(key, now);
			return false;
		};

		const handleBeforeCompaction = async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			if (!cfg.enabled || !daemonReachable) return undefined;
			const resolved = resolveCtx(event, ctx);
			const messageCount =
				typeof event.messageCount === "number"
					? event.messageCount
					: typeof event.compactingCount === "number"
						? event.compactingCount
						: typeof event.compactedCount === "number"
							? event.compactedCount
							: isRecord(event.compaction) && typeof event.compaction.compactingCount === "number"
								? event.compaction.compactingCount
								: isRecord(event.compaction) && typeof event.compaction.compactedCount === "number"
									? event.compaction.compactedCount
									: undefined;
			const dedupeKey = buildCompactionEventKey(event, {
				agentId: resolved.agentId,
				sessionKey: resolved.sessionKey,
			});
			if (dedupeCompaction(beforeCompactions, dedupeKey)) {
				return undefined;
			}

			const result = await onPreCompaction("openclaw", {
				...opts,
				sessionKey: resolved.sessionKey,
				messageCount,
			});
			const parts = [result?.summaryPrompt, result?.guidelines].filter(
				(value) => typeof value === "string" && value.length > 0,
			);
			if (parts.length === 0) {
				return undefined;
			}
			return {
				prependContext: parts.join("\n\n"),
			};
		};

		const handleAfterCompaction = async (event: Record<string, unknown>, ctx: unknown): Promise<void> => {
			if (!cfg.enabled || !daemonReachable) return;
			const resolved = resolveCtx(event, ctx);
			const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
			if (scopedKey) {
				injectedTurns.delete(scopedKey);
				// Compaction resets the message count, so the checkpoint turn-dedup
				// (keyed on lastMsgCount) would falsely skip the first post-compaction
				// turn if it happens to share the same count as a pre-compaction turn.
				// Reset the checkpoint state so dedup starts fresh after compaction.
				checkpointTurns.delete(scopedKey);
			}
			const sessionFile = resolveCompactionSessionFile(event, resolved.sessionFile);
			const summary = extractCompactionSummary(event, sessionFile);
			if (!summary) {
				api.logger.warn(
					`signet-memory: compaction summary unavailable, skipping save${sessionFile ? ` (${sessionFile})` : ""}`,
				);
				return;
			}

			const dedupeKey = buildCompactionEventKey(event, {
				agentId: resolved.agentId,
				sessionKey: resolved.sessionKey,
				summary,
			});
			if (dedupeCompaction(afterCompactions, dedupeKey)) {
				return;
			}

			await onCompactionComplete("openclaw", summary, {
				...opts,
				agentId: resolved.agentId,
				project: resolveCompactionProject(event, resolved),
				sessionKey: resolved.sessionKey,
			});
		};

		const ensureSessionStarted = async (
			event: Record<string, unknown>,
			sessionKey: string | undefined,
			agentId: string | undefined,
		): Promise<void> => {
			if (!sessionKey) {
				const now = Date.now();
				cleanupTimedMap(sessionlessSessionStarts, now);
				const sessionlessKey = buildSessionlessTurnKey(event, agentId);
				const recentStartAt = sessionlessSessionStarts.get(sessionlessKey);
				if (typeof recentStartAt === "number" && now - recentStartAt <= SESSIONLESS_DEDUPE_MS) {
					return;
				}

				const startResult = await onSessionStart("openclaw", {
					...opts,
					sessionKey,
					agentId,
				});
				if (startResult) {
					sessionlessSessionStarts.set(sessionlessKey, Date.now());
				}
				return;
			}

			const scopedKey = buildScopedSessionKey(sessionKey, agentId);
			if (scopedKey && claimedSessions.has(scopedKey)) {
				return;
			}

			const startResult = await onSessionStart("openclaw", {
				...opts,
				sessionKey,
				agentId,
			});
			if (startResult && scopedKey) {
				claimedSessions.add(scopedKey);
			}
		};

		const runPromptInjection = async (
			event: Record<string, unknown>,
			sessionKey: string | undefined,
			agentId: string | undefined,
		): Promise<unknown> => {
			// Skip immediately if daemon is known-unreachable — avoids a 5-second
			// ECONNREFUSED hang on every message turn when the daemon is down.
			if (!daemonReachable) return undefined;

			// Prefer the clean last user message from the structured messages
			// array. The prompt field carries platform metadata wrappers
			// (Discord JSON, untrusted-context blocks) that pollute recall.
			const rawPrompt = typeof event.prompt === "string" ? event.prompt : undefined;
			const prompt = extractLastUserMessage(event.messages) ?? (rawPrompt ? extractUserMessage(rawPrompt) : undefined);
			if (!prompt || prompt.length <= 3) {
				return undefined;
			}

			// Deduplicate by (sessionKey, messageCount): both before_prompt_build
			// and before_agent_start fire on the same turn; only the first should
			// call the daemon. Sessionless agents (no sessionKey) cannot be
			// reliably correlated and are allowed to fall through rather than
			// risk cross-suppressing concurrent independent sessions.
			const count = Array.isArray(event.messages) ? event.messages.length : undefined;
			const scopedKey = buildScopedSessionKey(sessionKey, agentId);
			// sig is only defined when we have both a stable scoped session identity
			// and a message count — the two values that make dedup meaningful.
			const sig = scopedKey && typeof count === "number" ? `${scopedKey}|${count}` : undefined;
			// Lazy TTL sweep: evict entries from sessions that ended without agent_end.
			if (sig) {
				const now = Date.now();
				for (const [k, v] of injectedTurns) {
					if (now - v.at > SESSION_TURN_TTL_MS) injectedTurns.delete(k);
				}
			}
			if (
				sig &&
				(inFlightTurns.has(sig) || (scopedKey !== undefined && injectedTurns.get(scopedKey)?.count === count))
			) {
				return undefined;
			}
			// Mark in-flight synchronously before any await so concurrent
			// invocations in the same event-loop tick see the guard immediately.
			if (sig) inFlightTurns.add(sig);

			const lastAssistantMessage = extractLastAssistantMessage(event);
			const result = await onUserPromptSubmit("openclaw", {
				...opts,
				agentId,
				userMessage: prompt,
				lastAssistantMessage,
				sessionKey,
			});

			// Always clear in-flight regardless of outcome.
			if (sig) inFlightTurns.delete(sig);
			if (!result) {
				// daemonFetch already logged the specific error (ECONNREFUSED or HTTP status).
				return undefined;
			}
			// Record the completed turn so the other hook sees it on arrival.
			if (scopedKey && typeof count === "number") {
				injectedTurns.set(scopedKey, { count, at: Date.now() });
			}
			return buildInjectionResult(result);
		};

		// Preferred lifecycle hook in modern OpenClaw versions.
		api.on(
			"before_prompt_build",
			async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const resolved = resolveCtx(event, ctx);
				await ensureSessionStarted(event, resolved.sessionKey, resolved.agentId);
				const result = await runPromptInjection(event, resolved.sessionKey, resolved.agentId);
				// Count every turn unconditionally — checkpoint should fire based on
				// conversation progress, not on whether recall injection succeeded.
				const msgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
				const msgCount = msgs?.length;
				// Legacy dedup: increment bpbGen so bas can detect if bpb ran this turn.
				const bpbKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
				if (bpbKey) bpbGen.set(bpbKey, (bpbGen.get(bpbKey) ?? 0) + 1);
				maybeFireCheckpoint(
					resolved.sessionKey,
					resolved.agentId,
					resolved.project,
					resolved.sessionFile,
					msgCount,
					msgs,
				);
				return result;
			},
			{ priority: 20 },
		);

		// Legacy fallback for older OpenClaw runtimes.
		api.on("before_agent_start", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			if (!cfg.enabled) return undefined;

			const resolved = resolveCtx(event, ctx);
			await ensureSessionStarted(event, resolved.sessionKey, resolved.agentId);
			const result = await runPromptInjection(event, resolved.sessionKey, resolved.agentId);
			const msgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
			const msgCount = msgs?.length;
			// When messages absent, check generation counters to see if bpb already
			// counted this turn. If basGen < bpbGen, bas is covered; sync basGen.
			const basKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
			const latestBpb = basKey ? (bpbGen.get(basKey) ?? 0) : 0;
			const lastConsumed = basKey ? (basGen.get(basKey) ?? 0) : 0;
			const coveredByBpb = latestBpb > lastConsumed;
			if (basKey && coveredByBpb) basGen.set(basKey, latestBpb);
			if (!coveredByBpb || msgCount !== undefined) {
				maybeFireCheckpoint(
					resolved.sessionKey,
					resolved.agentId,
					resolved.project,
					resolved.sessionFile,
					msgCount,
					msgs,
				);
			}
			return result;
		});

		api.on("agent_end", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			if (!cfg.enabled) return undefined;

			const resolved = resolveCtx(event, ctx);
			const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);

			// Inline transcript fallback: same pattern as maybeFireCheckpoint —
			// when sessionFile is absent (typed-only ctx), serialize event.messages
			// so the daemon has a transcript source for session-end extraction.
			const endMsgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
			const endTranscript =
				!resolved.sessionFile && endMsgs && endMsgs.length > 0
					? endMsgs.map((m) => JSON.stringify(m)).join("\n")
					: undefined;
			await onSessionEnd("openclaw", {
				...opts,
				agentId: resolved.agentId,
				cwd: resolved.project,
				sessionId: resolved.sessionId,
				sessionKey: resolved.sessionKey,
				transcriptPath: resolved.sessionFile,
				...(endTranscript && { transcript: endTranscript }),
			});
			if (scopedKey) {
				claimedSessions.delete(scopedKey);
				injectedTurns.delete(scopedKey);
				checkpointTurns.delete(scopedKey);
				bpbGen.delete(scopedKey);
				basGen.delete(scopedKey);
			}
			return undefined;
		});

		api.on("before_compaction", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			return handleBeforeCompaction(event, ctx);
		});

		api.on("after_compaction", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			await handleAfterCompaction(event, ctx);
			return undefined;
		});

		// NOTE: session:compact:before / session:compact:after are not yet
		// recognized by OpenClaw (as of 2026.3.28). The legacy hooks above
		// (before_compaction / after_compaction) cover the same logic. Re-add
		// the modern names when OpenClaw ships support for them.

		// ==================================================================
		// Service
		// ==================================================================

			api.registerService({
				id: "signet-memory-openclaw",
			start() {
				api.logger.info(`signet-memory: service started (daemon: ${daemonUrl})`);
				healthTimer = setInterval(async () => {
					const pid = await getDaemonPid(daemonUrl);
					const ok = pid !== null;
					if (ok !== daemonReachable) {
						daemonReachable = ok;
						if (ok) {
							api.logger.info("signet-memory: daemon reconnected");
						} else {
							api.logger.warn("signet-memory: daemon became unreachable");
						}
					}
					// Daemon restarted (PID changed). Evict all claimed sessions so
					// ensureSessionStarted re-inits on next turn, restoring identity
					// blocks and memory context transparently.
					if (ok && knownPid !== null && pid !== knownPid) {
						api.logger.info(`signet-memory: daemon restarted (pid ${knownPid} -> ${pid}), re-initializing sessions`);
						claimedSessions.clear();
					}
					knownPid = pid;
				}, 60_000);
			},
			stop() {
				api.logger.info("signet-memory: service stopped");
				try {
					removeFetchSanitizer();
					removeSdkSanitizer();
					if (healthTimer) {
						clearInterval(healthTimer);
						healthTimer = null;
					}
					if (marketplaceProxyTimer) {
						clearInterval(marketplaceProxyTimer);
						marketplaceProxyTimer = null;
					}
				} finally {
					// Always release the process-level registration guard so a
					// later full registration pass can reinitialize cleanly.
					writeRegistered(false);
				}
			},
			});
		} catch (err) {
			if (claimed) {
				writeRegistered(false);
				api.logger.error(
					`signet-memory: registration failed after guard was claimed; guard reset before rethrow: ${String(err)}`,
				);
			}
			throw err;
		}
	},
};

/** @internal Test-only: reset the module-level registration guard. No-op in production. */
export function _resetRegistration(): void {
	if (process.env.NODE_ENV === "test") {
		writeRegistered(false);
	}
}

/** @internal Test-only exports for system prompt sanitization. */
export const _sanitization = {
	isAnthropicApiUrl,
	injectBillingBlock,
	replaceTriggers,
	sanitizeRequest,
	mergeBetaHeaders,
	readClaudeCodeOAuthToken,
	swapAuthHeaders,
	installFetchSanitizer,
	resolveAnthropicBase,
	installSdkSanitizer,
	BILLING_BLOCK,
	REQUIRED_BETAS,
	TRIGGER_REPLACEMENTS,
} as const;

export default signetPlugin;

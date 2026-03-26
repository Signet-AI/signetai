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
import { readStaticIdentity } from "@signet/core";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawToolResult } from "./openclaw-types.js";

const DEFAULT_DAEMON_URL = "http://localhost:3850";
const RUNTIME_PATH = "plugin" as const;
const READ_TIMEOUT = 5000;
const WRITE_TIMEOUT = 10000;
const COMPACTION_HOOK_DEDUPE_MS = 1000;

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
	const lines = rawPrompt.split("\n");
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
	return extracted.length > 0 ? extracted : rawPrompt;
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
		return null;
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
function staticFallback(): SessionStartResult | null {
	const dir = process.env.SIGNET_PATH ?? join(homedir(), ".agents");
	const inject = readStaticIdentity(dir);
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
	const result = await daemonFetch<SessionStartResult>(
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
	if (result) return result;
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

function cleanupTimedMap(map: Map<string, number>, now: number, ttlMs = SESSIONLESS_DEDUPE_MS): void {
	for (const [key, ts] of map) {
		if (now - ts > ttlMs) {
			map.delete(key);
		}
	}
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

const signetPlugin = {
	id: "signet-memory-openclaw",
	name: "Signet Memory",
	description: "Signet agent memory — persistent, searchable, identity-aware memory for AI agents",
	kind: "memory" as const,
	configSchema: signetConfigSchema,

	register(api: OpenClawPluginApi): void {
		const cfg = signetConfigSchema.parse(api.pluginConfig);
		const daemonUrl = cfg.daemonUrl || DEFAULT_DAEMON_URL;
		const opts = {
			daemonUrl,
			harness: "openclaw",
			workspace: process.env.SIGNET_WORKSPACE ?? process.cwd(),
			channel: process.env.SIGNET_CHANNEL,
		};

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

		const resolveHookContext = (
			ctx: unknown,
		): {
			sessionKey?: string;
			sessionFile?: string;
			agentId?: string;
			project?: string;
		} => {
			if (!isRecord(ctx)) {
				return {};
			}
			const sessionContext = ctx;
			return {
				sessionKey: typeof sessionContext?.sessionKey === "string" ? sessionContext.sessionKey : undefined,
				sessionFile: typeof sessionContext?.sessionFile === "string" ? sessionContext.sessionFile.trim() : undefined,
				agentId: typeof sessionContext?.agentId === "string" ? sessionContext.agentId : undefined,
				project: firstNonEmptyString(sessionContext.project, sessionContext.cwd, sessionContext.workspace),
			};
		};

		const resolveCompactionSessionKey = (
			event: Record<string, unknown>,
			ctx: {
				sessionKey?: string;
				sessionFile?: string;
				agentId?: string;
				project?: string;
			},
		): string | undefined => {
			const fromEvent = readString(event.sessionKey) ?? readString(event.sessionId);
			if (fromEvent) return fromEvent;
			if (ctx.sessionKey) return ctx.sessionKey;
			return undefined;
		};

		const resolveCompactionProject = (
			event: Record<string, unknown>,
			ctx: {
				sessionFile?: string;
				project?: string;
			},
		): string | undefined => {
			const compaction = isRecord(event.compaction) ? event.compaction : undefined;
			const sessionFile = resolveCompactionSessionFile(event, ctx.sessionFile);
			return firstNonEmptyString(
				event.project,
				event.cwd,
				event.workspace,
				compaction?.project,
				compaction?.cwd,
				compaction?.workspace,
				ctx.project,
				readSessionFileProject(sessionFile),
			);
		};

		const resolveSessionEndSessionKey = (
			event: Record<string, unknown>,
			ctx: {
				sessionKey?: string;
			},
		): string | undefined => {
			const fromEvent = readString(event.sessionKey) ?? readString(event.sessionId);
			if (fromEvent) return fromEvent;
			if (ctx.sessionKey) return ctx.sessionKey;
			return undefined;
		};

		const resolveSessionEndTranscript = (
			event: Record<string, unknown>,
			ctx: {
				sessionFile?: string;
			},
		): string | undefined => firstNonEmptyString(event.transcriptPath, event.sessionFile, ctx.sessionFile);

		const resolveSessionEndProject = (
			event: Record<string, unknown>,
			ctx: {
				project?: string;
			},
		): string | undefined => firstNonEmptyString(event.cwd, event.project, event.workspace, ctx.project);

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

		const handleBeforeCompaction = async (
			event: Record<string, unknown>,
			ctx: {
				sessionKey?: string;
				sessionFile?: string;
				agentId?: string;
				project?: string;
			},
		): Promise<unknown> => {
			if (!cfg.enabled || !daemonReachable) return undefined;
			const sessionKey = resolveCompactionSessionKey(event, ctx);
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
				agentId: ctx.agentId,
				sessionKey,
			});
			if (dedupeCompaction(beforeCompactions, dedupeKey)) {
				return undefined;
			}

			const result = await onPreCompaction("openclaw", {
				...opts,
				sessionKey,
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

		const handleAfterCompaction = async (
			event: Record<string, unknown>,
			ctx: {
				sessionKey?: string;
				sessionFile?: string;
				agentId?: string;
				project?: string;
			},
		): Promise<void> => {
			if (!cfg.enabled || !daemonReachable) return;
			const sessionKey = resolveCompactionSessionKey(event, ctx);
			const scopedKey = buildScopedSessionKey(sessionKey, ctx.agentId);
			if (scopedKey) {
				injectedTurns.delete(scopedKey);
			}
			const sessionFile = resolveCompactionSessionFile(event, ctx.sessionFile);
			const summary = extractCompactionSummary(event, sessionFile);
			if (!summary) {
				api.logger.warn(
					`signet-memory: compaction summary unavailable, skipping save${sessionFile ? ` (${sessionFile})` : ""}`,
				);
				return;
			}

			const dedupeKey = buildCompactionEventKey(event, {
				agentId: ctx.agentId,
				sessionKey,
				summary,
			});
			if (dedupeCompaction(afterCompactions, dedupeKey)) {
				return;
			}

			await onCompactionComplete("openclaw", summary, {
				...opts,
				agentId: ctx.agentId,
				project: resolveCompactionProject(event, ctx),
				sessionKey,
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

			const rawPrompt = typeof event.prompt === "string" ? event.prompt : undefined;
			const prompt = rawPrompt ? extractUserMessage(rawPrompt) : undefined;
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

				const { sessionKey, agentId } = resolveHookContext(ctx);
				await ensureSessionStarted(event, sessionKey, agentId);
				return runPromptInjection(event, sessionKey, agentId);
			},
			{ priority: 20 },
		);

		// Legacy fallback for older OpenClaw runtimes.
		api.on("before_agent_start", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			if (!cfg.enabled) return undefined;

			const { sessionKey, agentId } = resolveHookContext(ctx);
			await ensureSessionStarted(event, sessionKey, agentId);
			return runPromptInjection(event, sessionKey, agentId);
		});

		api.on("agent_end", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			if (!cfg.enabled) return undefined;

			const hook = resolveHookContext(ctx);
			const sessionKey = resolveSessionEndSessionKey(event, hook);
			const agentId = hook.agentId;
			const scopedKey = buildScopedSessionKey(sessionKey, agentId);

			await onSessionEnd("openclaw", {
				...opts,
				agentId,
				cwd: resolveSessionEndProject(event, hook),
				sessionId: readString(event.sessionId),
				sessionKey,
				transcriptPath: resolveSessionEndTranscript(event, hook),
			});
			if (scopedKey) {
				claimedSessions.delete(scopedKey);
				injectedTurns.delete(scopedKey);
			}
			return undefined;
		});

		api.on("before_compaction", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			return handleBeforeCompaction(event, resolveHookContext(ctx));
		});

		api.on("after_compaction", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			await handleAfterCompaction(event, resolveHookContext(ctx));
			return undefined;
		});

		api.on("session:compact:before", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			return handleBeforeCompaction(event, resolveHookContext(ctx));
		});

		api.on("session:compact:after", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
			await handleAfterCompaction(event, resolveHookContext(ctx));
			return undefined;
		});

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
				if (healthTimer) {
					clearInterval(healthTimer);
					healthTimer = null;
				}
				if (marketplaceProxyTimer) {
					clearInterval(marketplaceProxyTimer);
					marketplaceProxyTimer = null;
				}
			},
		});
	},
};

export default signetPlugin;

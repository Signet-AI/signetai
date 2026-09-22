import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	applyRecallScoreThreshold,
	buildRecallRequestBody,
	buildRememberRequestBody,
	formatRecallText,
	parseRecallPayload,
	readStaticIdentity,
	resolveSessionStartTimeoutMs,
	stripInternalMemoryContext,
	wrapMemoryContext,
} from "@signet/core";
import type { RecallPayload, RecallRow } from "@signet/core";
import { SignetClient } from "@signet/sdk";
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

const DEFAULT_DAEMON_URL = "http://127.0.0.1:3850";
const RUNTIME_PATH = "plugin" as const;
const READ_TIMEOUT = 5000;
const WRITE_TIMEOUT = 10000;
const HEARTBEAT_TIMEOUT = 2000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const COMPACTION_HOOK_DEDUPE_MS = 1000;
const SESSION_START_TIMEOUT = resolveSessionStartTimeoutMs(
	process.env.SIGNET_SESSION_START_TIMEOUT ?? process.env.SIGNET_FETCH_TIMEOUT,
);

type DaemonFetchFailure = "offline" | "timeout" | "http" | "invalid-json" | "body-read";

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

const METADATA_LINE_PREFIXES = [
	"<<<EXTERNAL_UNTRUSTED_CONTENT",
	">>>",
	"Conversation info",
	"Sender (untrusted",
	"Untrusted context",
	"END_EXTERNAL_UNTRUSTED_CONTENT",
] as const;

function stripSignetMemory(content: string): string {
	return stripInternalMemoryContext(content).trim();
}

function readContextString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
function looksLikeMetadataJson(content: string): boolean {
	if (!content.includes("```json")) return false;
	const metadataFields = ["label", "username", "tag", "sender", "conversation"];
	const hasMultipleMetadataFields =
		metadataFields.filter((f) => content.includes(`"${f}"`) || content.includes(`'${f}'`)).length >= 2;

	return hasMultipleMetadataFields;
}

function extractUserMessage(rawPrompt: string): string {
	const sanitized = stripSignetMemory(rawPrompt);
	const lines = sanitized.split("\n");
	let lastContentStart = 0;
	let inCodeFence = false;
	let codeFenceStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("```")) {
			if (!inCodeFence) {
				inCodeFence = true;
				codeFenceStart = i;
			} else {
				const fenceContent = lines.slice(codeFenceStart, i + 1).join("\n");
				if (looksLikeMetadataJson(fenceContent)) {
					lastContentStart = i + 1;
				}
				inCodeFence = false;
			}
			continue;
		}
		if (METADATA_LINE_PREFIXES.some((p) => line.startsWith(p) || line.includes(p))) {
			lastContentStart = i + 1;
		}
	}

	const extracted = lines.slice(lastContentStart).join("\n").trim();
	return extracted.length > 0 ? extracted : sanitized;
}

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
	stableSystemPrompt?: string;
	dynamicContext?: string;
	inject: string;
	contextHash?: string;
	contextVersion?: number;
}

export interface PreCompactionResult {
	summaryPrompt: string;
	guidelines: string;
}

export interface UserPromptSubmitResult {
	inject: string;
	dynamicContext?: string;
	clockContext?: string;
	contextHash?: string;
	contextVersion?: number;
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
			const text = await res.text();
			try {
				const data = JSON.parse(text) as T;
				return { ok: true, data };
			} catch {
				console.warn(
					`[signet] ${method} ${path} returned invalid JSON (${text.length} chars${text.length === 0 ? ", empty body" : ""})`,
				);
				return { ok: false, reason: "invalid-json", status: res.status };
			}
		} catch (e) {
			if (isTimeoutError(e)) {
				console.warn(`[signet] ${method} ${path} body read timed out after ${timeout}ms`);
				return { ok: false, reason: "timeout" };
			}
			console.warn(`[signet] ${method} ${path} body read failed:`, errorName(e) || e);
			return { ok: false, reason: "body-read" };
		}
	} catch (e) {
		if (isTimeoutError(e)) {
			console.warn(`[signet] ${method} ${path} timed out after ${timeout}ms`);
			return { ok: false, reason: "timeout" };
		}
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
function staticFallback(reason: "offline" | "timeout" = "offline"): SessionStartResult | null {
	const dir = process.env.SIGNET_PATH ?? join(homedir(), ".agents");
	const inject =
		reason === "timeout"
			? readStaticIdentity(dir, STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS)
			: readStaticIdentity(dir);
	if (!inject) return null;
	return { identity: { name: "signet" }, memories: [], inject };
}

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

export async function onNotifications(
	harness: string,
	hook: string,
	options: {
		daemonUrl?: string;
		agentId?: string;
		sessionKey?: string;
		project?: string;
	},
): Promise<UserPromptSubmitResult | null> {
	return daemonFetch(options.daemonUrl || DEFAULT_DAEMON_URL, "/api/hooks/notifications", {
		method: "POST",
		body: {
			harness,
			hook,
			agentId: options.agentId,
			sessionKey: options.sessionKey,
			project: options.project,
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
	new SignetClient({
		daemonUrl: options.daemonUrl || DEFAULT_DAEMON_URL,
		retries: 0,
		timeoutMs: WRITE_TIMEOUT,
	}).sessionEndFireAndForget({
		harness,
		agentId: options.agentId,
		transcriptPath: options.transcriptPath,
		...(options.transcript && { transcript: options.transcript }),
		sessionKey: options.sessionKey,
		sessionId: options.sessionId,
		cwd: options.cwd,
		reason: options.reason,
		runtimePath: RUNTIME_PATH,
	});

	return null;
}

export async function memoryRecall(
	query: string,
	options: {
		daemonUrl?: string;
		limit?: number;
		type?: string;
		minScore?: number;
		aggregate?: boolean;
		aggregateBudget?: "small" | "medium" | "large";
		saveAggregate?: boolean;
		sessionKey?: string;
		agentId?: string;
		includeRecalled?: boolean;
	} = {},
): Promise<RecallPayload | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<unknown>(daemonUrl, "/api/memory/recall", {
		method: "POST",
		body: buildRecallRequestBody(query, {
			limit: options.limit,
			type: options.type,
			aggregate: options.aggregate,
			aggregateBudget: options.aggregateBudget,
			saveAggregate: options.saveAggregate,
			sessionKey: options.sessionKey,
			agentId: options.agentId,
			includeRecalled: options.includeRecalled,
			minScore: options.minScore,
			recallSurface: "tool_call",
		}),
		timeout: READ_TIMEOUT,
	});
	return result ? (applyRecallScoreThreshold(result, options.minScore) as RecallPayload) : null;
}

export async function memorySearch(
	query: string,
	options: {
		daemonUrl?: string;
		limit?: number;
		type?: string;
		minScore?: number;
	} = {},
): Promise<RecallRow[]> {
	const result = await memoryRecall(query, options);
	return result ? parseRecallPayload(result).rows : [];
}

export async function sessionSearch(
	query: string,
	options: {
		daemonUrl?: string;
		sessionKey?: string;
		currentSessionKey?: string;
		agentId?: string;
		project?: string;
		limit?: number;
	} = {},
): Promise<unknown | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	return daemonFetch<unknown>(daemonUrl, "/api/sessions/search", {
		method: "POST",
		body: {
			query,
			sessionKey: options.sessionKey,
			currentSessionKey: options.currentSessionKey,
			agentId: options.agentId,
			project: options.project,
			limit: options.limit,
		},
		timeout: READ_TIMEOUT,
	});
}

export async function memoryStore(
	content: string,
	options: {
		daemonUrl?: string;
		type?: string;
		importance?: number;
		tags?: string | readonly string[];
		who?: string;
		reviewAfter?: string;
	} = {},
): Promise<string | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	const result = await daemonFetch<{ id?: string; memoryId?: string }>(daemonUrl, "/api/memory/remember", {
		method: "POST",
		body: buildRememberRequestBody(content, {
			type: options.type,
			importance: options.importance,
			tags: options.tags,
			who: options.who || "openclaw",
			reviewAfter: options.reviewAfter,
		}),
		timeout: WRITE_TIMEOUT,
	});
	return result?.id || result?.memoryId || null;
}

export async function memoryGet(id: string, options: { daemonUrl?: string } = {}): Promise<MemoryRecord | null> {
	const daemonUrl = options.daemonUrl || DEFAULT_DAEMON_URL;
	return daemonFetch<MemoryRecord>(daemonUrl, `/api/memory/${encodeURIComponent(id)}`, { timeout: READ_TIMEOUT });
}

export async function memoryList(
	options: { daemonUrl?: string; limit?: number; offset?: number; type?: string } = {},
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

export async function remember(
	content: string,
	options: {
		daemonUrl?: string;
		type?: string;
		importance?: number;
		tags?: string | readonly string[];
		who?: string;
		reviewAfter?: string;
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
): Promise<RecallRow[]> {
	return memorySearch(query, options);
}

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

function textResult(text: string, details?: Record<string, unknown>): OpenClawToolResult {
	return {
		content: [{ type: "text", text }],
		...(details ? { details } : {}),
	};
}
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
const BILLING_BLOCK = {
	type: "text",
	text: "x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;",
} as const;
const REQUIRED_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"effort-2025-11-24",
] as const;
function injectBillingBlock(body: Record<string, unknown>): boolean {
	const system = body.system;
	if (Array.isArray(system)) {
		const first = system[0] as Record<string, unknown> | undefined;
		if (first && typeof first.text === "string" && first.text.includes("x-anthropic-billing-header")) {
			return false;
		}
		system.unshift({ ...BILLING_BLOCK });
		return true;
	}
	if (typeof system === "string") {
		body.system = [{ ...BILLING_BLOCK }, { type: "text", text: system }];
		return true;
	}
	body.system = [{ ...BILLING_BLOCK }];
	return true;
}
function sanitizeRequest(request: { body?: unknown }): boolean {
	if (!request.body || typeof request.body !== "string") return false;
	try {
		const body = JSON.parse(request.body) as Record<string, unknown>;
		const injected = injectBillingBlock(body);
		if (injected) {
			request.body = JSON.stringify(body);
			return true;
		}
	} catch {}
	return false;
}
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

function isAnthropicApiUrl(url: string): boolean {
	try {
		return new URL(url).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}
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
	} catch {}
	return undefined;
}
function swapAuthHeaders(headers: Record<string, string>, oauthToken: string): void {
	for (const key of Object.keys(headers)) {
		const lk = key.toLowerCase();
		if (lk === "x-api-key" || lk === "authorization") {
			delete headers[key];
		}
	}
	headers.authorization = `Bearer ${oauthToken}`;
}

function installFetchSanitizer(): () => void {
	const original = globalThis.fetch;
	const sanitized: typeof globalThis.fetch = (input, init) => {
		if (init?.body && typeof init.body === "string") {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (isAnthropicApiUrl(url)) {
				const carrier = { body: init.body };
				sanitizeRequest(carrier);
				const newBody = carrier.body as string;
				const oauthToken = readClaudeCodeOAuthToken();
				const skip = new Set(["host", "connection", "content-length", "anthropic-dangerous-direct-browser-access"]);
				const headers: Record<string, string> = {};
				if (init.headers) {
					if (init.headers instanceof Headers) {
						init.headers.forEach((v, k) => {
							if (!skip.has(k.toLowerCase())) headers[k] = v;
						});
					} else if (Array.isArray(init.headers)) {
						for (const pair of init.headers) {
							if (!skip.has(pair[0].toLowerCase())) headers[pair[0]] = pair[1];
						}
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
				const Base = (exports.BaseAnthropic ?? exports.Anthropic) as (new (...args: unknown[]) => unknown) | undefined;
				if (Base?.prototype && typeof Base.prototype.prepareRequest === "function") {
					return Base;
				}
			}
		}
	} catch {}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const sdk = require("@anthropic-ai/sdk") as Record<string, unknown>;
		const Base = (sdk.BaseAnthropic ?? sdk.Anthropic) as (new (...args: unknown[]) => unknown) | undefined;
		if (Base?.prototype && typeof Base.prototype.prepareRequest === "function") {
			return Base;
		}
	} catch {}
	return undefined;
}

function installSdkSanitizer(): () => void {
	type PrepareRequestFn = (request: RequestInit, context: { url: string; options: unknown }) => Promise<void>;

	let Base: (new (...args: unknown[]) => unknown) | undefined;
	let original: PrepareRequestFn | undefined;
	let timer: ReturnType<typeof setInterval> | null = null;

	function applyPatch(): boolean {
		const found = resolveAnthropicBase();
		if (!found) return false;
		Base = found;
		const previous = Base.prototype.prepareRequest as PrepareRequestFn;
		original = previous;
		Base.prototype.prepareRequest = async function (
			request: RequestInit,
			context: { url: string; options: unknown },
		): Promise<void> {
			sanitizeRequest(request as { body?: unknown });
			return previous.call(this, request, context);
		};
		return true;
	}

	if (!applyPatch()) {
		let attempts = 0;
		timer = setInterval(() => {
			attempts++;
			if (applyPatch() || attempts >= 30) {
				if (timer) {
					clearInterval(timer);
					timer = null;
				}
			}
		}, 200);
	}

	return () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (Base && original) {
			Base.prototype.prepareRequest = original;
		}
	};
}

function buildInjectionResult(result: UserPromptSubmitResult): { prependContext: string } | undefined {
	const dynamicContext = readContextString(result.dynamicContext) || readContextString(result.inject);
	const clockContext = readContextString(result.clockContext);
	if (!dynamicContext && !clockContext) {
		return undefined;
	}
	let context = "";
	if (dynamicContext) {
		const queryAttr = result.queryTerms ? ` query="${result.queryTerms.replace(/"/g, "'").slice(0, 100)}"` : "";
		const attrs = `source="auto-recall"${queryAttr} results="${result.memoryCount}" engine="${result.engine ?? "fts+decay"}"`;
		context = wrapMemoryContext(dynamicContext, "auto-recall").replace(
			'<signet-memory source="auto-recall">',
			`<signet-memory ${attrs}>`,
		);
	}
	return {
		prependContext: [context, clockContext].filter((part) => part.length > 0).join("\n\n"),
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
			} catch {}
		}
	} catch {}

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
			} catch {}
		}
	} catch {}

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
const REG_KEY = "__signet_openclaw_registered__signet-memory-openclaw";

function readRegistered(): boolean {
	const value = Reflect.get(globalThis, REG_KEY);
	return value === true;
}

function writeRegistered(value: boolean): void {
	Reflect.set(globalThis, REG_KEY, value);
}

function buildMemoryPromptSection({
	availableTools,
	citationsMode,
}: {
	availableTools: Set<string>;
	citationsMode?: "auto" | "on" | "off";
}): string[] {
	const hasSearch = availableTools.has("memory_search");
	const hasGet = availableTools.has("memory_get");
	if (!hasSearch && !hasGet) return [];

	const guidance = hasSearch
		? `Before answering about prior work, decisions, dates, people, preferences, or todos, use memory_search${
				hasGet ? "; then use memory_get when an exact memory must be inspected" : ""
			}. Signet results are scoped and provenance-backed; if recall is inconclusive, say that you checked.`
		: "When a request points to a specific remembered item, use memory_get before answering. Signet results are scoped and provenance-backed; if the lookup is inconclusive, say that you checked.";

	const lines = ["## Signet Memory", guidance];
	if (citationsMode === "off") {
		lines.push("Do not expose source identifiers or provenance in the reply unless the user asks for them.");
	} else {
		lines.push("Include provenance when it materially helps the user verify a recalled claim.");
	}
	lines.push("");
	return lines;
}

const signetPlugin = {
	id: "signet-memory-openclaw",
	name: "Signet Memory",
	description: "Signet agent memory — persistent, searchable, identity-aware memory for AI agents",
	kind: "memory" as const,
	configSchema: signetConfigSchema,

	register(api: OpenClawPluginApi): void {
		const mode = api.registrationMode ?? "full";
		if (mode === "discovery") {
			api.registerMemoryCapability({ promptBuilder: buildMemoryPromptSection });
			return;
		}

		if (["cli-metadata", "setup-only", "setup-runtime"].includes(mode)) {
			return;
		}
		if (mode !== "full" && mode !== "tool-discovery") {
			api.logger.warn(`signet-memory: skipping runtime registration for unknown mode=${mode}`);
			return;
		}

		if (mode === "full" && readRegistered()) {
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
			if (mode === "full") {
				api.registerMemoryCapability({ promptBuilder: buildMemoryPromptSection });
				writeRegistered(true);
				claimed = true;
			}
			const removeFetchSanitizer = mode === "full" ? installFetchSanitizer() : () => {};
			const removeSdkSanitizer = mode === "full" ? installSdkSanitizer() : () => {};
			let daemonReachable = true;
			let knownPid: number | null = null;
			let healthTimer: ReturnType<typeof setInterval> | null = null;
			const hooksRegistered = [
				"before_prompt_build",
				"before_agent_start",
				"message_received",
				"before_tool_call",
				"agent_end",
				"before_compaction",
				"after_compaction",
			];
			let healthError: string | null = null;
			let heartbeatInFlight = false;

			const pluginVersion = typeof api.version === "string" && api.version.trim() ? api.version : "unknown";
			const sendHeartbeat = async (): Promise<void> => {
				if (heartbeatInFlight) return;
				heartbeatInFlight = true;
				try {
					await daemonFetchResult<{ ok: boolean }>(daemonUrl, "/api/diagnostics/openclaw/heartbeat", {
						method: "POST",
						body: {
							pluginVersion,
							hooksRegistered,
							lastHookCall: null,
							lastError: healthError,
							latencyMs: 0,
							hooksSucceeded: 0,
							hooksFailed: healthError ? 1 : 0,
						},
						timeout: HEARTBEAT_TIMEOUT,
					});
				} finally {
					heartbeatInFlight = false;
				}
			};

			if (mode === "full") {
				api.logger.info(`signet-memory: registered (daemon: ${daemonUrl})`);
			}
			if (mode === "full") {
				getDaemonPid(daemonUrl).then((pid) => {
					daemonReachable = pid !== null;
					knownPid = pid;
					if (!daemonReachable) {
						healthError = `daemon unreachable at ${daemonUrl}; memory hooks are disabled until Signet is healthy`;
						api.logger.warn(
							`signet-memory: daemon unreachable at ${daemonUrl}. Memory hooks are disabled until daemon health recovers; run \`signet status\` or \`signet doctor\` for diagnostics.`,
						);
					} else {
						healthError = null;
						void sendHeartbeat();
					}
				});
			}

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
						aggregate: Type.Optional(
							Type.Boolean({
								description: "Synthesize an aggregate answer from recall evidence",
							}),
						),
						aggregate_budget: Type.Optional(
							Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]),
						),
						save_aggregate: Type.Optional(
							Type.Boolean({
								description: "Save aggregate answers as memories",
							}),
						),
						session_key: Type.Optional(
							Type.String({
								description: "Session key for per-context recall dedupe",
							}),
						),
						agent_id: Type.Optional(
							Type.String({
								description: "Agent ID for scoped recall dedupe",
							}),
						),
						include_recalled: Type.Optional(
							Type.Boolean({
								description: "Include rows already recalled in this context",
							}),
						),
					}),
					async execute(_toolCallId, params) {
						const {
							query,
							limit,
							type,
							min_score,
							aggregate,
							aggregate_budget,
							save_aggregate,
							session_key,
							agent_id,
							include_recalled,
						} = params as {
							query: string;
							limit?: number;
							type?: string;
							min_score?: number;
							aggregate?: boolean;
							aggregate_budget?: "small" | "medium" | "large";
							save_aggregate?: boolean;
							session_key?: string;
							agent_id?: string;
							include_recalled?: boolean;
						};
						try {
							const recall = await memoryRecall(query, {
								...opts,
								limit,
								type,
								minScore: min_score,
								aggregate,
								aggregateBudget: aggregate_budget,
								saveAggregate: save_aggregate,
								sessionKey: session_key,
								agentId: agent_id,
								includeRecalled: include_recalled,
							});
							const parsed = parseRecallPayload(recall);
							if (parsed.rows.length === 0) {
								return textResult("No relevant memories found.", {
									count: 0,
								});
							}
							return textResult(formatRecallText(recall), {
								count: parsed.rows.length,
								memories: parsed.rows,
								meta: parsed.meta,
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
					name: "session_search",
					label: "Session Search",
					description: "Search active or completed session transcripts",
					parameters: Type.Object({
						query: Type.String({
							description: "Natural language or keyword query",
						}),
						session_key: Type.Optional(
							Type.String({
								description: "Specific transcript session key to search",
							}),
						),
						current_session_key: Type.Optional(
							Type.String({
								description: "Current session key; sub-agent lineage may resolve this to the parent session",
							}),
						),
						agent_id: Type.Optional(
							Type.String({
								description: "Agent scope, default default",
							}),
						),
						project: Type.Optional(
							Type.String({
								description: "Optional project path filter",
							}),
						),
						limit: Type.Optional(
							Type.Number({
								description: "Max results to return (default 10, max 20)",
							}),
						),
					}),
					async execute(_toolCallId, params) {
						const { query, session_key, current_session_key, agent_id, project, limit } = params as {
							query: string;
							session_key?: string;
							current_session_key?: string;
							agent_id?: string;
							project?: string;
							limit?: number;
						};
						try {
							const result = await sessionSearch(query, {
								...opts,
								sessionKey: session_key,
								currentSessionKey: current_session_key,
								agentId: agent_id,
								project,
								limit,
							});
							if (result === null) {
								return textResult("Session search failed: daemon unavailable", { error: "daemon unavailable" });
							}
							return textResult(JSON.stringify(result, null, 2), { result });
						} catch (err) {
							return textResult(`Session search failed: ${String(err)}`, { error: String(err) });
						}
					},
				},
				{ name: "session_search" },
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
			if (mode === "tool-discovery") return;

			const claimedSessions = new Set<string>();
			type SessionStartContext = {
				stableSystemPrompt: string;
				dynamicContext: string;
				delivered: boolean;
			};
			const sessionStartContexts = new Map<string, SessionStartContext>();
			const sessionlessSessionStartContexts = new Map<string, SessionStartContext>();
			const sessionlessSessionStarts = new Map<string, number>();
			const SESSION_TURN_TTL_MS = 4 * 60 * 60 * 1000;
			const injectedTurns = new Map<string, { count: number; at: number }>();
			const inFlightTurns = new Set<string>();
			const pendingNotifications = new Map<string, { inject: string; at: number }>();
			const beforeCompactions = new Map<string, number>();
			const afterCompactions = new Map<string, number>();
			const CHECKPOINT_TURN_THRESHOLD = 20;
			const checkpointTurns = new Map<string, { count: number; lastMsgCount: number | undefined; at: number }>();
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
				if (state && now - state.at > SESSION_TURN_TTL_MS) {
					checkpointTurns.delete(scopedKey);
				} else {
					sessionlessSessionStartContexts.clear();
					sessionlessSessionStarts.clear();
				}
				if (msgCount !== undefined && checkpointTurns.get(scopedKey)?.lastMsgCount === msgCount) return;

				const newCount = (checkpointTurns.get(scopedKey)?.count ?? 0) + 1;
				checkpointTurns.set(scopedKey, {
					count: newCount >= CHECKPOINT_TURN_THRESHOLD ? 0 : newCount,
					lastMsgCount: msgCount,
					at: now,
				});

				if (newCount < CHECKPOINT_TURN_THRESHOLD) return;
				const inlineTranscript =
					!sessionFile && Array.isArray(messages) && messages.length > 0
						? messages.map((m) => JSON.stringify(m)).join("\n")
						: undefined;
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
						if (isRecord(resp) && resp.skipped === true) {
							const cur = checkpointTurns.get(scopedKey);
							if (cur && cur.count < CHECKPOINT_TURN_THRESHOLD - 1)
								checkpointTurns.set(scopedKey, { ...cur, count: CHECKPOINT_TURN_THRESHOLD - 1 });
						}
					})
					.catch((err) => {
						api.logger.warn(
							`signet-memory: checkpoint extract failed: ${err instanceof Error ? err.message : String(err)}`,
						);
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
					const sessionStartContext = sessionStartContexts.get(scopedKey);
					if (sessionStartContext) {
						sessionStartContext.dynamicContext = "";
						sessionStartContext.delivered = false;
					}
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
			): Promise<SessionStartContext | undefined> => {
				if (!sessionKey) {
					const now = Date.now();
					cleanupTimedMap(sessionlessSessionStarts, now);
					for (const key of sessionlessSessionStartContexts.keys()) {
						if (!sessionlessSessionStarts.has(key)) sessionlessSessionStartContexts.delete(key);
					}
					const sessionlessKey = buildSessionlessTurnKey(event, agentId);
					const recentStartAt = sessionlessSessionStarts.get(sessionlessKey);
					if (typeof recentStartAt === "number" && now - recentStartAt <= SESSIONLESS_DEDUPE_MS) {
						return sessionlessSessionStartContexts.get(sessionlessKey);
					}

					const startResult = await onSessionStart("openclaw", {
						...opts,
						sessionKey,
						agentId,
					});
					if (!startResult) return undefined;
					const context: SessionStartContext = {
						stableSystemPrompt: readContextString(startResult.stableSystemPrompt),
						dynamicContext: readContextString(startResult.dynamicContext) || readContextString(startResult.inject),
						delivered: false,
					};
					sessionlessSessionStarts.set(sessionlessKey, Date.now());
					sessionlessSessionStartContexts.set(sessionlessKey, context);
					return context;
				}

				const scopedKey = buildScopedSessionKey(sessionKey, agentId);
				if (scopedKey && claimedSessions.has(scopedKey)) {
					return sessionStartContexts.get(scopedKey);
				}

				const startResult = await onSessionStart("openclaw", {
					...opts,
					sessionKey,
					agentId,
				});
				if (!startResult) return undefined;
				const context: SessionStartContext = {
					stableSystemPrompt: readContextString(startResult.stableSystemPrompt),
					dynamicContext: readContextString(startResult.dynamicContext) || readContextString(startResult.inject),
					delivered: false,
				};
				if (scopedKey) {
					claimedSessions.add(scopedKey);
					sessionStartContexts.set(scopedKey, context);
				}
				return context;
			};

			const runPromptInjection = async (
				event: Record<string, unknown>,
				sessionKey: string | undefined,
				agentId: string | undefined,
			): Promise<unknown> => {
				if (!daemonReachable) return undefined;

				const scopedKey = buildScopedSessionKey(sessionKey, agentId);
				const sessionlessKey = scopedKey ? undefined : buildSessionlessTurnKey(event, agentId);
				const pendingNotification = scopedKey ? pendingNotifications.get(scopedKey)?.inject : undefined;
				const takeSessionStartInjection = (): string | undefined => {
					const context = scopedKey
						? sessionStartContexts.get(scopedKey)
						: sessionlessKey
							? sessionlessSessionStartContexts.get(sessionlessKey)
							: undefined;
					if (!context || context.delivered) return undefined;
					context.delivered = true;
					if (sessionlessKey) sessionlessSessionStartContexts.delete(sessionlessKey);
					return wrapMemoryContext(
						[context.stableSystemPrompt, context.dynamicContext].filter((part) => part.length > 0).join("\n\n"),
						"session-start",
					);
				};
				const rawPrompt = typeof event.prompt === "string" ? event.prompt : undefined;
				const prompt =
					extractLastUserMessage(event.messages) ?? (rawPrompt ? extractUserMessage(rawPrompt) : undefined);
				if (!prompt || prompt.length <= 3) {
					return pendingNotification ? { prependContext: pendingNotification } : undefined;
				}
				const count = Array.isArray(event.messages) ? event.messages.length : undefined;
				const sig = scopedKey && typeof count === "number" ? `${scopedKey}|${count}` : undefined;
				if (sig) {
					const now = Date.now();
					for (const [k, v] of injectedTurns) {
						if (now - v.at > SESSION_TURN_TTL_MS) injectedTurns.delete(k);
					}
					for (const [k, v] of pendingNotifications) {
						if (now - v.at > SESSION_TURN_TTL_MS) pendingNotifications.delete(k);
					}
				}
				if (
					sig &&
					(inFlightTurns.has(sig) || (scopedKey !== undefined && injectedTurns.get(scopedKey)?.count === count))
				) {
					const notifications = await onNotifications("openclaw", "before_prompt_build", {
						...opts,
						agentId,
						sessionKey,
					});
					if (notifications?.inject) return { prependContext: notifications.inject };
					return pendingNotification ? { prependContext: pendingNotification } : undefined;
				}
				if (sig) inFlightTurns.add(sig);

				const lastAssistantMessage = extractLastAssistantMessage(event);
				const result = await onUserPromptSubmit("openclaw", {
					...opts,
					agentId,
					userMessage: prompt,
					lastAssistantMessage,
					sessionKey,
				});
				if (sig) inFlightTurns.delete(sig);
				if (!result) {
					return pendingNotification ? { prependContext: pendingNotification } : undefined;
				}
				if (scopedKey) pendingNotifications.delete(scopedKey);
				if (scopedKey && typeof count === "number") {
					injectedTurns.set(scopedKey, { count, at: Date.now() });
				}
				const sessionStartInjection = takeSessionStartInjection();
				const promptInjection = buildInjectionResult(result)?.prependContext;
				const parts = [sessionStartInjection, promptInjection].filter((value): value is string => Boolean(value));
				return parts.length > 0 ? { prependContext: parts.join("\n\n") } : undefined;
			};
			api.on(
				"before_prompt_build",
				async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
					if (!cfg.enabled) return undefined;

					const resolved = resolveCtx(event, ctx);
					await ensureSessionStarted(event, resolved.sessionKey, resolved.agentId);
					const result = await runPromptInjection(event, resolved.sessionKey, resolved.agentId);
					const msgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
					const msgCount = msgs?.length;
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
			api.on("before_agent_start", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const resolved = resolveCtx(event, ctx);
				await ensureSessionStarted(event, resolved.sessionKey, resolved.agentId);
				const result = await runPromptInjection(event, resolved.sessionKey, resolved.agentId);
				const msgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
				const msgCount = msgs?.length;
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

			const cacheNotificationHook = async (
				event: Record<string, unknown>,
				ctx: unknown,
				hook: string,
			): Promise<void> => {
				if (!cfg.enabled || !daemonReachable) return;
				const resolved = resolveCtx(event, ctx);
				const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
				if (!scopedKey) return;
				const result = await onNotifications("openclaw", hook, {
					...opts,
					agentId: resolved.agentId,
					sessionKey: resolved.sessionKey,
					project: resolved.project,
				});
				if (result?.inject) {
					pendingNotifications.set(scopedKey, { inject: result.inject, at: Date.now() });
				} else {
					pendingNotifications.delete(scopedKey);
				}
			};

			api.on("message_received", async (event: Record<string, unknown>, ctx: unknown): Promise<void> => {
				await cacheNotificationHook(event, ctx, "message_received");
			});
			api.on("before_tool_call", async (event: Record<string, unknown>, ctx: unknown): Promise<void> => {
				await cacheNotificationHook(event, ctx, "before_tool_call");
			});

			api.on("agent_end", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const resolved = resolveCtx(event, ctx);
				const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
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
					sessionStartContexts.delete(scopedKey);
					injectedTurns.delete(scopedKey);
					pendingNotifications.delete(scopedKey);
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
								healthError = null;
								api.logger.info("signet-memory: daemon reconnected");
								void sendHeartbeat();
							} else {
								healthError = `daemon became unreachable at ${daemonUrl}; memory hooks are disabled`;
								api.logger.warn(
									"signet-memory: daemon became unreachable; memory hooks are disabled until health recovers",
								);
							}
						} else if (ok) {
							void sendHeartbeat();
						}
						if (ok && knownPid !== null && pid !== knownPid) {
							api.logger.info(`signet-memory: daemon restarted (pid ${knownPid} -> ${pid}), re-initializing sessions`);
							claimedSessions.clear();
							sessionStartContexts.clear();
							sessionlessSessionStartContexts.clear();
							injectedTurns.clear();
							inFlightTurns.clear();
							pendingNotifications.clear();
							sessionlessSessionStarts.clear();
						}
						knownPid = pid;
					}, HEARTBEAT_INTERVAL_MS);
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
					} finally {
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
export function _resetRegistration(): void {
	if (process.env.NODE_ENV === "test") {
		writeRegistered(false);
	}
}
export const _sanitization = {
	isAnthropicApiUrl,
	injectBillingBlock,
	sanitizeRequest,
	mergeBetaHeaders,
	readClaudeCodeOAuthToken,
	swapAuthHeaders,
	installFetchSanitizer,
	resolveAnthropicBase,
	installSdkSanitizer,
	BILLING_BLOCK,
	REQUIRED_BETAS,
} as const;

export default signetPlugin;

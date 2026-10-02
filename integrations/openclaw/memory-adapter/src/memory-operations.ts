import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	applyRecallScoreThreshold,
	buildRecallRequestBody,
	buildRememberRequestBody,
	readStaticIdentity,
	resolveWorkspacePath,
	resolveSessionStartTimeoutMs,
} from "@signet/core";
import type { RecallPayload, RecallRow } from "@signet/core";
import { SignetClient } from "@signet/sdk";
import { createDaemonFetcher, createDaemonIdentityHeaders } from "@signet/connector-base/daemon-client";
import { projectRecall } from "./recall-projection.js";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:3850";
export const RUNTIME_PATH = "plugin" as const;
const READ_TIMEOUT = 5000;
export const WRITE_TIMEOUT = 10000;

type PublishedDaemonFetchOptions = {
	readonly method?: string;
	readonly body?: unknown;
	readonly timeout?: number;
	readonly parseJson?: boolean;
};

type PublishedDaemonFetchResult<T> =
	| { readonly ok: true; readonly data: T }
	| {
			readonly ok: false;
			readonly reason: "offline" | "timeout" | "http" | "invalid-json" | "body-read";
			readonly status?: number;
	  };
const SESSION_START_TIMEOUT = resolveSessionStartTimeoutMs(
	process.env.SIGNET_SESSION_START_TIMEOUT ?? process.env.SIGNET_FETCH_TIMEOUT,
);

export interface SignetConfig {
	enabled?: boolean;
	daemonUrl?: string;
}

export interface SessionStartResult {
	identity: { name: string; description?: string };
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

const pluginHeaders = (): Record<string, string> => createDaemonIdentityHeaders("openclaw-plugin", RUNTIME_PATH);

const daemonFetchResultImpl = createDaemonFetcher({
	headers: pluginHeaders,
	logPrefix: "signet",
	defaultTimeout: READ_TIMEOUT,
	onOffline(error, { daemonUrl, method, path }) {
		const cause: unknown = error instanceof TypeError ? error.cause : error;
		const isConnRefused = typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ECONNREFUSED";
		if (isConnRefused) {
			console.warn(`[signet] daemon unreachable at ${daemonUrl} — is the Signet daemon running? (${method} ${path})`);
		} else {
			console.warn(`[signet] ${method} ${path} error:`, error);
		}
	},
});

export const daemonFetchResult = <T>(
	daemonUrl: string,
	path: string,
	options: PublishedDaemonFetchOptions = {},
): Promise<PublishedDaemonFetchResult<T>> => daemonFetchResultImpl<T>(daemonUrl, path, options);

const healthFetch = createDaemonFetcher({
	headers: () => undefined,
	logPrefix: "signet",
	defaultTimeout: 1000,
	logFailures: false,
});

export async function daemonFetch<T>(
	daemonUrl: string,
	path: string,
	options: PublishedDaemonFetchOptions = {},
): Promise<T | null> {
	const result = await daemonFetchResult<T>(daemonUrl, path, options);
	return result.ok ? result.data : null;
}

export async function isDaemonRunning(daemonUrl = DEFAULT_DAEMON_URL): Promise<boolean> {
	return (
		await healthFetch<void>(daemonUrl, "/health", {
			parseJson: false,
		})
	).ok;
}

export async function getDaemonPid(daemonUrl: string): Promise<number | null> {
	const result = await healthFetch<{ readonly pid?: number }>(daemonUrl, "/health");
	return result.ok && typeof result.data.pid === "number" ? result.data.pid : null;
}

function staticFallback(reason: "offline" | "timeout" = "offline"): SessionStartResult | null {
	const dir = process.env.SIGNET_PATH ?? resolveWorkspacePath().path;
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
	options: { daemonUrl?: string; limit?: number; type?: string; minScore?: number } = {},
): Promise<RecallRow[]> {
	const result = await memoryRecall(query, options);
	return result ? projectRecall(result).rows : [];
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
	const result = await daemonFetch<{ id?: string; memoryId?: string }>(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		"/api/memory/remember",
		{
			method: "POST",
			body: buildRememberRequestBody(content, {
				type: options.type,
				importance: options.importance,
				tags: options.tags,
				who: options.who || "openclaw",
				reviewAfter: options.reviewAfter,
			}),
			timeout: WRITE_TIMEOUT,
		},
	);
	return result?.id || result?.memoryId || null;
}

export async function memoryGet(id: string, options: { daemonUrl?: string } = {}): Promise<MemoryRecord | null> {
	return daemonFetch<MemoryRecord>(options.daemonUrl || DEFAULT_DAEMON_URL, `/api/memory/${encodeURIComponent(id)}`, {
		timeout: READ_TIMEOUT,
	});
}

export async function memoryList(
	options: { daemonUrl?: string; limit?: number; offset?: number; type?: string } = {},
): Promise<{ memories: MemoryRecord[]; stats: Record<string, number> }> {
	const params = new URLSearchParams();
	if (options.limit) params.set("limit", String(options.limit));
	if (options.offset) params.set("offset", String(options.offset));
	if (options.type) params.set("type", options.type);

	const query = params.toString();
	const path = `/api/memories${query ? `?${query}` : ""}`;
	const result = await daemonFetch<{ memories: MemoryRecord[]; stats: Record<string, number> }>(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		path,
		{ timeout: READ_TIMEOUT },
	);
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
	const result = await daemonFetch<{ success?: boolean }>(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		`/api/memory/${encodeURIComponent(id)}`,
		{ method: "PATCH", body: patch, timeout: WRITE_TIMEOUT },
	);
	return result?.success === true;
}

export async function memoryForget(
	id: string,
	options: { daemonUrl?: string; reason: string; force?: boolean },
): Promise<boolean> {
	const params = new URLSearchParams();
	params.set("reason", options.reason);
	if (options.force) params.set("force", "true");

	const result = await daemonFetch<{ success?: boolean }>(
		options.daemonUrl || DEFAULT_DAEMON_URL,
		`/api/memory/${encodeURIComponent(id)}?${params}`,
		{ method: "DELETE", timeout: WRITE_TIMEOUT },
	);
	return result?.success === true;
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
	options: { daemonUrl?: string; limit?: number; type?: string; minScore?: number } = {},
): Promise<RecallRow[]> {
	return memorySearch(query, options);
}

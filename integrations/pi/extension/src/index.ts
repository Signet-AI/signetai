import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRecallRequestBody,
	buildRememberRequestBody,
	formatRecallText,
	parseRecallPayload,
} from "@signet/pi-extension-base/native-helpers";
import type { RecallPayload } from "@signet/pi-extension-base/native-helpers";
import { resolvePiAgentDir } from "@signet/pi-extension-base/agent-dir";
import { readRuntimeEnv, readTrimmedRuntimeEnv, readTrimmedString } from "@signet/pi-extension-base";
import { Type } from "@sinclair/typebox";
import { createDaemonClient } from "./daemon-client.js";
import {
	type LifecycleDeps,
	PI_LIFECYCLE_CONFIG,
	currentSessionRef,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	refreshSessionStart,
	requestNotifications,
	requestRecallForPrompt,
} from "./lifecycle.js";
import { type PiSessionState, createSessionState } from "./session-state.js";
import {
	DAEMON_URL_DEFAULT,
	HARNESS,
	type PiBeforeAgentStartEvent,
	type PiBeforeAgentStartResult,
	type PiContextEvent,
	type PiContextEventResult,
	type PiExtensionApi,
	type PiExtensionContext,
	type PiExtensionFactory,
	type PiInputEvent,
	type PiSessionBeforeCompactEvent,
	type PiSessionCompactEvent,
	type PreCompactionResult,
	READ_TIMEOUT,
	RUNTIME_PATH,
	WRITE_TIMEOUT,
} from "./types.js";

interface PiExtensionConfig {
	enabled: boolean;
}

interface PiExtensionConfigFile {
	enabled?: boolean;
}

function loadConfigFile(): PiExtensionConfigFile | null {
	const configPath = join(resolvePiAgentDir(), "extensions", "signet.json");
	if (!existsSync(configPath)) return null;

	try {
		const content = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as PiExtensionConfigFile;
	} catch {
		return null;
	}
}

export function loadConfig(): PiExtensionConfig {
	const fileConfig = loadConfigFile();
	const envEnabled = readRuntimeEnv("SIGNET_ENABLED");
	const fileEnabled = fileConfig?.enabled;
	const enabled = envEnabled !== undefined ? envEnabled !== "false" : fileEnabled !== undefined ? fileEnabled : true;

	return { enabled };
}

const cfg = loadConfig();

interface SignetState {
	lastRecall: string | null;
	memoryCount: number;
}

const state: SignetState = {
	lastRecall: null,
	memoryCount: 0,
};

function readAuthToken(): string | undefined {
	return readTrimmedRuntimeEnv("SIGNET_API_KEY") ?? readTrimmedRuntimeEnv("SIGNET_TOKEN");
}

function daemonHeaders(headers: Record<string, string> = {}): Record<string, string> {
	const token = readAuthToken();
	return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

async function checkDaemonHealth(daemonUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${daemonUrl}/health`, {
			method: "GET",
			headers: daemonHeaders({ Accept: "application/json" }),
			signal: AbortSignal.timeout(READ_TIMEOUT),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function daemonFailure(
	operation: string,
	result: { readonly ok: false; readonly reason: string; readonly status?: number },
): Error {
	const detail = result.reason === "http" && result.status !== undefined ? `HTTP ${result.status}` : result.reason;
	return new Error(`${operation} failed: ${detail}`);
}

function postDaemon<T>(daemonUrl: string, path: string, body: unknown, timeout: number, operation: string): Promise<T>;
function postDaemon(
	daemonUrl: string,
	path: string,
	body: unknown,
	timeout: number,
	operation: string,
	mode: "status",
): Promise<void>;
async function postDaemon<T>(
	daemonUrl: string,
	path: string,
	body: unknown,
	timeout: number,
	operation: string,
	mode: "json" | "status" = "json",
): Promise<T | undefined> {
	const client = createDaemonClient(daemonUrl);
	if (mode === "status") {
		const result = await client.postStatus(path, body, timeout);
		if (!result.ok) throw daemonFailure(operation, result);
		return;
	}

	const result = await client.postResult<T>(path, body, timeout);
	if (!result.ok) throw daemonFailure(operation, result);
	return result.data;
}

export async function recallMemories(
	daemonUrl: string,
	query: string,
	options: {
		limit?: number;
		agentId?: string;
		sessionKey?: string;
		includeRecalled?: boolean;
		scope?: "global" | "agent" | "session";
		aggregate?: boolean;
		aggregateBudget?: "small" | "medium" | "large";
		saveAggregate?: boolean;
	} = {},
): Promise<RecallPayload> {
	return postDaemon<RecallPayload>(
		daemonUrl,
		"/api/memory/recall",
		buildRecallRequestBody(query, {
			...options,
			recallSurface: "tool_call",
		}),
		options.aggregate ? Math.max(READ_TIMEOUT * 6, 30_000) : READ_TIMEOUT,
		"Recall",
	);
}
export async function rememberContent(
	daemonUrl: string,
	content: string,
	options: {
		critical?: boolean;
		tags?: string[];
		agentId?: string;
		reviewAfter?: string;
	} = {},
): Promise<void> {
	const { critical = false, tags = [], agentId, reviewAfter } = options;

	await postDaemon(
		daemonUrl,
		"/api/hooks/remember",
		buildRememberRequestBody(content, {
			harness: HARNESS,
			pinned: critical,
			tags,
			agentId,
			reviewAfter,
			source: "pi-extension",
			runtimePath: RUNTIME_PATH,
		}),
		WRITE_TIMEOUT,
		"Remember",
		"status",
	);
}
export async function searchSourceArtifacts(
	daemonUrl: string,
	query: string,
	options: {
		limit?: number;
		agentId?: string;
		sessionKey?: string;
		includeRecalled?: boolean;
		project?: string;
	} = {},
): Promise<RecallPayload> {
	const { limit, agentId, sessionKey, includeRecalled, project } = options;

	return postDaemon<RecallPayload>(
		daemonUrl,
		"/api/memory/recall",
		{
			...buildRecallRequestBody(query, {
				limit,
				agentId,
				sessionKey,
				includeRecalled,
				project,
				recallSurface: "tool_call",
			}),
			sourceOnly: true,
		},
		READ_TIMEOUT,
		"Source search",
	);
}

export async function searchSessions(
	daemonUrl: string,
	query: string,
	options: {
		sessionKey?: string;
		currentSessionKey?: string;
		agentId?: string;
		project?: string;
		limit?: number;
	} = {},
): Promise<unknown> {
	return postDaemon<unknown>(
		daemonUrl,
		"/api/sessions/search",
		{
			query,
			sessionKey: options.sessionKey,
			currentSessionKey: options.currentSessionKey,
			agentId: options.agentId,
			project: options.project,
			limit: options.limit,
		},
		READ_TIMEOUT,
		"Session search",
	);
}

function updateStatus(ctx: PiExtensionContext): void {
	const status = state.lastRecall ? `signet:${state.memoryCount} memories` : "signet:ready";
	ctx.ui.setStatus("signet", ctx.ui.theme.fg("accent", status));
}

function registerSessionLifecycleHandlers(pi: PiExtensionApi, deps: LifecycleDeps, daemonUrl: string): void {
	pi.on("session_start", async (_event, ctx) => {
		const healthy = await checkDaemonHealth(daemonUrl);
		if (healthy) {
			ctx.ui.notify("SignetAI memory connected", "info");
			updateStatus(ctx);
		} else {
			ctx.ui.notify("SignetAI daemon not running. Memory features disabled.", "warning");
			ctx.ui.notify("Install: curl -fsSL https://signetai.sh/install.sh | bash && signet setup", "info");
		}

		await refreshSessionStart(deps, ctx);
	});
	pi.on("session_before_switch", async () => {
		await endPreviousSession(deps, {}, "session_switch");
	});
	pi.on("session_before_fork", async () => {
		await endPreviousSession(deps, {}, "session_fork");
	});

	pi.on("session_switch", async (_event, ctx) => {
		await refreshSessionStart(deps, ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		await refreshSessionStart(deps, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("signet", undefined);
		await endCurrentSession(deps, ctx, "session_shutdown");
	});
}

function registerPromptHandlers(pi: PiExtensionApi, deps: LifecycleDeps): void {
	pi.on("input", async (event: PiInputEvent, ctx) => {
		const session = currentSessionRef(ctx);
		deps.state.clearPendingRecall(session.sessionId);
		deps.state.clearPendingClock(session.sessionId);
		await requestRecallForPrompt(deps, ctx, event.text);
	});

	pi.on(
		"before_agent_start",
		async (event: PiBeforeAgentStartEvent, ctx): Promise<PiBeforeAgentStartResult | undefined> => {
			await ensureSessionContext(deps, ctx);
			const session = currentSessionRef(ctx);
			if (!session.sessionId) return;
			if (deps.state.hasPendingRecall(session.sessionId)) return;
			await requestRecallForPrompt(deps, ctx, event.prompt);
		},
	);
}

interface PiDeps extends LifecycleDeps {
	readonly state: PiSessionState;
}

function registerContextHandlers(pi: PiExtensionApi, deps: PiDeps): void {
	pi.on("context", async (event: PiContextEvent, ctx): Promise<PiContextEventResult | undefined> => {
		const session = currentSessionRef(ctx);
		if (!deps.state.hasPendingRecall(session.sessionId)) {
			await requestNotifications(deps, ctx, "context");
		}
		const hiddenMessages = deps.state.consumeHiddenInjectMessages(session.sessionId);
		if (hiddenMessages.length === 0) return;

		return {
			messages: [...event.messages, ...hiddenMessages],
		};
	});
}

function registerCompactionHandlers(pi: PiExtensionApi, deps: LifecycleDeps): void {
	pi.on("session_before_compact", async (event: PiSessionBeforeCompactEvent, ctx): Promise<undefined> => {
		await ensureSessionContext(deps, ctx);
		const session = currentSessionRef(ctx);
		await deps.client.post<PreCompactionResult>(
			"/api/hooks/pre-compaction",
			{
				harness: HARNESS,
				sessionKey: session.sessionId,
				messageCount: Array.isArray(event.preparation?.messagesToSummarize)
					? event.preparation.messagesToSummarize.length
					: undefined,
				runtimePath: RUNTIME_PATH,
			},
			READ_TIMEOUT,
		);
		return undefined;
	});

	pi.on("session_compact", async (event: PiSessionCompactEvent, ctx) => {
		const summary = readTrimmedString(event.compactionEntry?.summary);
		if (!summary) return;

		const session = currentSessionRef(ctx);
		await deps.client.post(
			"/api/hooks/compaction-complete",
			{
				harness: HARNESS,
				summary,
				project: session.project,
				sessionKey: session.sessionId,
				agentId: deps.agentId,
				runtimePath: RUNTIME_PATH,
			},
			WRITE_TIMEOUT,
		);
	});
}

export interface RememberArgs {
	content: string;
	critical: boolean;
	tags: string[];
}

export function parseRememberArgs(raw: string): RememberArgs {
	let content = raw.trim();
	let critical = false;
	const tags: string[] = [];

	if (content.startsWith("critical:")) {
		critical = true;
		content = content.slice(9).trim();
	}

	const tagMatch = content.match(/^\[([^\]]+)\]:\s*/);
	if (tagMatch) {
		tags.push(...(tagMatch[1]?.split(",").map((t) => t.trim()) ?? []));
		content = content.slice(tagMatch[0].length);
	}

	return { content, critical, tags };
}

function registerCommandsAndTools(pi: PiExtensionApi, daemonUrl: string, agentId: string | undefined): void {
	pi.registerCommand("recall", {
		description: "Search SignetAI memories",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /recall <query>", "warning");
				return;
			}

			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				ctx.ui.notify("Signet daemon not running. Run: signet daemon start", "error");
				return;
			}

			ctx.ui.notify(`Recalling: "${args}"...`, "info");

			try {
				const recall = await recallMemories(daemonUrl, args, { agentId });
				const parsed = parseRecallPayload(recall);

				if (parsed.rows.length === 0) {
					ctx.ui.notify("No relevant memories found", "info");
					return;
				}

				state.lastRecall = new Date().toISOString();
				state.memoryCount = parsed.rows.length;
				updateStatus(ctx);

				ctx.ui.notify(formatRecallText(recall), "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Recall failed: ${message}`, "error");
			}
		},
	});
	pi.registerCommand("remember", {
		description: "Save a memory to SignetAI",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /remember <content>", "warning");
				return;
			}

			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				ctx.ui.notify("Signet daemon not running. Run: signet daemon start", "error");
				return;
			}
			const { content, critical, tags } = parseRememberArgs(args);

			try {
				await rememberContent(daemonUrl, content, { critical, tags, agentId });
				const pinned = critical ? " (pinned)" : "";
				ctx.ui.notify(`Memory saved${pinned}: "${content.substring(0, 50)}..."`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Remember failed: ${message}`, "error");
			}
		},
	});
	pi.registerCommand("signet-status", {
		description: "Check SignetAI daemon status",
		handler: async (_args, ctx) => {
			const healthy = await checkDaemonHealth(daemonUrl);
			const sessionId = ctx.sessionManager.getSessionId();

			if (healthy) {
				const parts = [`Signet daemon is running on ${daemonUrl}`];
				if (sessionId) parts.push(`Session: ${sessionId}`);
				ctx.ui.notify(parts.join("\n"), "success");
				try {
					const response = await fetch(`${daemonUrl}/api/memory/stats`, {
						signal: AbortSignal.timeout(READ_TIMEOUT),
					});
					if (response.ok) {
						const stats = (await response.json()) as Record<string, unknown>;
						ctx.ui.notify(`Memory stats: ${JSON.stringify(stats)}`, "info");
					}
				} catch {}
			} else {
				ctx.ui.notify(
					"Signet daemon not responding.\nInstall: curl -fsSL https://signetai.sh/install.sh | bash && signet setup\nStart: signet daemon start",
					"error",
				);
			}
		},
	});
	pi.registerTool({
		name: "signet_recall",
		label: "Signet Recall",
		description:
			"Search SignetAI persistent memory for relevant context from previous sessions. Use aggregate=true for multi-query synthesis that consolidates scattered memories into a single summary.",
		promptSnippet: "Search past memories when user asks about previous decisions, preferences, or project context",
		promptGuidelines: [
			"Use aggregate=true when the user asks a broad question that likely spans many memories (e.g. 'who is X', 'what happened with Y', 'summarize the history of Z')",
			"Use aggregate=false (default) for targeted lookups of specific facts or single memories",
			"Aggregate recall takes longer (3-5s) but produces higher-quality synthesized answers for complex queries",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query to find relevant memories",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of memories to return (default: 10)",
					default: 10,
				}),
			),
			sessionKey: Type.Optional(
				Type.String({
					description: "Session key for per-context recall dedupe",
				}),
			),
			includeRecalled: Type.Optional(
				Type.Boolean({
					description: "Include rows already recalled in this context",
					default: false,
				}),
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("global"), Type.Literal("agent"), Type.Literal("session")], {
					description: "Recall scope constraint",
				}),
			),
			aggregate: Type.Optional(
				Type.Boolean({
					description:
						"Enable aggregate recall: runs multiple follow-up queries and synthesizes a consolidated answer. Use for broad questions spanning many memories. (default: false)",
					default: false,
				}),
			),
			aggregateBudget: Type.Optional(
				Type.String({
					description:
						"Aggregate synthesis budget: 'small', 'medium', or 'large'. Controls depth of multi-query recall and synthesis. (default: medium)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				return {
					content: [{ type: "text", text: "Signet daemon not running. Memories unavailable." }],
					details: { error: "daemon_offline" },
				};
			}

			try {
				const query = String(params.query || "");
				const limit = typeof params.limit === "number" ? params.limit : undefined;
				const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : undefined;
				const scope =
					typeof params.scope === "string" && ["global", "agent", "session"].includes(params.scope)
						? (params.scope as "global" | "agent" | "session")
						: undefined;
				const isAggregate = params.aggregate === true;
				const aggregateBudget =
					typeof params.aggregateBudget === "string" && ["small", "medium", "large"].includes(params.aggregateBudget)
						? (params.aggregateBudget as "small" | "medium" | "large")
						: undefined;

				const recall = await recallMemories(daemonUrl, query, {
					limit,
					agentId,
					sessionKey,
					includeRecalled: params.includeRecalled === true,
					scope,
					aggregate: isAggregate,
					aggregateBudget,
				});
				const parsed = parseRecallPayload(recall);
				if (isAggregate && recall.aggregate) {
					const aggregateRows = recall.results ?? parsed.rows;
					if (aggregateRows.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found for this query." }],
							details: { memoriesFound: 0 },
						};
					}

					state.lastRecall = new Date().toISOString();
					state.memoryCount = aggregateRows.length;
					updateStatus(ctx);

					const degraded = recall.aggregate.partial === true;
					const parts = [
						degraded ? `[Aggregate Recall degraded] Query: ${query}` : `[Aggregate Recall] Query: ${query}`,
					];
					if (degraded && typeof recall.aggregate.message === "string") parts.push(recall.aggregate.message);
					for (const row of aggregateRows) {
						if (typeof row.content === "string") parts.push(row.content);
					}

					return {
						content: [{ type: "text", text: parts.join("\n\n") }],
						details: {
							memoriesFound: aggregateRows.length,
							memories: aggregateRows,
							aggregate: recall.aggregate,
							meta: parsed.meta,
						},
					};
				}
				if (parsed.rows.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found for this query." }],
						details: { memoriesFound: 0 },
					};
				}

				state.lastRecall = new Date().toISOString();
				state.memoryCount = parsed.rows.length;
				updateStatus(ctx);

				return {
					content: [{ type: "text", text: formatRecallText(recall) }],
					details: { memoriesFound: parsed.rows.length, memories: parsed.rows, meta: parsed.meta },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error recalling memories: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
	pi.registerTool({
		name: "signet_source_search",
		label: "Signet Source Search",
		description:
			"Search Signet source-backed artifacts such as Codex native memory, Obsidian, imported docs, and transcripts.",
		promptSnippet:
			"Search source-backed artifacts when the answer should come from imported files, notes, docs, transcripts, or other provenance-backed sources rather than ordinary saved memories",
		promptGuidelines: [
			"Use this when the user asks about source-backed documents, notes, imported files, or provenance-specific context",
			"Keep source search separate from ordinary memory recall; prefer signet_recall for preferences, decisions, and remembered facts",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Natural-language source search query",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of source results to return (default: 10)",
					default: 10,
				}),
			),
			project: Type.Optional(
				Type.String({
					description: "Optional project path filter",
				}),
			),
			includeRecalled: Type.Optional(
				Type.Boolean({
					description: "Include rows already recalled in this context",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				return {
					content: [{ type: "text", text: "Signet daemon not running. Source search unavailable." }],
					details: { error: "daemon_offline" },
				};
			}

			try {
				const session = currentSessionRef(ctx);
				const query = String(params.query || "");
				const limit = typeof params.limit === "number" ? params.limit : 10;
				const project = typeof params.project === "string" ? params.project : undefined;
				const recall = await searchSourceArtifacts(daemonUrl, query, {
					limit,
					agentId,
					sessionKey: readTrimmedString(session.sessionId),
					includeRecalled: params.includeRecalled === true,
					project,
				});
				const parsed = parseRecallPayload(recall);

				if (parsed.rows.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant source artifacts found for this query." }],
						details: { sourcesFound: 0 },
					};
				}

				return {
					content: [{ type: "text", text: formatRecallText(recall) }],
					details: { sourcesFound: parsed.rows.length, sources: parsed.rows, meta: parsed.meta },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error searching sources: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
	pi.registerTool({
		name: "signet_session_search",
		label: "Signet Session Search",
		description:
			"Search active or completed Signet session transcripts. This is transcript-only and separate from memory recall.",
		promptSnippet:
			"Search Signet session transcripts when prior conversation evidence matters; keep transcript lookup separate from memory recall",
		promptGuidelines: [
			"Use this when the user asks what happened in a prior session, wants transcript evidence, or needs exact conversational context",
			"Prefer signet_recall for durable remembered facts and signet_source_search for source-backed artifacts",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Natural language or keyword query",
			}),
			sessionKey: Type.Optional(
				Type.String({
					description: "Specific transcript session key to search",
				}),
			),
			currentSessionKey: Type.Optional(
				Type.String({
					description: "Current session key; sub-agent lineage may resolve this to the parent session",
				}),
			),
			agentId: Type.Optional(
				Type.String({
					description: "Agent scope; defaults to the configured SIGNET_AGENT_ID when set",
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
					default: 10,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				return {
					content: [{ type: "text", text: "Signet daemon not running. Session search unavailable." }],
					details: { error: "daemon_offline" },
				};
			}

			try {
				const query = String(params.query || "");
				const result = await searchSessions(daemonUrl, query, {
					sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : undefined,
					currentSessionKey: typeof params.currentSessionKey === "string" ? params.currentSessionKey : undefined,
					agentId: typeof params.agentId === "string" ? params.agentId : agentId,
					project: typeof params.project === "string" ? params.project : undefined,
					limit: typeof params.limit === "number" ? params.limit : undefined,
				});

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: { result },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error searching sessions: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
	pi.registerTool({
		name: "signet_remember",
		label: "Signet Remember",
		description: "Save important information to SignetAI persistent memory for future sessions",
		promptSnippet: "Save critical decisions, user preferences, or key facts that should persist across sessions",
		promptGuidelines: [
			"Use this tool when the user explicitly asks to remember something",
			"Save key decisions made during the conversation that would be useful context later",
			"Store user preferences about coding style, tools, or workflows",
			"Mark critical information with critical=true to prevent decay",
		],
		parameters: Type.Object({
			content: Type.String({
				description: "The content to remember",
			}),
			critical: Type.Optional(
				Type.Boolean({
					description: "If true, memory will never decay and is always prioritized",
					default: false,
				}),
			),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tags to categorize this memory for better search",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				return {
					content: [{ type: "text", text: "Signet daemon not running. Cannot save memory." }],
					details: { error: "daemon_offline" },
				};
			}

			try {
				const content = String(params.content || "");
				const critical = Boolean(params.critical);
				const tags = Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === "string") : [];

				await rememberContent(daemonUrl, content, { critical, tags, agentId });

				const pinned = critical ? " (pinned/critical)" : "";
				return {
					content: [{ type: "text", text: `Memory saved${pinned} successfully.` }],
					details: { saved: true, content },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error saving memory: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
}

const SignetPiExtension: PiExtensionFactory = (pi): void => {
	if (!cfg.enabled) {
		return;
	}

	const daemonUrl = readTrimmedRuntimeEnv("SIGNET_DAEMON_URL") ?? DAEMON_URL_DEFAULT;
	const agentId = readTrimmedRuntimeEnv("SIGNET_AGENT_ID");
	if (readRuntimeEnv("SIGNET_BYPASS") !== "1") {
		const deps: PiDeps = {
			agentId,
			client: createDaemonClient(daemonUrl),
			state: createSessionState(),
			config: PI_LIFECYCLE_CONFIG,
		};

		registerSessionLifecycleHandlers(pi, deps, daemonUrl);
		registerPromptHandlers(pi, deps);
		registerContextHandlers(pi, deps);
		registerCompactionHandlers(pi, deps);
	}

	registerCommandsAndTools(pi, daemonUrl, agentId);
};

export default SignetPiExtension;

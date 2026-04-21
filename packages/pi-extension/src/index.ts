import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRecallRequestBody,
	buildRememberRequestBody,
	formatRecallText,
	parseRecallPayload,
	resolvePiAgentDir,
} from "@signet/core";
import type { RecallPayload } from "@signet/core";
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

// ============================================================================
// Configuration
// ============================================================================

interface PiExtensionConfig {
	/** Whether Signet is enabled. Defaults to true if env var/file not set. */
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

	// Env vars override file config
	const envEnabled = readRuntimeEnv("SIGNET_ENABLED");
	const fileEnabled = fileConfig?.enabled;
	// Priority: env var > file > default (true)
	const enabled = envEnabled !== undefined ? envEnabled !== "false" : fileEnabled !== undefined ? fileEnabled : true;

	return { enabled };
}

const cfg = loadConfig();

// ============================================================================
// State
// ============================================================================

interface SignetState {
	lastRecall: string | null;
	memoryCount: number;
}

const state: SignetState = {
	lastRecall: null,
	memoryCount: 0,
};

// ============================================================================
// Daemon Health Check
// ============================================================================

async function checkDaemonHealth(daemonUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${daemonUrl}/health`, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(READ_TIMEOUT),
		});
		return response.ok;
	} catch {
		return false;
	}
}

// ============================================================================
// Memory Operations
// ============================================================================

export async function recallMemories(
	daemonUrl: string,
	query: string,
	options: {
		limit?: number;
		agentId?: string;
		scope?: "global" | "agent" | "session";
	} = {},
): Promise<RecallPayload> {
	const { limit = 10, agentId, scope } = options;

	const response = await fetch(`${daemonUrl}/api/memory/recall`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			buildRecallRequestBody(query, {
				limit,
				agentId,
				scope,
			}),
		),
		signal: AbortSignal.timeout(READ_TIMEOUT),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Recall failed: ${error}`);
	}

	return (await response.json()) as RecallPayload;
}
export async function rememberContent(
	daemonUrl: string,
	content: string,
	options: {
		critical?: boolean;
		tags?: string[];
		agentId?: string;
	} = {},
): Promise<void> {
	const { critical = false, tags = [], agentId } = options;

	const response = await fetch(`${daemonUrl}/api/hooks/remember`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(
			buildRememberRequestBody(content, {
				harness: HARNESS,
				pinned: critical,
				tags,
				agentId,
				source: "pi-extension",
				runtimePath: RUNTIME_PATH,
			}),
		),
		signal: AbortSignal.timeout(WRITE_TIMEOUT),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Remember failed: ${error}`);
	}
}
export async function sendMemoryFeedback(
	daemonUrl: string,
	sessionKey: string,
	ratings: Record<string, number>,
	options: { agentId?: string } = {},
): Promise<{ recorded: number; accepted?: number }> {
	const response = await fetch(`${daemonUrl}/api/memory/feedback`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			sessionKey,
			agentId: options.agentId ?? "default",
			feedback: ratings,
		}),
		signal: AbortSignal.timeout(WRITE_TIMEOUT),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Feedback failed: ${error}`);
	}

	return (await response.json()) as { recorded: number; accepted?: number };
}

function updateStatus(ctx: PiExtensionContext): void {
	const status = state.lastRecall ? `signet:${state.memoryCount} memories` : "signet:ready";
	ctx.ui.setStatus("signet", ctx.ui.theme.fg("accent", status));
}

// ============================================================================
// Lifecycle Handlers
// ============================================================================

function registerSessionLifecycleHandlers(pi: PiExtensionApi, deps: LifecycleDeps, daemonUrl: string): void {
	pi.on("session_start", async (_event, ctx) => {
		const healthy = await checkDaemonHealth(daemonUrl);
		if (healthy) {
			ctx.ui.notify("SignetAI memory connected", "info");
			updateStatus(ctx);
		} else {
			ctx.ui.notify("SignetAI daemon not running. Memory features disabled.", "warning");
			ctx.ui.notify("Install: npm install -g signetai && signet setup", "info");
		}

		await refreshSessionStart(deps, ctx);
	});

	pi.on("session_switch", async (event, ctx) => {
		await endPreviousSession(deps, event, event.type);
		await refreshSessionStart(deps, ctx);
	});

	pi.on("session_fork", async (event, ctx) => {
		await endPreviousSession(deps, event, event.type);
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
		// Pi handles compaction itself; we fire the hook for our own side effects only.
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
		tags.push(...tagMatch[1].split(",").map((t) => t.trim()));
		content = content.slice(tagMatch[0].length);
	}

	return { content, critical, tags };
}

// ============================================================================
// Commands and Tools
// ============================================================================

function registerCommandsAndTools(pi: PiExtensionApi, daemonUrl: string, agentId: string | undefined): void {
	// /recall command
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
				const recall = await recallMemories(daemonUrl, args, { limit: 5, agentId });
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

	// /remember command
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

			// Parse critical prefix and tags
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

	// /signet-status command
	pi.registerCommand("signet-status", {
		description: "Check SignetAI daemon status",
		handler: async (_args, ctx) => {
			const healthy = await checkDaemonHealth(daemonUrl);
			const sessionId = ctx.sessionManager.getSessionId();

			if (healthy) {
				const parts = [`Signet daemon is running on ${daemonUrl}`];
				if (sessionId) parts.push(`Session: ${sessionId}`);
				ctx.ui.notify(parts.join("\n"), "success");

				// Try to get memory count
				try {
					const response = await fetch(`${daemonUrl}/api/memory/stats`, {
						signal: AbortSignal.timeout(READ_TIMEOUT),
					});
					if (response.ok) {
						const stats = (await response.json()) as Record<string, unknown>;
						ctx.ui.notify(`Memory stats: ${JSON.stringify(stats)}`, "info");
					}
				} catch {
					// Stats endpoint may not exist in all versions
				}
			} else {
				ctx.ui.notify(
					"Signet daemon not responding.\nInstall: npm install -g signetai && signet setup\nStart: signet daemon start",
					"error",
				);
			}
		},
	});

	// signet_recall tool
	pi.registerTool({
		name: "signet_recall",
		label: "Signet Recall",
		description: "Search SignetAI persistent memory for relevant context from previous sessions",
		promptSnippet: "Search past memories when user asks about previous decisions, preferences, or project context",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query to find relevant memories",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of memories to return (default: 5)",
					default: 5,
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
				const limit = typeof params.limit === "number" ? params.limit : 5;
				const recall = await recallMemories(daemonUrl, query, { limit, agentId });
				const parsed = parseRecallPayload(recall);

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

	// signet_remember tool
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

	// signet_memory_feedback tool
	pi.registerTool({
		name: "signet_memory_feedback",
		label: "Memory Feedback",
		description:
			"Rate how relevant injected memories were to the conversation. " +
			"Scores from -1 (harmful) to 1 (directly helpful). 0 = unused.",
		promptSnippet:
			"After each turn where injected memories are present, rate every memory's relevance " +
			"so future recall improves. Always call this tool — do not skip feedback.",
		promptGuidelines: [
			"Call this tool EVERY turn that includes injected Signet memories",
			"Rate each memory ID: 1 = directly helpful, 0 = unused, -1 = harmful/misleading",
			"Do not wait for the user to ask — proactively rate memories after using them",
			"Include ALL injected memory IDs in the ratings map, even unused ones (rate 0)",
		],
		parameters: Type.Object({
			ratings: Type.Record(Type.String(), Type.Number(), {
				description: "Map of memory ID to relevance score (-1 to 1)",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const healthy = await checkDaemonHealth(daemonUrl);
			if (!healthy) {
				return {
					content: [{ type: "text", text: "Signet daemon not running. Cannot record feedback." }],
					details: { error: "daemon_offline" },
				};
			}

			try {
				const ratings = params.ratings as Record<string, number>;
				const session = currentSessionRef(ctx);
				const sessionKey = readTrimmedString(session.sessionId);
				if (!sessionKey) {
					return {
						content: [{ type: "text", text: "Cannot record feedback: session not initialized." }],
						details: { error: "no_session" },
					};
				}

				const result = await sendMemoryFeedback(daemonUrl, sessionKey, ratings, { agentId });

				return {
					content: [
						{
							type: "text",
							text: `Recorded feedback for ${result.recorded} memories (${result.accepted ?? result.recorded} accepted).`,
						},
					],
					details: result,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Error recording feedback: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},
	});
}

// ============================================================================
// Main Extension
// ============================================================================

const SignetPiExtension: PiExtensionFactory = (pi): void => {
	// Early return if globally disabled - nothing gets registered
	if (!cfg.enabled) {
		return;
	}

	const daemonUrl = readTrimmedRuntimeEnv("SIGNET_DAEMON_URL") ?? DAEMON_URL_DEFAULT;
	const agentId = readTrimmedRuntimeEnv("SIGNET_AGENT_ID");

	// Bypass mode: skip automatic hooks but keep commands and tools
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

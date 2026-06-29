/**
 * Signet plugin for OpenCode.
 *
 * Integrates Signet's persistent memory with OpenCode via the
 * daemon API. Handles session lifecycle hooks and exposes 8 memory
 * tools to the agent.
 *
 * Usage in opencode.json:
 * ```json
 * { "plugin": ["@signet/opencode-plugin"] }
 * ```
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	readStaticIdentity,
	resolvePromptSubmitTimeoutMs,
	resolveSessionStartTimeoutMs,
} from "@signet/core";
import { createDaemonClient } from "./daemon-client.js";
import { createTools } from "./tools.js";
import {
	DAEMON_URL_DEFAULT,
	FETCH_TIMEOUT_ENV,
	HARNESS,
	PROMPT_SUBMIT_TIMEOUT_ENV,
	READ_TIMEOUT,
	RUNTIME_PATH,
	SESSION_START_TIMEOUT_ENV,
	WRITE_TIMEOUT,
} from "./types.js";

// ============================================================================
// Session context carried between hooks
// ============================================================================

interface SessionStartResult {
	readonly inject?: string;
	readonly recentContext?: string;
}

interface PreCompactionResult {
	readonly guidelines?: string;
	readonly summaryPrompt?: string;
}

interface UserPromptSubmitResult {
	readonly inject?: string;
	readonly memoryCount?: number;
}

// Per-prompt inject cache: consumed once by system.transform after chat.message populates it.
// Capped to prevent unbounded growth if sessions die between the two hooks.
const MAX_PENDING = 64;
const pendingInject = new Map<string, string>();

function pendingInjectSet(sessionID: string, inject: string): void {
	if (!pendingInject.has(sessionID) && pendingInject.size >= MAX_PENDING) {
		const oldest = pendingInject.keys().next().value;
		if (oldest !== undefined) pendingInject.delete(oldest);
	}
	const existing = pendingInject.get(sessionID);
	pendingInject.set(sessionID, existing ? `${existing}\n${inject}` : inject);
}

function readRuntimeEnv(name: string): string | undefined {
	const runtimeProcess = Reflect.get(globalThis, "process");
	if (!runtimeProcess || typeof runtimeProcess !== "object") {
		return undefined;
	}

	const runtimeEnv = Reflect.get(runtimeProcess, "env");
	if (!runtimeEnv || typeof runtimeEnv !== "object") {
		return undefined;
	}

	const value = Reflect.get(runtimeEnv, name);
	return typeof value === "string" ? value : undefined;
}

// ============================================================================
// Static identity fallback when daemon is unreachable
// ============================================================================

// Thin wrapper: uses readRuntimeEnv for safe env access (OpenCode may run in
// non-standard runtimes where process.env is not directly accessible), then
// delegates all file reading and budget logic to @signet/core.
function staticFallback(): string {
	const dir = readRuntimeEnv("SIGNET_PATH") ?? join(homedir(), ".agents");
	return readStaticIdentity(dir) ?? "";
}

function sessionStartFallback(reason: "offline" | "timeout"): string {
	const dir = readRuntimeEnv("SIGNET_PATH") ?? join(homedir(), ".agents");
	if (reason === "timeout") {
		return readStaticIdentity(dir, STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS) ?? "";
	}
	return readStaticIdentity(dir) ?? "";
}

function sessionStartTimeout(): number {
	return resolveSessionStartTimeoutMs(readRuntimeEnv(SESSION_START_TIMEOUT_ENV) ?? readRuntimeEnv(FETCH_TIMEOUT_ENV));
}

function promptSubmitTimeout(): number {
	return resolvePromptSubmitTimeoutMs(readRuntimeEnv(PROMPT_SUBMIT_TIMEOUT_ENV));
}

// ============================================================================
// Event helpers
// ============================================================================

// session.idle provides properties.sessionID directly.
// session.deleted provides properties.info.id (Session object).
function extractSessionId(props: Record<string, unknown> | undefined): string | undefined {
	if (!props) return undefined;
	if (typeof props.id === "string") return props.id;
	if (typeof props.sessionID === "string") return props.sessionID;
	if (typeof props.sessionId === "string") return props.sessionId;
	const info = props.info;
	if (typeof info !== "object" || info === null) return undefined;
	const id = Reflect.get(info, "id");
	if (typeof id === "string") return id;
	const sessionID = Reflect.get(info, "sessionID");
	if (typeof sessionID === "string") return sessionID;
	const sessionId = Reflect.get(info, "sessionId");
	if (typeof sessionId === "string") return sessionId;
	return undefined;
}

function extractParentSessionId(props: Record<string, unknown> | undefined): string | undefined {
	if (!props) return undefined;
	if (typeof props.parentID === "string") return props.parentID;
	if (typeof props.parentId === "string") return props.parentId;
	const info = props.info;
	if (typeof info !== "object" || info === null) return undefined;
	const parentID = Reflect.get(info, "parentID");
	if (typeof parentID === "string") return parentID;
	const parentId = Reflect.get(info, "parentId");
	return typeof parentId === "string" ? parentId : undefined;
}

// ============================================================================
// Transcript builder — fetches messages via OpenCode SDK and formats
// a plain-text transcript for the daemon summary worker.
// ============================================================================

async function buildTranscript(oc: PluginInput["client"], sid: string): Promise<string> {
	const res = await oc.session.messages({
		path: { id: sid },
		throwOnError: false,
	});
	if (!res.data) return "";

	const lines: string[] = [];
	for (const msg of res.data) {
		const role = msg.info.role === "user" ? "User" : "Assistant";
		for (const part of msg.parts) {
			if (part.type !== "text") continue;
			const text = part.text?.trim().replace(/\s*\r?\n\s*/g, " ");
			if (text) lines.push(`${role}: ${text}`);
		}
	}
	return lines.join("\n");
}

function readPartText(part: unknown): string | null {
	if (typeof part !== "object" || part === null) return null;
	const type = Reflect.get(part, "type");
	if (type !== "text") return null;
	const text = Reflect.get(part, "text");
	return typeof text === "string" ? text : null;
}

// ============================================================================
// Plugin
// ============================================================================

export const SignetPlugin: Plugin = async ({ directory, client: oc }) => {
	const enabled = readRuntimeEnv("SIGNET_ENABLED") !== "false";
	if (!enabled) return {};

	const daemonUrl = readRuntimeEnv("SIGNET_DAEMON_URL") ?? DAEMON_URL_DEFAULT;
	const agentId = readRuntimeEnv("SIGNET_AGENT_ID");

	const client = createDaemonClient(daemonUrl);

	let sessionContext = "";
	const startedSessions = new Set<string>();
	const startingSessions = new Map<string, Promise<string>>();
	const parentBySession = new Map<string, string>();
	const start = await client.postResult<SessionStartResult>(
		"/api/hooks/session-start",
		{
			harness: HARNESS,
			project: directory,
			agentId,
			runtimePath: RUNTIME_PATH,
		},
		sessionStartTimeout(),
	);
	if (start.ok) {
		sessionContext = start.data.inject ?? start.data.recentContext ?? "";
	} else if (start.reason === "timeout") {
		sessionContext = sessionStartFallback("timeout");
	} else {
		// offline, http error, invalid-json — all fall back to static identity
		sessionContext = staticFallback();
	}

	async function ensureSessionStarted(sessionID: string): Promise<string> {
		if (startedSessions.has(sessionID)) return "";
		const existing = startingSessions.get(sessionID);
		if (existing) {
			await existing;
			return "";
		}

		const startSession = client
			.post<SessionStartResult>(
				"/api/hooks/session-start",
				{
					harness: HARNESS,
					project: directory,
					agentId,
					sessionKey: sessionID,
					parentSessionKey: parentBySession.get(sessionID),
					runtimePath: RUNTIME_PATH,
				},
				sessionStartTimeout(),
			)
			.then((result) => {
				startedSessions.add(sessionID);
				return result?.inject ?? "";
			});
		startingSessions.set(sessionID, startSession);
		try {
			return await startSession;
		} finally {
			startingSessions.delete(sessionID);
		}
	}

	return {
		// ------------------------------------------------------------------
		// Record skill usage — OpenCode runs skills via the `skill` tool,
		// whose args carry { name }. Recorded as a source='agent' invocation.
		// ------------------------------------------------------------------
		"tool.execute.after": async (input, output): Promise<void> => {
			if (input.tool !== "skill") return;
			const skillName = typeof input.args?.name === "string" ? input.args.name : "";
			if (!skillName) return;
			// opencode's execute.after carries no structured success flag — its output
			// is { title, output, metadata } and the ToolStateError status lives on the
			// message part, not here. Best-effort: treat a metadata.error as failure,
			// else assume success. ponytail: tighten if opencode exposes a state flag.
			const meta = output?.metadata as Record<string, unknown> | undefined;
			const success = !(meta && typeof meta === "object" && "error" in meta);
			void client
				.post("/api/hooks/skill-invocation", {
					harness: HARNESS,
					skillName,
					agentId,
					sessionId: input.sessionID,
					toolUseId: input.callID,
					cwd: directory,
					args: JSON.stringify(input.args),
					success,
					origin: "plugin",
					runtimePath: RUNTIME_PATH,
				})
				.catch(() => {});
		},

		// ------------------------------------------------------------------
		// Per-prompt memory recall — extract user text and call daemon
		// ------------------------------------------------------------------

		"chat.message": async (input, output): Promise<void> => {
			const userText = output.parts
				.map((part) => readPartText(part))
				.filter((text): text is string => text !== null)
				.join("\n")
				.trim();
			if (!userText) return;

			// Clear any unconsumed inject from a prior prompt for this session
			pendingInject.delete(input.sessionID);

			try {
				try {
					const startInject = await ensureSessionStarted(input.sessionID);
					if (startInject) pendingInjectSet(input.sessionID, startInject);
				} catch {
					// Session-start context is optional; still run prompt-submit so
					// recall and transcript capture stay fail-open independently.
				}

				const result = await client.post<UserPromptSubmitResult>(
					"/api/hooks/user-prompt-submit",
					{
						harness: HARNESS,
						project: directory,
						agentId,
						sessionKey: input.sessionID,
						userMessage: userText,
						runtimePath: RUNTIME_PATH,
					},
					promptSubmitTimeout(),
				);
				if (result?.inject) {
					pendingInjectSet(input.sessionID, result.inject);
				}
			} catch {
				// never block the user's message
			}
		},

		// ------------------------------------------------------------------
		// Inject per-prompt context into the system prompt
		// ------------------------------------------------------------------
		"experimental.chat.system.transform": async (input, output): Promise<void> => {
			if (!input.sessionID) return;
			let startInject = "";
			try {
				startInject = await ensureSessionStarted(input.sessionID);
			} catch {
				// Signet context is optional; never break OpenCode prompt rendering.
			}
			const inject = pendingInject.get(input.sessionID);
			const parts = [startInject, inject].filter((part) => part?.trim());
			if (parts.length > 0) {
				output.system.push(parts.join("\n"));
			}
			if (inject) {
				pendingInject.delete(input.sessionID);
			}
		},

		// ------------------------------------------------------------------
		// Inject memory context before context compaction
		// ------------------------------------------------------------------
		"experimental.session.compacting": async (input, output): Promise<void> => {
			try {
				const result = await client.post<PreCompactionResult>(
					"/api/hooks/pre-compaction",
					{
						harness: HARNESS,
						agentId,
						sessionKey: input.sessionID,
						runtimePath: RUNTIME_PATH,
					},
					READ_TIMEOUT,
				);
				if (result?.guidelines) {
					output.context.push(result.guidelines);
				} else if (sessionContext) {
					output.context.push(sessionContext);
				}
			} catch {
				// never block compaction
			}
		},

		// ------------------------------------------------------------------
		// Event hook — session idle / deleted → session end
		//             session.compacted → compaction-complete
		// ------------------------------------------------------------------
		event: async ({
			event,
		}: {
			event: {
				type: string;
				summary?: string;
				properties?: Record<string, unknown>;
			};
		}): Promise<void> => {
			try {
				if (event.type === "session.created") {
					const sid = extractSessionId(event.properties);
					const parent = extractParentSessionId(event.properties);
					if (sid && parent) parentBySession.set(sid, parent);
				}

				if (event.type === "session.idle" || event.type === "session.deleted") {
					const sid = extractSessionId(event.properties);

					let transcript = "";
					if (sid) {
						try {
							transcript = await buildTranscript(oc, sid);
						} catch {
							// non-fatal — send without transcript
						}
					}

					client
						.post(
							"/api/hooks/session-end",
							{
								harness: HARNESS,
								agentId,
								runtimePath: RUNTIME_PATH,
								reason: event.type,
								sessionKey: sid,
								...(transcript ? { transcript } : {}),
							},
							WRITE_TIMEOUT,
						)
						.catch((e) => {
							console.warn("[signet] session-end fire-and-forget failed:", e);
						});
					if (sid) {
						startedSessions.delete(sid);
						parentBySession.delete(sid);
						pendingInject.delete(sid);
					}
				}

				if (event.type === "session.compacted" && event.summary) {
					const sid = extractSessionId(event.properties);
					await client.post(
						"/api/hooks/compaction-complete",
						{
							harness: HARNESS,
							summary: event.summary,
							project: directory,
							sessionKey: sid || undefined,
							runtimePath: RUNTIME_PATH,
						},
						WRITE_TIMEOUT,
					);
				}
			} catch {
				// never surface lifecycle errors to the user
			}
		},

		// ------------------------------------------------------------------
		// Memory tools
		// ------------------------------------------------------------------
		tool: createTools(client),
	};
};

export default SignetPlugin;

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

import type { Plugin } from "@opencode-ai/plugin";
import { createDaemonClient } from "./daemon-client.js";
import { createTools } from "./tools.js";
import {
	DAEMON_URL_DEFAULT,
	HARNESS,
	READ_TIMEOUT,
	RUNTIME_PATH,
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

// Tighter timeout for the prompt-submit path — this blocks every user message,
// so we can't afford the full 5s READ_TIMEOUT if the daemon is slow.
const PROMPT_SUBMIT_TIMEOUT = 2000;

// Per-prompt inject cache: consumed once by system.transform after chat.message populates it.
// Capped to prevent unbounded growth if sessions die between the two hooks.
const MAX_PENDING = 64;
const pendingInject = new Map<string, string>();

function pendingInjectSet(sessionID: string, inject: string): void {
	if (!pendingInject.has(sessionID) && pendingInject.size >= MAX_PENDING) {
		const oldest = pendingInject.keys().next().value;
		if (oldest !== undefined) pendingInject.delete(oldest);
	}
	pendingInject.set(sessionID, inject);
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
// Plugin
// ============================================================================

export const SignetPlugin: Plugin = async ({ directory }) => {
	const enabled = readRuntimeEnv("SIGNET_ENABLED") !== "false";
	if (!enabled) return {};

	const daemonUrl = readRuntimeEnv("SIGNET_DAEMON_URL") ?? DAEMON_URL_DEFAULT;
	const agentId = readRuntimeEnv("SIGNET_AGENT_ID");

	const client = createDaemonClient(daemonUrl);

	// Fire session-start — errors are swallowed so we never block the user.
	let sessionContext = "";
	try {
		const result = await client.post<SessionStartResult>(
			"/api/hooks/session-start",
			{
				harness: HARNESS,
				project: directory,
				agentId,
				runtimePath: RUNTIME_PATH,
			},
			READ_TIMEOUT,
		);
		sessionContext = result?.inject ?? result?.recentContext ?? "";
	} catch {
		// daemon not running — continue without memory context
	}

	return {
		// ------------------------------------------------------------------
		// Per-prompt memory recall — extract user text and call daemon
		// ------------------------------------------------------------------
		"chat.message": async (
			input: { sessionID: string },
			output: { parts: ReadonlyArray<{ type: string; text?: string }> },
		): Promise<void> => {
			const userText = output.parts
				.filter(
					(p): p is { type: "text"; text: string } =>
						p.type === "text" && typeof p.text === "string",
				)
				.map((p) => p.text)
				.join("\n")
				.trim();
			if (!userText) return;

			// Clear any unconsumed inject from a prior prompt for this session
			pendingInject.delete(input.sessionID);

			try {
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
					PROMPT_SUBMIT_TIMEOUT,
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
		"experimental.chat.system.transform": async (
			input: { sessionID: string },
			output: { system: string[] },
		): Promise<void> => {
			const inject = pendingInject.get(input.sessionID);
			if (inject) {
				pendingInject.delete(input.sessionID);
				output.system.push(inject);
			}
		},

		// ------------------------------------------------------------------
		// Inject memory context before context compaction
		// ------------------------------------------------------------------
		"experimental.session.compacting": async (
			_input: unknown,
			output: { context: string[] },
		): Promise<void> => {
			try {
				const result = await client.post<PreCompactionResult>(
					"/api/hooks/pre-compaction",
					{
						harness: HARNESS,
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
		}: { event: { type: string; summary?: string } }): Promise<void> => {
			try {
				if (event.type === "session.idle" || event.type === "session.deleted") {
					await client.post(
						"/api/hooks/session-end",
						{
							harness: HARNESS,
							runtimePath: RUNTIME_PATH,
							reason: event.type,
						},
						WRITE_TIMEOUT,
					);
				}

				if (event.type === "session.compacted" && event.summary) {
					await client.post(
						"/api/hooks/compaction-complete",
						{
							harness: HARNESS,
							summary: event.summary,
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

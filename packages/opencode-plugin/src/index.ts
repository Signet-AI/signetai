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

	const client = createDaemonClient(daemonUrl);

	// Fire session-start — errors are swallowed so we never block the user.
	let sessionContext = "";
	try {
		const result = await client.post<SessionStartResult>(
			"/api/hooks/session-start",
			{
				harness: HARNESS,
				project: directory,
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

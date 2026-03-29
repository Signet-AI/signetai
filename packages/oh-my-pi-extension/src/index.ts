import { createDaemonClient } from "./daemon-client.js";
import { readRuntimeEnv, readTrimmedRuntimeEnv, readTrimmedString } from "./helpers.js";
import {
	type LifecycleDeps,
	currentSessionRef,
	endCurrentSession,
	endPreviousSession,
	ensureSessionContext,
	refreshSessionStart,
	requestRecallForPrompt,
} from "./lifecycle.js";
import { createSessionState } from "./session-state.js";
import {
 	DAEMON_URL_DEFAULT,
 	HARNESS,
 	type OmpBeforeAgentStartEvent,
 	type OmpExtensionApi,
 	type OmpExtensionFactory,
 	type OmpInputEvent,
 	type OmpSessionCompactEvent,
 	type OmpSessionCompactingEvent,
 	type OmpSessionCompactingResult,
 	type PreCompactionResult,
 	READ_TIMEOUT,
 	RUNTIME_PATH,
 	WRITE_TIMEOUT,
} from "./types.js";

function registerSessionLifecycleHandlers(pi: OmpExtensionApi, deps: LifecycleDeps): void {
	pi.on("session_start", async (_event, ctx) => {
		await refreshSessionStart(deps, ctx);
	});

	pi.on("session_switch", async (event, ctx) => {
		await endPreviousSession(deps, event, event.type);
		await refreshSessionStart(deps, ctx);
	});

	pi.on("session_branch", async (event, ctx) => {
		await endPreviousSession(deps, event, event.type);
		await refreshSessionStart(deps, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await endCurrentSession(deps, ctx, "session_shutdown");
	});
}

function registerPromptHandlers(pi: OmpExtensionApi, deps: LifecycleDeps): void {
	pi.on("input", async (event: OmpInputEvent, ctx) => {
		const session = currentSessionRef(ctx);
		deps.state.clearPendingRecall(session.sessionId);
		await requestRecallForPrompt(deps, ctx, event.text);
	});

	pi.on("before_agent_start", async (event: OmpBeforeAgentStartEvent, ctx) => {
		await ensureSessionContext(deps, ctx);
		const session = currentSessionRef(ctx);
		if (!session.sessionId) return;
		if (!deps.state.hasPendingRecall(session.sessionId)) {
			await requestRecallForPrompt(deps, ctx, event.prompt);
		}

		const hiddenMessage = deps.state.consumePersistentHiddenInject(session.sessionId);
		if (!hiddenMessage) return;

		return { message: hiddenMessage };
	});
}


function registerCompactionHandlers(pi: OmpExtensionApi, deps: LifecycleDeps): void {
	pi.on(
		"session.compacting",
		async (event: OmpSessionCompactingEvent, ctx): Promise<OmpSessionCompactingResult | undefined> => {
			await ensureSessionContext(deps, ctx);
			const session = currentSessionRef(ctx);
			const result = await deps.client.post<PreCompactionResult>(
				"/api/hooks/pre-compaction",
				{
					harness: HARNESS,
					sessionKey: session.sessionId ?? readTrimmedString(event.sessionId),
					messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
					runtimePath: RUNTIME_PATH,
				},
				READ_TIMEOUT,
			);

			if (!result && !deps.state.getSessionContext()) return;

			const contextLine = readTrimmedString(result?.guidelines) ?? readTrimmedString(deps.state.getSessionContext());
			const prompt = readTrimmedString(result?.summaryPrompt);
			if (!contextLine && !prompt) return;

			return {
				context: contextLine ? [contextLine] : undefined,
				prompt,
			};
		},
	);

	pi.on("session_compact", async (event: OmpSessionCompactEvent, ctx) => {
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

const SignetOhMyPiExtension: OmpExtensionFactory = (pi): void => {
	if (readRuntimeEnv("SIGNET_ENABLED") === "false") {
		return;
	}

	const deps: LifecycleDeps = {
		agentId: readTrimmedRuntimeEnv("SIGNET_AGENT_ID"),
		client: createDaemonClient(readTrimmedRuntimeEnv("SIGNET_DAEMON_URL") ?? DAEMON_URL_DEFAULT),
		state: createSessionState(),
	};

	registerSessionLifecycleHandlers(pi, deps);
	registerPromptHandlers(pi, deps);
	registerCompactionHandlers(pi, deps);
};

export default SignetOhMyPiExtension;

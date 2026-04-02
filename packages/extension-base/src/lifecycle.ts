import { homedir } from "node:os";
import { join } from "node:path";
import { readStaticIdentity } from "@signet/core";
import type { DaemonClient } from "./daemon-client.js";
import { readTrimmedRuntimeEnv, readTrimmedString } from "./helpers.js";
import type { BaseSessionState } from "./session-state.js";
import { buildTranscriptFromEntries, readSessionFileSnapshot } from "./transcript.js";
import type { BaseExtensionContext, BaseSessionEntry } from "./types.js";

export interface SessionStartResult {
	readonly inject?: string;
	readonly recentContext?: string;
}

export interface UserPromptSubmitResult {
	readonly inject?: string;
	readonly memoryCount?: number;
	readonly sessionKnown?: boolean;
}

export interface SessionRef {
	readonly sessionId: string | undefined;
	readonly sessionFile: string | undefined;
	readonly project: string | undefined;
}

interface SessionEndPayload {
	readonly sessionId: string | undefined;
	readonly agentId: string | undefined;
	readonly transcript: string | undefined;
	readonly reason: string;
	readonly project: string | undefined;
}

export interface LifecycleConfig {
	readonly harness: string;
	readonly runtimePath: string;
	readonly writeTimeout: number;
	readonly promptSubmitTimeout: number;
	readonly excludedCustomTypes: ReadonlySet<string>;
	readonly sessionStartTimeout: () => number;
	readonly staticFallback: (reason: "offline" | "timeout") => string;
}

export interface LifecycleDeps {
	readonly agentId: string | undefined;
	readonly client: DaemonClient;
	readonly state: BaseSessionState;
	readonly config: LifecycleConfig;
}

export function defaultStaticFallback(_reason: "offline" | "timeout"): string {
	const signetPath = readTrimmedRuntimeEnv("SIGNET_PATH") ?? join(homedir(), ".agents");
	return readStaticIdentity(signetPath) ?? "";
}

function getSessionEntries(ctx: BaseExtensionContext): ReadonlyArray<BaseSessionEntry> {
	const fromBranch = ctx.sessionManager.getBranch();
	if (Array.isArray(fromBranch) && fromBranch.length > 0) {
		return fromBranch;
	}
	const allEntries = ctx.sessionManager.getEntries();
	return Array.isArray(allEntries) ? allEntries : [];
}

export function currentSessionRef(ctx: BaseExtensionContext): SessionRef {
	const header = ctx.sessionManager.getHeader();
	const sessionId = readTrimmedString(ctx.sessionManager.getSessionId()) ?? readTrimmedString(header?.id);
	const sessionFile = readTrimmedString(ctx.sessionManager.getSessionFile());
	const project =
		readTrimmedString(ctx.cwd) ??
		readTrimmedString(header?.cwd) ??
		readTrimmedString(header?.project) ??
		readTrimmedString(header?.workspace);
	return { sessionId, sessionFile, project };
}

async function submitSessionEnd(deps: LifecycleDeps, payload: SessionEndPayload): Promise<boolean> {
	const result = await deps.client.post(
		"/api/hooks/session-end",
		{
			harness: deps.config.harness,
			runtimePath: deps.config.runtimePath,
			reason: payload.reason,
			sessionKey: payload.sessionId,
			sessionId: payload.sessionId,
			agentId: payload.agentId,
			cwd: payload.project,
			...(payload.transcript ? { transcript: payload.transcript } : {}),
		},
		deps.config.writeTimeout,
	);
	return result !== null;
}

export async function flushPendingSessionEnds(deps: LifecycleDeps): Promise<void> {
	for (const pending of deps.state.getPendingSessionEnds()) {
		if (deps.state.sessionAlreadyEnded(pending.sessionId)) {
			deps.state.clearPendingSessionEnd(pending.sessionId);
			continue;
		}

		const snapshot = readSessionFileSnapshot(pending.sessionFile, deps.config.excludedCustomTypes);
		if (!snapshot.loaded) continue;

		const submitted = await submitSessionEnd(deps, {
			sessionId: snapshot.sessionId ?? pending.sessionId,
			agentId: pending.agentId,
			transcript: snapshot.transcript,
			reason: pending.reason,
			project: snapshot.project,
		});
		if (!submitted) continue;

		deps.state.markSessionEnded(pending.sessionId);
		deps.state.clearPendingSessionData(pending.sessionId);
		deps.state.clearPendingSessionEnd(pending.sessionId);
	}
}

export async function refreshSessionStart(deps: LifecycleDeps, ctx: BaseExtensionContext): Promise<void> {
	await flushPendingSessionEnds(deps);

	const session = currentSessionRef(ctx);
	deps.state.setActiveSession(session.sessionId, session.sessionFile);
	deps.state.clearSessionEnded(session.sessionId);

	const result = await deps.client.postResult<SessionStartResult>(
		"/api/hooks/session-start",
		{
			harness: deps.config.harness,
			project: session.project,
			agentId: deps.agentId,
			sessionKey: session.sessionId,
			runtimePath: deps.config.runtimePath,
		},
		deps.config.sessionStartTimeout(),
	);

	const sessionContext = result.ok
		? (result.data.inject ?? result.data.recentContext ?? "")
		: deps.config.staticFallback(result.reason === "timeout" ? "timeout" : "offline");
	deps.state.setSessionContext(sessionContext);
	deps.state.setPendingSessionContext(session.sessionId, sessionContext);
}

export async function ensureSessionContext(deps: LifecycleDeps, ctx: BaseExtensionContext): Promise<void> {
	await flushPendingSessionEnds(deps);

	const current = currentSessionRef(ctx);
	if (!current.sessionId) return;
	if (
		current.sessionId === deps.state.getActiveSessionId() &&
		current.sessionFile === deps.state.getActiveSessionFile()
	) {
		return;
	}
	await refreshSessionStart(deps, ctx);
}

export async function endCurrentSession(deps: LifecycleDeps, ctx: BaseExtensionContext, reason: string): Promise<void> {
	await flushPendingSessionEnds(deps);

	const session = currentSessionRef(ctx);
	if (deps.state.sessionAlreadyEnded(session.sessionId)) return;

	const submitted = await submitSessionEnd(deps, {
		sessionId: session.sessionId,
		agentId: deps.agentId,
		transcript: buildTranscriptFromEntries(getSessionEntries(ctx), deps.config.excludedCustomTypes),
		reason,
		project: session.project,
	});
	if (!submitted) return;

	deps.state.markSessionEnded(session.sessionId);
	deps.state.clearPendingSessionData(session.sessionId);
}

export async function endPreviousSession(
	deps: LifecycleDeps,
	event: { previousSessionFile?: string },
	reason: string,
): Promise<void> {
	const previousSessionFile = readTrimmedString(event.previousSessionFile) ?? deps.state.getActiveSessionFile();
	const previousSnapshot = readSessionFileSnapshot(previousSessionFile, deps.config.excludedCustomTypes);
	const sessionId = previousSnapshot.sessionId ?? deps.state.getActiveSessionId();
	if (deps.state.sessionAlreadyEnded(sessionId)) return;

	if (!previousSnapshot.loaded) {
		if (sessionId && previousSessionFile) {
			deps.state.queuePendingSessionEnd(sessionId, previousSessionFile, deps.agentId, reason);
		}
		return;
	}

	const submitted = await submitSessionEnd(deps, {
		sessionId,
		agentId: deps.agentId,
		transcript: previousSnapshot.transcript,
		reason,
		project: previousSnapshot.project,
	});
	if (!submitted) {
		if (sessionId && previousSessionFile) {
			deps.state.queuePendingSessionEnd(sessionId, previousSessionFile, deps.agentId, reason);
		}
		return;
	}

	deps.state.markSessionEnded(sessionId);
	deps.state.clearPendingSessionData(sessionId);
}

export async function requestRecallForPrompt(
	deps: LifecycleDeps,
	ctx: BaseExtensionContext,
	userText: string,
): Promise<void> {
	await flushPendingSessionEnds(deps);

	const prompt = readTrimmedString(userText);
	if (!prompt) return;

	await ensureSessionContext(deps, ctx);
	const session = currentSessionRef(ctx);
	if (!session.sessionId) return;

	const result = await deps.client.post<UserPromptSubmitResult>(
		"/api/hooks/user-prompt-submit",
		{
			harness: deps.config.harness,
			project: session.project,
			agentId: deps.agentId,
			sessionKey: session.sessionId,
			userMessage: prompt,
			runtimePath: deps.config.runtimePath,
		},
		deps.config.promptSubmitTimeout,
	);
	if (!result) return;

	if (result.sessionKnown === false) {
		await refreshSessionStart(deps, ctx);
	}

	const inject = readTrimmedString(result.inject);
	if (inject) {
		deps.state.queuePendingRecall(session.sessionId, inject);
	}
}

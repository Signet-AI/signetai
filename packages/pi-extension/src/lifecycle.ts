import { homedir } from "node:os";
import { join } from "node:path";
import { readStaticIdentity } from "@signet/core";
import { readTrimmedRuntimeEnv, readTrimmedString, buildTranscriptFromEntries, readSessionFileSnapshot } from "@signet/extension-base";
import type { DaemonClient } from "./daemon-client.js";
import type { SessionState } from "./session-state.js";
import {
	HARNESS,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	type PiExtensionContext,
	type PiSessionEntry,
	type PiSessionSwitchEvent,
	PROMPT_SUBMIT_TIMEOUT,
	READ_TIMEOUT,
	RUNTIME_PATH,
	type SessionStartResult,
	type UserPromptSubmitResult,
	WRITE_TIMEOUT,
} from "./types.js";

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

export interface LifecycleDeps {
	readonly agentId: string | undefined;
	readonly client: DaemonClient;
	readonly state: SessionState;
}

const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
]);

function staticFallback(): string {
	const signetPath = readTrimmedRuntimeEnv("SIGNET_PATH") ?? join(homedir(), ".agents");
	return readStaticIdentity(signetPath) ?? "";
}

function getSessionEntries(ctx: PiExtensionContext): ReadonlyArray<PiSessionEntry> {
	const fromBranch = ctx.sessionManager.getBranch();
	if (Array.isArray(fromBranch) && fromBranch.length > 0) {
		return fromBranch;
	}
	const allEntries = ctx.sessionManager.getEntries();
	return Array.isArray(allEntries) ? allEntries : [];
}

export function currentSessionRef(ctx: PiExtensionContext): SessionRef {
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

async function submitSessionEnd(client: DaemonClient, payload: SessionEndPayload): Promise<boolean> {
	const result = await client.post(
		"/api/hooks/session-end",
		{
			harness: HARNESS,
			runtimePath: RUNTIME_PATH,
			reason: payload.reason,
			sessionKey: payload.sessionId,
			sessionId: payload.sessionId,
			agentId: payload.agentId,
			cwd: payload.project,
			...(payload.transcript ? { transcript: payload.transcript } : {}),
		},
		WRITE_TIMEOUT,
	);
	return result !== null;
}

export async function flushPendingSessionEnds(deps: LifecycleDeps): Promise<void> {
	for (const pending of deps.state.getPendingSessionEnds()) {
		if (deps.state.sessionAlreadyEnded(pending.sessionId)) {
			deps.state.clearPendingSessionEnd(pending.sessionId);
			continue;
		}

		const snapshot = readSessionFileSnapshot(pending.sessionFile, EXCLUDED_CUSTOM_TYPES);
		if (!snapshot.loaded) continue;

		const submitted = await submitSessionEnd(deps.client, {
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

export async function refreshSessionStart(deps: LifecycleDeps, ctx: PiExtensionContext): Promise<void> {
	await flushPendingSessionEnds(deps);

	const session = currentSessionRef(ctx);
	deps.state.setActiveSession(session.sessionId, session.sessionFile);
	deps.state.clearSessionEnded(session.sessionId);

	const result = await deps.client.post<SessionStartResult>(
		"/api/hooks/session-start",
		{
			harness: HARNESS,
			project: session.project,
			agentId: deps.agentId,
			sessionKey: session.sessionId,
			runtimePath: RUNTIME_PATH,
		},
		READ_TIMEOUT,
	);

	const sessionContext = result === null ? staticFallback() : (result.inject ?? result.recentContext ?? "");
	deps.state.setSessionContext(sessionContext);
	deps.state.setPendingSessionContext(session.sessionId, sessionContext);
}

export async function ensureSessionContext(deps: LifecycleDeps, ctx: PiExtensionContext): Promise<void> {
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

export async function endCurrentSession(deps: LifecycleDeps, ctx: PiExtensionContext, reason: string): Promise<void> {
	await flushPendingSessionEnds(deps);

	const session = currentSessionRef(ctx);
	if (deps.state.sessionAlreadyEnded(session.sessionId)) return;

	const submitted = await submitSessionEnd(deps.client, {
		sessionId: session.sessionId,
		agentId: deps.agentId,
		transcript: buildTranscriptFromEntries(getSessionEntries(ctx), EXCLUDED_CUSTOM_TYPES),
		reason,
		project: session.project,
	});
	if (!submitted) return;

	deps.state.markSessionEnded(session.sessionId);
	deps.state.clearPendingSessionData(session.sessionId);
}

export async function endPreviousSession(
	deps: LifecycleDeps,
	event: PiSessionSwitchEvent | { previousSessionFile?: string },
	reason: string,
): Promise<void> {
	const previousSessionFile = readTrimmedString(event.previousSessionFile) ?? deps.state.getActiveSessionFile();
	const previousSnapshot = readSessionFileSnapshot(previousSessionFile, EXCLUDED_CUSTOM_TYPES);
	const sessionId = previousSnapshot.sessionId ?? deps.state.getActiveSessionId();
	if (deps.state.sessionAlreadyEnded(sessionId)) return;

	if (!previousSnapshot.loaded) {
		if (sessionId && previousSessionFile) {
			deps.state.queuePendingSessionEnd(sessionId, previousSessionFile, deps.agentId, reason);
		}
		return;
	}

	const submitted = await submitSessionEnd(deps.client, {
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
	ctx: PiExtensionContext,
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
			harness: HARNESS,
			project: session.project,
			agentId: deps.agentId,
			sessionKey: session.sessionId,
			userMessage: prompt,
			runtimePath: RUNTIME_PATH,
		},
		PROMPT_SUBMIT_TIMEOUT,
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

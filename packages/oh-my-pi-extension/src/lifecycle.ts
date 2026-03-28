import { homedir } from "node:os";
import { join } from "node:path";
import { readStaticIdentity } from "@signet/core";
import type { DaemonClient } from "./daemon-client.js";
import { readRuntimeEnv, readTrimmedString } from "./helpers.js";
import type { SessionState } from "./session-state.js";
import { buildTranscriptFromEntries, readSessionFileSnapshot } from "./transcript.js";
import {
	HARNESS,
	type OmpExtensionContext,
	type OmpSessionEntry,
	type OmpSessionSwitchEvent,
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
	readonly transcript: string | undefined;
	readonly reason: string;
	readonly project: string | undefined;
}

export interface LifecycleDeps {
	readonly agentId: string | undefined;
	readonly client: DaemonClient;
	readonly state: SessionState;
}

function staticFallback(): string {
	const signetPath = readRuntimeEnv("SIGNET_PATH") ?? join(homedir(), ".agents");
	return readStaticIdentity(signetPath) ?? "";
}

function getSessionEntries(ctx: OmpExtensionContext): ReadonlyArray<OmpSessionEntry> {
	const fromBranch = ctx.sessionManager.getBranch();
	if (Array.isArray(fromBranch) && fromBranch.length > 0) {
		return fromBranch;
	}
	const allEntries = ctx.sessionManager.getEntries();
	return Array.isArray(allEntries) ? allEntries : [];
}

export function currentSessionRef(ctx: OmpExtensionContext): SessionRef {
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

async function submitSessionEnd(client: DaemonClient, payload: SessionEndPayload): Promise<void> {
	await client.post(
		"/api/hooks/session-end",
		{
			harness: HARNESS,
			runtimePath: RUNTIME_PATH,
			reason: payload.reason,
			sessionKey: payload.sessionId,
			sessionId: payload.sessionId,
			cwd: payload.project,
			...(payload.transcript ? { transcript: payload.transcript } : {}),
		},
		WRITE_TIMEOUT,
	);
}

export async function refreshSessionStart(deps: LifecycleDeps, ctx: OmpExtensionContext): Promise<void> {
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

export async function ensureSessionContext(deps: LifecycleDeps, ctx: OmpExtensionContext): Promise<void> {
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

export async function endCurrentSession(deps: LifecycleDeps, ctx: OmpExtensionContext, reason: string): Promise<void> {
	const session = currentSessionRef(ctx);
	if (deps.state.sessionAlreadyEnded(session.sessionId)) return;

	await submitSessionEnd(deps.client, {
		sessionId: session.sessionId,
		transcript: buildTranscriptFromEntries(getSessionEntries(ctx)),
		reason,
		project: session.project,
	});

	deps.state.markSessionEnded(session.sessionId);
	deps.state.clearPendingSessionData(session.sessionId);
}

export async function endPreviousSession(
	deps: LifecycleDeps,
	event: OmpSessionSwitchEvent | { previousSessionFile?: string },
	reason: string,
): Promise<void> {
	const previousSnapshot = readSessionFileSnapshot(
		readTrimmedString(event.previousSessionFile) ?? deps.state.getActiveSessionFile(),
	);
	const sessionId = previousSnapshot.sessionId ?? deps.state.getActiveSessionId();
	if (deps.state.sessionAlreadyEnded(sessionId)) return;

	await submitSessionEnd(deps.client, {
		sessionId,
		transcript: previousSnapshot.transcript,
		reason,
		project: previousSnapshot.project,
	});

	deps.state.markSessionEnded(sessionId);
	deps.state.clearPendingSessionData(sessionId);
}

export async function requestRecallForPrompt(
	deps: LifecycleDeps,
	ctx: OmpExtensionContext,
	userText: string,
): Promise<void> {
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

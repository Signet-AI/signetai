import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { emptyHookRecallResponse, withHookRecallCompat } from "@signet/core";
import type { Context } from "hono";
import type { Hono } from "hono";
import { getAgentScope, resolveAgentId } from "../agent-id";
import { aggregateRecall, parseAggregateRecallBudget, readAggregateRecallBudgetInput } from "../aggregate-recall";
import { checkScope, requirePermission, requireRateLimit } from "../auth";
import {
	type AcpDeliveryAttempt,
	type AgentMessage,
	AgentMessageCapacityError,
	AgentMessageNotFoundError,
	type AgentMessageType,
	acknowledgeAgentMessage,
	claimAcpMessageDelivery,
	completeAcpMessageDelivery,
	createAgentMessage,
	isMessageVisibleToAgent,
	listAgentMessagePage,
	listAgentMessages,
	listAgentPresence,
	relayMessageViaAcp,
	removeAgentPresence,
	subscribeCrossAgentEvents,
	touchAgentPresence,
	upsertAgentPresence,
} from "../cross-agent";
import { getDbAccessor } from "../db-accessor";
import { fetchEmbedding } from "../embedding-fetch";
import type { EmbeddingRole } from "../embedding-profile";
import {
	type CheckpointExtractRequest,
	type PreCompactionRequest,
	type RecallRequest,
	type RememberRequest,
	type SessionEndRequest,
	type SessionStartRequest,
	type SynthesisRequest,
	type UserPromptSubmitRequest,
	handleCheckpointExtract,
	handlePreCompaction,
	handleSessionEnd,
	handleSessionStart,
	handleSynthesisRequest,
	handleUserPromptSubmit,
	resetSessionStartDedupe,
	writeMemoryMd,
} from "../hooks.js";
import { getInferenceRouterOrNull } from "../inference-router";
import { logger } from "../logger";
import { type EmbeddingConfig, type ResolvedMemoryConfig, loadMemoryConfig } from "../memory-config";
import { normalizeMarkdownBody, writeCompactionArtifact } from "../memory-lineage.js";
import { type RecallParams, hybridRecall } from "../memory-search";
import {
	type HookNotificationsBlock,
	appendNotificationInject,
	collectCrossAgentNotifications,
	isNotificationCompatibleHook,
} from "../notifications/cross-agent-notifications";
import { getSynthesisWorker, readLastSynthesisTime } from "../pipeline";
import { type PipelineCauseFamily, normalizePipelineCause, recordPipelineOperation } from "../pipeline-operation";
import { effectiveRecallLimit, recordRecallAttempt, recordRecallOutcome } from "../recall-telemetry";
import { isNoiseSession } from "../session-noise";
import { advanceRecallContextEpoch } from "../session-recall-dedupe";
import {
	type RuntimePath,
	claimSession,
	getActiveSessions,
	getEndedSession,
	getSessionPath,
	hasSession,
	isSessionBypassed,
	markSessionEnded,
	normalizeSessionKey,
	releaseSession,
	renewSession,
} from "../session-tracker.js";
import { recordSkillInvocation } from "../skill-invocations";
import { recordSkillsFromTranscript } from "../skill-transcript-scan";
import { validateTemporalTimeOptions } from "../temporal-recall";
import { upsertThreadHead } from "../thread-heads";
import { getTranscriptCaptureJobStatus } from "../transcript-capture-worker";
import { autoConnectGraphiq } from "./graphiq-routes.js";
import {
	AGENTS_DIR,
	INTERNAL_SELF_HOST,
	PORT,
	authConfig,
	authCrossAgentMessageLimiter,
	authRecallLlmLimiter,
	getCurrentMemoryDbPath,
	harnessLastSeen,
} from "./state";
import {
	parseOptionalBoolean,
	parseOptionalInt,
	parseOptionalString,
	readOptionalJsonObject,
	resolveScopedAgentId,
	resolveScopedProject,
	toRecord,
	validateSessionAgentBinding,
} from "./utils";

export function stampHarness(harness: string | undefined): void {
	if (harness) {
		harnessLastSeen.set(harness, new Date().toISOString());
	}
}

async function recordHookRecallOperation(handler: () => Promise<Response>): Promise<Response> {
	const startedAt = Date.now();
	try {
		const response = await handler();
		const status = response.status;
		const skipped = response.headers.get("x-signet-operation-skipped") === "1";
		const degraded = response.headers.get("x-signet-operation-degraded") === "1";
		const cause = response.headers.get("x-signet-operation-cause") as PipelineCauseFamily | null;
		response.headers.delete("x-signet-operation-skipped");
		response.headers.delete("x-signet-operation-degraded");
		response.headers.delete("x-signet-operation-cause");
		const failed = status >= 400 ? 1 : 0;
		const partial = degraded ? 1 : 0;
		recordPipelineOperation({
			operationClass: "recall",
			outcome: failed > 0 ? "failed" : skipped ? "skipped" : partial > 0 ? "partial" : "completed",
			accepted: failed > 0 || skipped ? 0 : 1,
			skipped: skipped ? 1 : 0,
			retried: 0,
			failed,
			durationMs: Date.now() - startedAt,
			queueAgeMs: 0,
			causeFamily:
				failed > 0
					? (cause ?? normalizePipelineCause({ status }))
					: partial > 0
						? (cause ?? "provider_unavailable")
						: undefined,
		});
		return response;
	} catch (error) {
		recordPipelineOperation({
			operationClass: "recall",
			outcome: "failed",
			accepted: 0,
			skipped: 0,
			retried: 0,
			failed: 1,
			durationMs: Date.now() - startedAt,
			queueAgeMs: 0,
			causeFamily: normalizePipelineCause(error),
		});
		throw error;
	}
}

/** Read the runtime path from header or body, preferring header. */
function resolveRuntimePath(c: Context, body?: { runtimePath?: string }): RuntimePath | undefined {
	const header = c.req.header("x-signet-runtime-path");
	const val = header || body?.runtimePath;
	if (val === "plugin" || val === "legacy") return val;
	return undefined;
}

/**
 * Check that a mid-session hook call is from the path that claimed the
 * session. Returns a 409 Response if there's a conflict, or null if ok.
 */
function checkSessionClaim(
	c: Context,
	sessionKey: string | undefined,
	runtimePath: RuntimePath | undefined,
	agentId = "default",
): Response | null {
	if (!sessionKey || !runtimePath) return null;

	const owner = getSessionPath(sessionKey, agentId);
	if (owner && owner !== runtimePath) {
		return c.json({ error: `session claimed by ${owner} path` }, 409) as unknown as Response;
	}
	return null;
}

function claimAutomaticSessionOrSkip(
	sessionKey: string | undefined,
	runtimePath: RuntimePath | undefined,
	agentId: string,
	harness: string | undefined,
	hook: string,
	noop: Record<string, unknown>,
): Record<string, unknown> | null {
	if (!sessionKey || !runtimePath) return null;

	const claim = claimSession(sessionKey, runtimePath, agentId, harness);
	if (claim.ok) return null;

	logger.info("hooks", "Duplicate runtime hook skipped", {
		hook,
		sessionKey,
		runtimePath,
		claimedBy: claim.claimedBy,
	});
	return {
		...noop,
		skipped: true,
		duplicateRuntimePath: true,
		claimedBy: claim.claimedBy,
	};
}

function skipConflictingSessionEnd(
	sessionKey: string | undefined,
	runtimePath: RuntimePath | undefined,
	agentId = "default",
): Record<string, unknown> | null {
	if (!sessionKey || !runtimePath) return null;
	const ended = getEndedSession(sessionKey, agentId);
	if (ended && !ended.runtimePath) return null;
	if (ended) {
		logger.info("hooks", "Duplicate session-end skipped", {
			sessionKey,
			runtimePath,
			endedBy: ended.runtimePath,
		});
		return {
			memoriesSaved: 0,
			skipped: true,
			duplicateSessionEnd: true,
			endedBy: ended.runtimePath ?? "unknown",
		};
	}
	const owner = getSessionPath(sessionKey, agentId);
	if (!owner || owner === runtimePath) return null;

	logger.info("hooks", "Duplicate runtime session-end skipped", {
		sessionKey,
		runtimePath,
		claimedBy: owner,
	});
	return {
		memoriesSaved: 0,
		skipped: true,
		duplicateRuntimePath: true,
		claimedBy: owner,
	};
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoTimestamp(value: unknown, field = "createdAt"): { value?: string; error?: string } {
	const text = parseOptionalString(value);
	if (!text) return {};
	if (!ISO_TIMESTAMP_RE.test(text)) return { error: `${field} must be an ISO timestamp` };
	const ms = Date.parse(text);
	if (!Number.isFinite(ms)) return { error: `${field} must be a valid timestamp` };
	return { value: new Date(ms).toISOString() };
}

function parseOptionalNonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 0 ? value : undefined;
	}
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!/^\d+$/.test(text)) return undefined;
	const parsed = Number(text);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// Guard against recursive hook calls from spawned agent contexts
function isInternalCall(c: Context): boolean {
	return c.req.header("x-signet-no-hooks") === "1";
}

// Check whether the session is bypassed (hooks return no-op responses)
function checkBypass(body?: { sessionKey?: string; sessionId?: string; agentId?: string }): boolean {
	const key = body?.sessionKey ?? body?.sessionId;
	if (!key) return false;
	return isSessionBypassed(key, resolveAgentId({ agentId: body?.agentId, sessionKey: key }));
}

interface HookNotificationContext {
	readonly harness: string;
	readonly hook: string;
	readonly agentId: string;
	readonly sessionKey?: string;
}

function withCrossAgentNotifications<T extends object>(
	result: T & { readonly inject?: string },
	context: HookNotificationContext,
): T & { readonly inject: string; readonly notifications?: HookNotificationsBlock } {
	const notifications = collectCrossAgentNotifications(context);
	const inject = appendNotificationInject(result.inject, notifications);
	return notifications ? { ...result, inject, notifications } : { ...result, inject };
}

export function listLiveSessions(agentId: string): Array<{
	key: string;
	runtimePath: string;
	claimedAt: string;
	expiresAt: string | null;
	bypassed: boolean;
}> {
	const byKey = new Map<
		string,
		{ key: string; runtimePath: string; claimedAt: string; expiresAt: string | null; bypassed: boolean }
	>(
		getActiveSessions()
			.filter((s) => s.agentId === agentId)
			.map((session) => [session.key, session] as const),
	);

	for (const presence of listAgentPresence({ limit: Number.MAX_SAFE_INTEGER })) {
		if (presence.agentId !== agentId) continue;
		if (!presence.sessionKey) continue;
		const key = normalizeSessionKey(presence.sessionKey);
		if (byKey.has(key)) continue;
		byKey.set(key, {
			key,
			runtimePath: presence.runtimePath ?? "unknown",
			claimedAt: presence.startedAt,
			expiresAt: null,
			bypassed: isSessionBypassed(key, agentId),
		});
	}
	return [...byKey.values()].sort((a, b) => b.claimedAt.localeCompare(a.claimedAt));
}

// ============================================================================
// Hooks Routes
// ============================================================================

// Session start hook - provides context/memories for injection
function registerSessionStart(app: Hono): void {
	app.post("/api/hooks/session-start", async (c) => {
		if (isInternalCall(c)) {
			return c.json({ inject: "", memories: [] });
		}
		let recallAttempted = false;
		let recallOutcomeRecorded = false;
		try {
			const body = (await c.req.json()) as SessionStartRequest;

			if (!body.harness) {
				return c.json({ error: "harness is required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (body.claimOnly === true && !runtimePath) {
				return c.json({ error: "claimOnly requires a runtime path" }, 400);
			}
			if (runtimePath) body.runtimePath = runtimePath;

			const requestedAgentId = resolveAgentId({
				agentId: parseOptionalString(body.agentId),
				sessionKey: body.sessionKey,
			});
			const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
			if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
			body.agentId = scopedAgent.agentId;

			if (body.sessionKey && runtimePath) {
				const claim = claimSession(body.sessionKey, runtimePath, scopedAgent.agentId, body.harness);
				if (!claim.ok) {
					return c.json(
						{
							error: `session claimed by ${claim.claimedBy} path`,
						},
						409,
					);
				}
			}

			upsertAgentPresence({
				sessionKey: parseOptionalString(body.sessionKey),
				agentId: scopedAgent.agentId,
				harness: body.harness,
				project: parseOptionalString(body.project),
				runtimePath,
				provider: body.harness,
			});

			stampHarness(body.harness);

			try {
				autoConnectGraphiq(parseOptionalString(body.project));
			} catch {
				// auto-connect is best-effort; never block session-start
			}

			if (checkBypass(body)) {
				return c.json({ inject: "", memories: [], bypassed: true });
			}

			if (body.claimOnly === true) {
				return c.json({ sessionKnown: true });
			}

			recordRecallAttempt("prompt_injection");
			recallAttempted = true;
			const result = await handleSessionStart(body);
			const response = withCrossAgentNotifications(result, {
				harness: body.harness,
				hook: "SessionStart",
				agentId: scopedAgent.agentId,
				sessionKey: parseOptionalString(body.sessionKey),
			});
			recordRecallOutcome({
				surface: "prompt_injection",
				resultCount: result.memories.length,
				delivery: result.memories.length > 0 ? "injected" : "not_delivered",
			});
			recallOutcomeRecorded = true;
			return c.json(response);
		} catch (e) {
			if (recallAttempted && !recallOutcomeRecorded) {
				recordRecallOutcome({ surface: "prompt_injection", error: true, delivery: "not_delivered" });
			}
			logger.error("hooks", "Session start hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Bound concurrent prompt-submit work. Subagent-heavy sessions fire many
// user-prompt-submit hooks at once; without a cap the requests stack on the
// single event loop, /health starves, and the watchdog kills the daemon
// (#1059). Past the cap the hook rejects with 503 so callers retry instead
// of queueing indefinitely.
export const PROMPT_SUBMIT_MAX_IN_FLIGHT = 8;

export interface PromptSubmitAdmission {
	acquire(): boolean;
	release(): void;
	inFlight(): number;
}

export function createPromptSubmitAdmission(maxInFlight: number): PromptSubmitAdmission {
	let inFlight = 0;
	return {
		acquire(): boolean {
			if (inFlight >= maxInFlight) return false;
			inFlight += 1;
			return true;
		},
		release(): void {
			inFlight -= 1;
		},
		inFlight(): number {
			return inFlight;
		},
	};
}

let promptSubmitAdmission: PromptSubmitAdmission = createPromptSubmitAdmission(PROMPT_SUBMIT_MAX_IN_FLIGHT);

/** Test seam; mirrors native-embedding's __*ForTests pattern. */
export function __setPromptSubmitAdmissionForTests(admission: PromptSubmitAdmission | null): void {
	promptSubmitAdmission = admission ?? createPromptSubmitAdmission(PROMPT_SUBMIT_MAX_IN_FLIGHT);
}

// User prompt submit hook - inject relevant memories per prompt
function registerUserPromptSubmit(app: Hono): void {
	app.post("/api/hooks/user-prompt-submit", async (c) => {
		if (isInternalCall(c)) {
			return c.json({ inject: "", memoryCount: 0 });
		}
		try {
			const body = (await c.req.json()) as UserPromptSubmitRequest;

			const hasUserMessage = typeof body.userMessage === "string" && body.userMessage.trim().length > 0;
			const hasUserPrompt = typeof body.userPrompt === "string" && body.userPrompt.trim().length > 0;

			if (!body.harness || (!hasUserMessage && !hasUserPrompt)) {
				return c.json({ error: "harness and userMessage or userPrompt are required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			const sessionKey = parseOptionalString(body.sessionKey);
			const requestedAgentId = resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey });
			const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
			if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
			const agentId = scopedAgent.agentId;
			body.agentId = agentId;
			const known = sessionKey ? hasSession(sessionKey, agentId) : false;
			const duplicate = claimAutomaticSessionOrSkip(
				sessionKey,
				runtimePath,
				agentId,
				body.harness,
				"user-prompt-submit",
				{
					inject: "",
					memoryCount: 0,
					sessionKnown: known,
				},
			);
			if (duplicate) {
				return c.json(duplicate);
			}
			if (sessionKey) {
				const touched = touchAgentPresence(sessionKey);
				if (!touched) {
					upsertAgentPresence({
						sessionKey,
						agentId,
						harness: body.harness,
						project: parseOptionalString(body.project),
						runtimePath,
						provider: body.harness,
					});
				}
			} else {
				upsertAgentPresence({
					agentId,
					harness: body.harness,
					project: parseOptionalString(body.project),
					runtimePath,
					provider: body.harness,
				});
			}

			stampHarness(body.harness);

			if (checkBypass(body)) {
				return c.json({ inject: "", memoryCount: 0, bypassed: true });
			}

			if (!promptSubmitAdmission.acquire()) {
				return c.json(
					{
						error: `Too many concurrent prompt submissions (max ${PROMPT_SUBMIT_MAX_IN_FLIGHT}); retry shortly`,
					},
					503,
				);
			}
			let result: Awaited<ReturnType<typeof handleUserPromptSubmit>>;
			try {
				result = await handleUserPromptSubmit(body);
			} finally {
				promptSubmitAdmission.release();
			}
			return c.json(
				withCrossAgentNotifications(
					{ ...result, sessionKnown: known },
					{
						harness: body.harness,
						hook: "UserPromptSubmit",
						agentId,
						sessionKey,
					},
				),
			);
		} catch (e) {
			logger.error("hooks", "User prompt submit hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Lightweight notification hook for high-frequency harness lifecycle events.
function registerNotifications(app: Hono): void {
	app.post("/api/hooks/notifications", async (c) => {
		if (isInternalCall(c)) return c.json({ inject: "" });
		const denied = await requirePermission("recall", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;

		try {
			const payload = await readOptionalJsonObject(c);
			if (payload === null) return c.json({ error: "invalid request body" }, 400);
			const harness = parseOptionalString(payload.harness);
			const hook = parseOptionalString(payload.hook);
			if (!harness || !hook) return c.json({ error: "harness and hook are required" }, 400);
			if (!isNotificationCompatibleHook(harness, hook)) {
				return c.json({ error: `hook '${hook}' is not notification-compatible for harness '${harness}'` }, 400);
			}

			const sessionKey = parseOptionalString(payload.sessionKey);
			const requestedAgentId = resolveAgentId({ agentId: parseOptionalString(payload.agentId), sessionKey });
			const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
			if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
			const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
				requireExisting: false,
				context: "sessionKey",
			});
			if (sessionError) return c.json({ error: sessionError }, 403);
			if (sessionKey && isSessionBypassed(sessionKey, scopedAgent.agentId)) {
				return c.json({ inject: "", bypassed: true });
			}

			if (sessionKey) {
				const touched = touchAgentPresence(sessionKey, scopedAgent.agentId);
				if (!touched) {
					upsertAgentPresence({
						sessionKey,
						agentId: scopedAgent.agentId,
						harness,
						project: parseOptionalString(payload.project),
						provider: harness,
					});
				}
			}
			stampHarness(harness);

			const notifications = collectCrossAgentNotifications({
				harness,
				hook,
				agentId: scopedAgent.agentId,
				sessionKey,
			});
			return notifications ? c.json({ inject: notifications.inject, notifications }) : c.json({ inject: "" });
		} catch (error) {
			logger.error("hooks", "Notification hook failed", error instanceof Error ? error : new Error(String(error)));
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Session end hook - extract memories from transcript
function registerSessionEnd(app: Hono): void {
	app.post("/api/hooks/session-end", async (c) => {
		if (isInternalCall(c)) {
			return c.json({ memoriesSaved: 0 });
		}
		try {
			const body = (await c.req.json()) as SessionEndRequest;

			if (!body.harness) {
				return c.json({ error: "harness is required" }, 400);
			}
			const capturedAt = parseIsoTimestamp(body.capturedAt, "capturedAt");
			if (capturedAt.error) return c.json({ error: capturedAt.error }, 400);
			body.capturedAt = capturedAt.value;

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			stampHarness(body.harness);

			const sessionKey = body.sessionKey || body.sessionId;
			let agentId = resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey });
			const conflict = skipConflictingSessionEnd(sessionKey, runtimePath, agentId);
			if (conflict) return c.json(conflict);
			const transcriptPath = parseOptionalString(body.transcriptPath);
			if (transcriptPath) {
				const denied = await requirePermission("remember", authConfig)(c, () => Promise.resolve());
				if (denied) return denied;
				const scopedAgent = resolveScopedAgentId(c, agentId);
				if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
				const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
					requireExisting: false,
					context: "sessionKey",
				});
				if (sessionError) return c.json({ error: sessionError }, 403);
				agentId = scopedAgent.agentId;
				body.agentId = agentId;
			}
			const duplicate = claimAutomaticSessionOrSkip(sessionKey, runtimePath, agentId, body.harness, "session-end", {
				memoriesSaved: 0,
			});
			if (duplicate) return c.json(duplicate);

			if (sessionKey && isSessionBypassed(sessionKey, agentId)) {
				markSessionEnded(sessionKey, runtimePath, agentId);
				removeAgentPresence(sessionKey);
				return c.json({ memoriesSaved: 0, bypassed: true });
			}

			try {
				const result = await handleSessionEnd(body);
				if (sessionKey) {
					markSessionEnded(sessionKey, runtimePath, agentId);
					removeAgentPresence(sessionKey);
				}
				if (transcriptPath) {
					// recordSkillsFromTranscript is throw-proof by contract — safe in setImmediate.
					setImmediate(() =>
						recordSkillsFromTranscript({
							transcriptPath,
							harness: body.harness,
							agentId,
							origin: "scan",
							expectedSessionId: sessionKey,
						}),
					);
				}
				return c.json(result);
			} catch (e) {
				if (sessionKey) {
					releaseSession(sessionKey, agentId);
					removeAgentPresence(sessionKey);
				}
				throw e;
			}
		} catch (e) {
			logger.error("hooks", "Session end hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});

	app.get("/api/hooks/transcript-capture/:jobId", async (c) => {
		const denied = await requirePermission("remember", authConfig)(c, () => Promise.resolve());
		if (denied) return denied;
		const requestedAgentId = resolveAgentId({ agentId: parseOptionalString(c.req.query("agentId")) });
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const jobId = c.req.param("jobId").trim();
		if (!jobId) return c.json({ error: "jobId is required" }, 400);
		const job = getTranscriptCaptureJobStatus(getDbAccessor(), scopedAgent.agentId, jobId);
		if (!job) return c.json({ error: "Transcript capture job not found" }, 404);
		return c.json(job);
	});
}

// Harness-emitted skill invocations (claude-code PostToolUse, opencode
// tool.execute.after, ...). Records source='agent' rows deduped on
// (agentId, harness, sessionId, toolUseId) so a re-fired hook records once.
function registerSkillInvocation(app: Hono): void {
	app.post("/api/hooks/skill-invocation", async (c) => {
		if (isInternalCall(c)) {
			return c.json({ recorded: false });
		}
		try {
			const body = toRecord(await c.req.json()) ?? {};
			const harness = parseOptionalString(body.harness);
			const skillName = parseOptionalString(body.skillName ?? body.skill);
			if (!harness) return c.json({ error: "harness is required" }, 400);
			if (!skillName) return c.json({ error: "skillName is required" }, 400);

			stampHarness(harness);

			const createdAt = parseIsoTimestamp(body.createdAt);
			if (createdAt.error) return c.json({ error: createdAt.error }, 400);
			const sessionKey = parseOptionalString(body.sessionKey ?? body.sessionId);
			const runtimePath = resolveRuntimePath(c, { runtimePath: parseOptionalString(body.runtimePath) });
			const conflict = checkSessionClaim(
				c,
				sessionKey,
				runtimePath,
				resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey }),
			);
			if (conflict) return conflict;
			const requestedAgentId = resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey });
			const denied = await requirePermission("remember", authConfig)(c, () => Promise.resolve());
			if (denied) return denied;
			const scopedAgent = resolveScopedAgentId(c, requestedAgentId);
			if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
			const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
				requireExisting: false,
				context: "sessionKey",
			});
			if (sessionError) return c.json({ error: sessionError }, 403);

			const rawLatencyMs = body.latencyMs;
			const latencyMs =
				rawLatencyMs === undefined || rawLatencyMs === null ? 0 : parseOptionalNonNegativeInt(rawLatencyMs);
			if (latencyMs === undefined) {
				return c.json({ error: "latencyMs must be a non-negative integer" }, 400);
			}

			recordSkillInvocation({
				skillName,
				agentId: scopedAgent.agentId,
				source: "agent",
				latencyMs,
				success: parseOptionalBoolean(body.success) ?? true,
				errorText: parseOptionalString(body.errorText),
				harness,
				sessionId: sessionKey,
				toolUseId: parseOptionalString(body.toolUseId),
				cwd: parseOptionalString(body.cwd),
				origin: parseOptionalString(body.origin),
				args: parseOptionalString(body.args),
				createdAt: createdAt.value,
			});
			return c.json({ recorded: true });
		} catch (e) {
			logger.error("hooks", "Skill invocation hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Mid-session checkpoint extraction (long-lived sessions)
function registerCheckpointExtract(app: Hono): void {
	app.post("/api/hooks/session-checkpoint-extract", async (c) => {
		if (isInternalCall(c)) {
			return c.json({ skipped: true });
		}
		try {
			const body = (await c.req.json()) as CheckpointExtractRequest;

			if (!body.harness || !body.sessionKey) {
				return c.json({ error: "harness and sessionKey are required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;
			const agentId = resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey: body.sessionKey });

			const duplicate = claimAutomaticSessionOrSkip(
				body.sessionKey,
				runtimePath,
				agentId,
				body.harness,
				"session-checkpoint-extract",
				{
					skipped: true,
				},
			);
			if (duplicate) return c.json(duplicate);

			stampHarness(body.harness);

			if (isSessionBypassed(body.sessionKey, agentId)) {
				return c.json({ skipped: true });
			}

			renewSession(body.sessionKey, agentId);

			const result = handleCheckpointExtract(body);
			return c.json(result);
		} catch (e) {
			logger.error("hooks", "Checkpoint extract hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Remember hook - explicit memory save
function registerRemember(app: Hono): void {
	app.post("/api/hooks/remember", async (c) => {
		if (isInternalCall(c)) {
			return c.json({ success: true, memories: [] });
		}
		try {
			const body = (await c.req.json()) as RememberRequest;

			if (!body.harness || !body.content) {
				return c.json({ error: "harness and content are required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			const conflict = checkSessionClaim(
				c,
				body.sessionKey,
				runtimePath,
				resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey: body.sessionKey }),
			);
			if (conflict) return conflict;

			if (checkBypass(body)) {
				return c.json({ success: true, memories: [], bypassed: true });
			}

			const headers: Record<string, string> = { "Content-Type": "application/json" };
			const auth = c.req.header("authorization");
			if (auth) headers.Authorization = auth;
			const sessionKey = c.req.header("x-signet-session-key") ?? body.sessionKey;
			if (sessionKey) headers["x-signet-session-key"] = sessionKey;
			return fetch(`http://${INTERNAL_SELF_HOST}:${PORT}/api/memory/remember`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
		} catch (e) {
			logger.error("hooks", "Remember hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Recall hook - explicit memory query
function registerRecall(app: Hono): void {
	app.post("/api/hooks/recall", async (c) => {
		if (isInternalCall(c)) {
			return c.json(emptyHookRecallResponse("", { internal: true }));
		}
		let recallAttempted = false;
		const recallSurface = "tool_call" as const;
		return recordHookRecallOperation(async () => {
			try {
				const body = (await c.req.json()) as RecallRequest;

				if (!body.harness || !body.query) {
					return c.json({ error: "harness and query are required" }, 400);
				}
				const aggregateBudgetInput = readAggregateRecallBudgetInput(body);
				const aggregateBudget = parseAggregateRecallBudget(aggregateBudgetInput);
				if (aggregateBudgetInput !== undefined && aggregateBudget === null) {
					return c.json({ error: "Invalid aggregateBudget. Expected one of: small, medium, large." }, 400);
				}
				const temporalTimeError = validateTemporalTimeOptions(body.time);
				if (temporalTimeError) return c.json({ error: temporalTimeError }, 400);

				const runtimePath = resolveRuntimePath(c, body);
				if (runtimePath) body.runtimePath = runtimePath;

				const conflict = checkSessionClaim(
					c,
					body.sessionKey,
					runtimePath,
					resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey: body.sessionKey }),
				);
				if (conflict) return conflict;

				if (checkBypass(body)) {
					c.header("x-signet-operation-skipped", "1");
					return c.json(emptyHookRecallResponse(body.query, { bypassed: true }));
				}

				const aggregateSaveRequested =
					body.aggregate === true && body.saveAggregate !== false && body.save_aggregate !== false;
				if (aggregateSaveRequested) {
					const denied = await requirePermission("remember", authConfig)(c, () => Promise.resolve());
					if (denied) return denied;
				}

				const agentId = resolveAgentId({
					agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
					sessionKey: body.sessionKey,
				});

				// When aggregate save is requested, enforce scope for non-admin tokens.
				if (aggregateSaveRequested) {
					const aggAuth = c.get("auth");
					if (aggAuth?.claims && aggAuth.claims.role !== "admin") {
						const tokenProject = aggAuth.claims.scope?.project;
						if (tokenProject && (!body.project || body.project !== tokenProject)) {
							return c.json({ error: `scope restricted to project '${tokenProject}'` }, 403);
						}
						const scopeDecision = checkScope(
							aggAuth.claims,
							{ agent: agentId, project: body.project ?? undefined },
							authConfig.mode,
						);
						if (!scopeDecision.allowed) {
							return c.json({ error: scopeDecision.reason ?? "scope violation" }, 403);
						}
					}
				}

				const agentScope = getAgentScope(agentId);
				const cfg = loadMemoryConfig(AGENTS_DIR);
				const recallSurface = "tool_call" as const;
				if (body.aggregate === true && authConfig.mode !== "local") {
					const actor = c.get("auth")?.claims?.sub ?? "anonymous";
					const check = authRecallLlmLimiter.check(actor);
					if (!check.allowed) {
						c.header("Retry-After", String(Math.ceil((check.resetAt - Date.now()) / 1000)));
						return c.json({ error: "rate limit exceeded", retryAfter: check.resetAt }, 429);
					}
					authRecallLlmLimiter.record(actor);
				}
				const requestedProject = parseOptionalString(body.project);
				const scopedP = resolveScopedProject(c, requestedProject);
				if (scopedP.error) return c.json({ error: scopedP.error }, 403);
				recordRecallAttempt(recallSurface);
				recallAttempted = true;
				const project = scopedP.project ?? requestedProject;
				const params: RecallParams = {
					query: body.query,
					keywordQuery: body.keywordQuery,
					limit: body.limit,
					project,
					aggregate: body.aggregate,
					aggregateBudget: aggregateBudget ?? undefined,
					aggregate_budget: aggregateBudget ?? undefined,
					saveAggregate: body.saveAggregate ?? body.save_aggregate,
					save_aggregate: body.save_aggregate ?? body.saveAggregate,
					type: body.type,
					tags: body.tags,
					who: body.who,
					since: body.since,
					until: body.until,
					time: body.time as RecallParams["time"],
					expand: body.expand,
					agentId,
					readPolicy: agentScope.readPolicy,
					policyGroup: agentScope.policyGroup,
					sessionKey: body.sessionKey,
					includeRecalled: body.includeRecalled === true,
					recallSurface: "api.hooks.recall",
					recallMode: "hook",
					telemetrySurface: recallSurface,
				};
				let embeddingDegraded = false;
				let embeddingCause: PipelineCauseFamily | undefined;
				const embedFn = async (text: string, embeddingConfig: EmbeddingConfig, role?: EmbeddingRole) => {
					const embedding = await recallAttributedEmbedFn(fetchEmbedding, agentId, (causeFamily) => {
						embeddingDegraded = true;
						embeddingCause ??= causeFamily;
					})(text, embeddingConfig, role);
					if (embedding === null && embeddingConfig.provider !== "none") embeddingDegraded = true;
					return embedding;
				};
				const result =
					body.aggregate === true
						? await aggregateRecall(params, cfg, {
								router: getInferenceRouterOrNull(),
								embedFn,
							})
						: await hybridRecall(params, cfg, embedFn);
				if (result.aggregate?.partial === true || embeddingDegraded) {
					c.header("x-signet-operation-degraded", "1");
					if (!embeddingCause && result.aggregate?.stoppedReason === "router_unavailable") {
						embeddingCause = "provider_unavailable";
					}
					if (!embeddingCause && result.aggregate?.stoppedReason === "synthesis_failed") {
						embeddingCause = "internal_error";
					}
					if (embeddingCause) c.header("x-signet-operation-cause", embeddingCause);
				}
				recordRecallOutcome({
					surface: recallSurface,
					resultCount: result.results.length,
					truncated: result.results.length >= effectiveRecallLimit(params.limit),
					delivery: "returned",
				});
				return c.json(withHookRecallCompat(result));
			} catch (e) {
				if (recallAttempted) recordRecallOutcome({ surface: recallSurface, error: true, delivery: "not_delivered" });
				logger.error("hooks", "Recall hook failed", e as Error);
				c.header("x-signet-operation-cause", normalizePipelineCause(e));
				return c.json({ error: "Hook execution failed" }, 500);
			}
		});
	});
}

// Pre-compaction hook - provides summary instructions
function registerPreCompaction(app: Hono): void {
	app.post("/api/hooks/pre-compaction", async (c) => {
		try {
			const rawBody = toRecord(await c.req.json()) ?? {};
			const transcriptPath =
				parseOptionalString(rawBody.transcriptPath) ?? parseOptionalString(rawBody.transcript_path);
			const body = rawBody as unknown as PreCompactionRequest;

			if (!body.harness) {
				return c.json({ error: "harness is required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			let agentId = resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey: body.sessionKey });
			if (transcriptPath) {
				const denied = await requirePermission("remember", authConfig)(c, () => Promise.resolve());
				if (denied) return denied;
				const scopedAgent = resolveScopedAgentId(c, agentId);
				if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
				const sessionError = validateSessionAgentBinding(c, body.sessionKey, scopedAgent.agentId, {
					requireExisting: false,
					context: "sessionKey",
				});
				if (sessionError) return c.json({ error: sessionError }, 403);
				agentId = scopedAgent.agentId;
				body.agentId = agentId;
			}
			const duplicate = claimAutomaticSessionOrSkip(
				body.sessionKey,
				runtimePath,
				agentId,
				body.harness,
				"pre-compaction",
				{
					guidelines: "",
					instructions: "",
					summaryPrompt: "",
				},
			);
			if (duplicate) return c.json(duplicate);

			if (checkBypass(body)) {
				return c.json({ instructions: "", bypassed: true });
			}

			const result = handlePreCompaction(body);
			if (transcriptPath) {
				setImmediate(() =>
					recordSkillsFromTranscript({
						transcriptPath,
						harness: body.harness,
						agentId,
						origin: "scan",
						expectedSessionId: body.sessionKey,
					}),
				);
			}
			return c.json(result);
		} catch (e) {
			logger.error("hooks", "Pre-compaction hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Save compaction summary (convenience endpoint)
function registerCompactionComplete(app: Hono): void {
	app.post("/api/hooks/compaction-complete", async (c) => {
		try {
			const body = (await c.req.json()) as {
				harness: string;
				summary: string;
				sessionKey?: string;
				project?: string;
				agentId?: string;
				runtimePath?: string;
			};

			if (!body.harness || !body.summary) {
				return c.json({ error: "harness and summary are required" }, 400);
			}
			const summary = normalizeMarkdownBody(body.summary);

			const runtimePath = resolveRuntimePath(c, body);
			const duplicate = claimAutomaticSessionOrSkip(
				body.sessionKey,
				runtimePath,
				resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey: body.sessionKey }),
				body.harness,
				"compaction-complete",
				{
					success: true,
				},
			);
			if (duplicate) return c.json(duplicate);

			if (checkBypass(body)) {
				return c.json({ success: true, bypassed: true });
			}

			if (!existsSync(getCurrentMemoryDbPath())) {
				return c.json({ error: "Memory database not found" }, 500);
			}

			const now = new Date().toISOString();
			const scopedAgent = resolveScopedAgentId(
				c,
				resolveAgentId({ agentId: parseOptionalString(body.agentId), sessionKey: body.sessionKey }),
			);
			if (scopedAgent.error) {
				return c.json({ error: scopedAgent.error }, 403);
			}
			const agentId = scopedAgent.agentId;
			const transcriptRow = body.sessionKey
				? getDbAccessor().withReadDb(
						(db) =>
							db
								.prepare(
									`SELECT project
									 FROM session_transcripts
									 WHERE session_key = ? AND agent_id = ?`,
								)
								.get(body.sessionKey, agentId) as { project: string | null } | undefined,
					)
				: undefined;
			const requestedProject = transcriptRow?.project ?? parseOptionalString(body.project);
			const scopedProject = resolveScopedProject(c, requestedProject);
			if (scopedProject.error) {
				return c.json({ error: scopedProject.error }, 403);
			}
			const project = scopedProject.project ?? null;

			const sessionId = body.sessionKey ?? `compaction:${now}`;
			const noise = isNoiseSession({
				project,
				sessionKey: body.sessionKey ?? null,
				sessionId,
				harness: body.harness,
			});
			const summaryId = noise ? null : crypto.randomUUID();
			if (!noise) {
				getDbAccessor().withWriteTx((db) => {
					db.prepare(
						`INSERT INTO memories (
							id, content, type, importance, source_id, source_type,
							who, tags, project, agent_id, created_at, updated_at, updated_by,
							memory_kind
						)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						summaryId,
						summary,
						"session_summary",
						0.8,
						body.sessionKey ?? null,
						body.harness,
						"system",
						`session,summary,${body.harness}`,
						project,
						agentId,
						now,
						now,
						"system",
						// This is the keyword/vector-recall projection. The temporal-DAG
						// compaction node below is the canonical episodic Dreaming input.
						null,
					);

					const table = db
						.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`)
						.get();
					if (!table) {
						return;
					}
					const nodeId = body.sessionKey ? `${body.sessionKey}:compaction:${Date.parse(now)}` : crypto.randomUUID();
					db.prepare(
						`INSERT OR REPLACE INTO session_summaries (
							id, project, depth, kind, content, token_count,
							earliest_at, latest_at, session_key, harness,
							agent_id, source_type, source_ref, meta_json, created_at
						) VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?, 'compaction', ?, ?, ?)`,
					).run(
						nodeId,
						project,
						summary,
						Math.ceil(summary.length / 4),
						now,
						now,
						body.sessionKey ?? null,
						body.harness,
						agentId,
						body.sessionKey ?? null,
						JSON.stringify({ source: "compaction-complete" }),
						now,
					);
					upsertThreadHead(db as unknown as Database, {
						agentId,
						nodeId,
						content: summary,
						latestAt: now,
						project,
						sessionKey: body.sessionKey ?? null,
						sourceType: "compaction",
						sourceRef: body.sessionKey ?? null,
						harness: body.harness,
					});
				});

				try {
					await writeCompactionArtifact({
						agentId,
						sessionId,
						sessionKey: body.sessionKey ?? null,
						project,
						harness: body.harness,
						capturedAt: now,
						startedAt: null,
						endedAt: null,
						summary,
					});
				} catch (err) {
					logger.warn("hooks", "Compaction artifact write failed (non-fatal)", {
						error: err instanceof Error ? err.message : String(err),
						sessionKey: body.sessionKey,
					});
				}
			}

			logger.info("hooks", noise ? "Compaction summary skipped (noise session)" : "Compaction summary saved", {
				harness: body.harness,
				memoryId: summaryId ?? "skipped-temp-session",
			});

			const epoch = advanceRecallContextEpoch({
				sessionKey: body.sessionKey,
				agentId,
				reason: "compaction-complete",
				sourceRef: summaryId ?? body.sessionKey ?? undefined,
			});
			resetSessionStartDedupe({
				harness: body.harness,
				agentId,
				project: project ?? undefined,
				sessionKey: body.sessionKey,
			});

			if (body.sessionKey) {
				try {
					getDbAccessor().withWriteTx((db) => {
						const hasTx = db
							.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_transcripts'")
							.get();
						if (hasTx) {
							db.prepare("DELETE FROM session_transcripts WHERE session_key = ? AND agent_id = ?").run(
								body.sessionKey,
								agentId,
							);
						}
						const hasCur = db
							.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_extract_cursors'")
							.get();
						if (hasCur) {
							db.prepare("DELETE FROM session_extract_cursors WHERE session_key = ? AND agent_id = ?").run(
								body.sessionKey,
								agentId,
							);
						}
					});
				} catch (err) {
					logger.warn("hooks", "Failed to reset checkpoint state after compaction (non-fatal)", {
						error: err instanceof Error ? err.message : String(err),
						sessionKey: body.sessionKey,
					});
				}
			}

			void getSynthesisWorker()
				?.triggerNow({
					force: true,
					source: "compaction-complete",
					agentId,
				})
				.then((result) => {
					if (!result.skipped) return;
					logger.info("synthesis", "Skipped MEMORY.md synthesis after compaction", {
						reason: result.reason,
						sessionKey: body.sessionKey,
					});
				})
				.catch((error) => {
					logger.warn("synthesis", "Failed to trigger MEMORY.md synthesis after compaction", {
						error: error instanceof Error ? error.message : String(error),
					});
				});

			return c.json({
				success: true,
				memoryId: summaryId,
				contextEpoch: epoch.contextEpoch,
			});
		} catch (e) {
			logger.error("hooks", "Compaction complete failed", e as Error);
			return c.json({ error: "Failed to save summary" }, 500);
		}
	});
}

// ============================================================================
// Cross-Agent Collaboration API
// ============================================================================

const AGENT_MESSAGE_TYPES: readonly AgentMessageType[] = ["assist_request", "decision_update", "info", "question"];
const MAX_CROSS_AGENT_MESSAGE_CHARS = 65_536;

function parseAgentMessageType(value: string | undefined): AgentMessageType | undefined {
	if (!value) return undefined;
	for (const type of AGENT_MESSAGE_TYPES) {
		if (type === value) return type;
	}
	return undefined;
}

function registerCrossAgentPresence(app: Hono): void {
	app.get("/api/cross-agent/presence", (c) => {
		const includeSelf = parseOptionalBoolean(c.req.query("include_self")) ?? false;
		const limit = parseOptionalInt(c.req.query("limit")) ?? 50;
		const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
		const sessionKey = parseOptionalString(c.req.query("session_key"));
		const project = parseOptionalString(c.req.query("project"));
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
			requireExisting: true,
			context: "session_key",
		});
		if (sessionError) {
			return c.json({ error: sessionError }, 403);
		}

		const sessions = listAgentPresence({
			agentId: scopedAgent.agentId,
			sessionKey,
			project,
			includeSelf,
			limit,
		});

		return c.json({
			sessions,
			count: sessions.length,
		});
	});

	app.post("/api/cross-agent/presence", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) {
			return c.json({ error: "invalid request body" }, 400);
		}

		const harness = parseOptionalString(payload.harness);
		if (!harness) {
			return c.json({ error: "harness is required" }, 400);
		}

		const runtimePathRaw = parseOptionalString(payload.runtimePath);
		const runtimePath = runtimePathRaw === "plugin" || runtimePathRaw === "legacy" ? runtimePathRaw : undefined;
		const sessionKey = parseOptionalString(payload.sessionKey);
		const requestedAgentId = resolveAgentId({ agentId: parseOptionalString(payload.agentId), sessionKey });
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
			requireExisting: false,
			context: "sessionKey",
		});
		if (sessionError) {
			return c.json({ error: sessionError }, 403);
		}

		const presence = upsertAgentPresence({
			sessionKey,
			agentId: scopedAgent.agentId,
			harness,
			project: parseOptionalString(payload.project),
			runtimePath,
			provider: parseOptionalString(payload.provider) ?? harness,
		});

		return c.json({ presence });
	});

	app.delete("/api/cross-agent/presence/:sessionKey", (c) => {
		const sessionKey = c.req.param("sessionKey");
		const scopedAgent = resolveScopedAgentId(c, undefined, "default");
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
			requireExisting: false,
			context: "sessionKey",
		});
		if (sessionError) {
			return c.json({ error: sessionError }, 403);
		}
		const removed = removeAgentPresence(sessionKey);
		return c.json({ removed });
	});
}

async function relayClaimedAcpMessage(attempt: AcpDeliveryAttempt): Promise<AgentMessage> {
	const relay = await relayMessageViaAcp({
		...attempt.request,
		idempotencyKey: attempt.idempotencyKey,
	});
	const receipt: Record<string, unknown> = { status: relay.status, idempotencyKey: attempt.idempotencyKey };
	if (relay.runId) receipt.runId = relay.runId;
	return completeAcpMessageDelivery(attempt.message.id, attempt.leaseToken, {
		status: relay.ok ? "delivered" : relay.indeterminate ? "indeterminate" : "failed",
		error: relay.error,
		receipt,
	});
}

function registerCrossAgentMessages(app: Hono): void {
	app.get("/api/cross-agent/messages", (c) => {
		const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
		const sessionKey = parseOptionalString(c.req.query("session_key"));
		const since = parseOptionalString(c.req.query("since"));
		const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
		const includeBroadcast = parseOptionalBoolean(c.req.query("include_broadcast")) ?? true;
		const unreadOnly = parseOptionalBoolean(c.req.query("unread_only")) ?? false;
		const limit = parseOptionalInt(c.req.query("limit")) ?? 100;
		const offset = parseOptionalNonNegativeInt(c.req.query("offset")) ?? 0;
		const order = c.req.query("order") === "asc" ? "asc" : "desc";
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
			requireExisting: true,
			context: "session_key",
		});
		if (sessionError) {
			return c.json({ error: sessionError }, 403);
		}

		const page = listAgentMessagePage({
			agentId: scopedAgent.agentId,
			sessionKey,
			since,
			includeSent,
			includeBroadcast,
			unreadOnly,
			limit,
			offset,
			order,
		});

		return c.json(page);
	});

	app.post("/api/cross-agent/messages/:messageId/ack", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const messageId = parseOptionalString(c.req.param("messageId"));
		if (!messageId) return c.json({ error: "messageId is required" }, 400);

		const sessionKey =
			parseOptionalString(payload.sessionKey) ?? parseOptionalString(c.req.header("x-signet-session-key"));
		const requestedAgentId = resolveAgentId({
			agentId: parseOptionalString(payload.agentId) ?? parseOptionalString(c.req.header("x-signet-agent-id")),
			sessionKey,
		});
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
			requireExisting: false,
			context: "sessionKey",
		});
		if (sessionError) return c.json({ error: sessionError }, 403);

		try {
			return c.json(
				acknowledgeAgentMessage({
					messageId,
					agentId: scopedAgent.agentId,
					sessionKey,
				}),
			);
		} catch (error) {
			if (error instanceof AgentMessageNotFoundError) return c.json({ error: error.message }, 404);
			logger.error(
				"hooks",
				"Cross-agent acknowledgement failed",
				error instanceof Error ? error : new Error(String(error)),
			);
			return c.json({ error: "Failed to acknowledge cross-agent message" }, 500);
		}
	});

	app.post("/api/cross-agent/messages/:messageId/retry", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const messageId = parseOptionalString(c.req.param("messageId"));
		if (!messageId) return c.json({ error: "messageId is required" }, 400);
		const requestedAgentId =
			parseOptionalString(payload.agentId) ?? parseOptionalString(c.req.header("x-signet-agent-id"));
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);

		try {
			const attempt = claimAcpMessageDelivery({
				messageId,
				agentId: scopedAgent.agentId,
				retryIndeterminate: true,
			});
			const message = await relayClaimedAcpMessage(attempt);
			return c.json({ message });
		} catch (error) {
			if (error instanceof AgentMessageNotFoundError) return c.json({ error: error.message }, 404);
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("already active") ||
				message.includes("retry limit") ||
				message.includes("not indeterminate")
			) {
				return c.json({ error: message }, 409);
			}
			logger.error("hooks", "ACP retry failed", error instanceof Error ? error : new Error(message));
			return c.json({ error: "ACP retry could not be completed" }, 500);
		}
	});

	app.post("/api/cross-agent/messages", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) {
			return c.json({ error: "invalid request body" }, 400);
		}

		const content = parseOptionalString(payload.content);
		if (!content) {
			return c.json({ error: "content is required" }, 400);
		}
		if (content.length > MAX_CROSS_AGENT_MESSAGE_CHARS) {
			return c.json({ error: `content too large (max ${MAX_CROSS_AGENT_MESSAGE_CHARS} chars)` }, 400);
		}

		const deliveryPathRaw = parseOptionalString(payload.via);
		const deliveryPath = deliveryPathRaw === "acp" ? "acp" : "local";

		const rawType = parseOptionalString(payload.type);
		const parsedType = parseAgentMessageType(rawType);
		if (rawType && !parsedType) {
			return c.json({ error: `unsupported message type '${rawType}'` }, 400);
		}
		const type = parsedType ?? "info";
		const broadcast = parseOptionalBoolean(payload.broadcast) ?? false;
		const fromAgentId = parseOptionalString(payload.fromAgentId);
		const scopedSender = resolveScopedAgentId(c, fromAgentId, "default");
		if (scopedSender.error) {
			return c.json({ error: scopedSender.error }, 403);
		}
		const fromSessionKey = parseOptionalString(payload.fromSessionKey);
		const fromSessionError = validateSessionAgentBinding(c, fromSessionKey, scopedSender.agentId, {
			requireExisting: true,
			context: "fromSessionKey",
		});
		if (fromSessionError) {
			return c.json({ error: fromSessionError }, 403);
		}
		const toAgentId = parseOptionalString(payload.toAgentId);
		const toSessionKey = parseOptionalString(payload.toSessionKey);
		const hasLocalTarget = broadcast || !!toAgentId || !!toSessionKey;
		if (deliveryPath === "local" && !hasLocalTarget) {
			return c.json({ error: "local target required (toAgentId, toSessionKey, or broadcast=true)" }, 400);
		}

		let acpRequest:
			| {
					readonly baseUrl: string;
					readonly targetAgentName: string;
					readonly timeoutMs?: number;
					readonly metadata?: Record<string, unknown>;
			  }
			| undefined;
		if (deliveryPath === "acp") {
			const acpPayload = toRecord(payload.acp);
			const baseUrl = parseOptionalString(acpPayload?.baseUrl) ?? parseOptionalString(acpPayload?.url);
			const targetAgentName =
				parseOptionalString(acpPayload?.targetAgentName) ?? parseOptionalString(acpPayload?.agentName);
			if (!baseUrl || !targetAgentName) {
				return c.json({ error: "acp.baseUrl and acp.targetAgentName are required when via='acp'" }, 400);
			}
			acpRequest = {
				baseUrl,
				targetAgentName,
				timeoutMs: parseOptionalInt(acpPayload?.timeoutMs),
				metadata: toRecord(acpPayload?.metadata) ?? undefined,
			};
		}

		let message: AgentMessage;
		try {
			message = createAgentMessage({
				fromAgentId: scopedSender.agentId,
				fromSessionKey,
				toAgentId,
				toSessionKey,
				content,
				type,
				broadcast,
				deliveryPath,
				deliveryStatus: acpRequest ? "queued" : "delivered",
				acpBaseUrl: acpRequest?.baseUrl,
				acpTargetAgentName: acpRequest?.targetAgentName,
				acpTimeoutMs: acpRequest?.timeoutMs,
				acpMetadata: acpRequest?.metadata,
			});
		} catch (error) {
			if (error instanceof AgentMessageCapacityError) {
				return c.json({ error: error.message }, 429);
			}
			const msg = error instanceof Error ? error.message : String(error);
			return c.json({ error: msg }, 400);
		}

		if (acpRequest) {
			try {
				const attempt = claimAcpMessageDelivery({ messageId: message.id, agentId: scopedSender.agentId });
				message = await relayClaimedAcpMessage(attempt);
			} catch (error) {
				logger.error(
					"hooks",
					"Failed to persist ACP delivery result",
					error instanceof Error ? error : new Error(String(error)),
				);
				return c.json({ error: "ACP delivery result could not be persisted", message }, 500);
			}
		}
		return c.json({ message });
	});
}

function registerCrossAgentStream(app: Hono): void {
	app.get("/api/cross-agent/stream", (c) => {
		const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
		const sessionKey = parseOptionalString(c.req.query("session_key"));
		const project = parseOptionalString(c.req.query("project"));
		const includeSelf = parseOptionalBoolean(c.req.query("include_self")) ?? false;
		const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
		const encoder = new TextEncoder();
		const scopedAgent = resolveScopedAgentId(c, requestedAgentId, "default");
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const sessionError = validateSessionAgentBinding(c, sessionKey, scopedAgent.agentId, {
			requireExisting: true,
			context: "session_key",
		});
		if (sessionError) {
			return c.json({ error: sessionError }, 403);
		}
		const agentId = scopedAgent.agentId;

		const stream = new ReadableStream({
			start(controller) {
				let dead = false;
				const cleanup = () => {
					if (dead) return;
					dead = true;
					clearInterval(keepAlive);
					unsubscribe();
					try {
						controller.close();
					} catch {}
				};

				const writeEvent = (event: unknown) => {
					if (dead) return;
					try {
						const data = `data: ${JSON.stringify(event)}\n\n`;
						controller.enqueue(encoder.encode(data));
					} catch {
						cleanup();
					}
				};

				writeEvent({
					type: "connected",
					agentId,
					sessionKey,
					project,
					timestamp: new Date().toISOString(),
				});

				writeEvent({
					type: "snapshot",
					presence: listAgentPresence({
						agentId,
						sessionKey,
						project,
						includeSelf,
						limit: 50,
					}),
					messages: listAgentMessages({
						agentId,
						sessionKey,
						includeSent,
						includeBroadcast: true,
						limit: 20,
					}),
					timestamp: new Date().toISOString(),
				});

				const unsubscribe = subscribeCrossAgentEvents((event) => {
					if (event.type === "message") {
						if (
							!isMessageVisibleToAgent(event.message, {
								agentId,
								sessionKey,
								includeBroadcast: true,
							})
						) {
							if (!(includeSent && event.message.fromAgentId === agentId)) {
								return;
							}
						}
					}

					if (event.type === "presence" && !includeSelf && event.presence.agentId === agentId) {
						if (!sessionKey) {
							return;
						}
						if (!event.presence.sessionKey || event.presence.sessionKey === sessionKey) {
							return;
						}
					}
					if (event.type === "presence" && project && event.presence.project !== project) {
						return;
					}

					writeEvent(event);
				});

				const keepAlive = setInterval(() => {
					if (dead) return;
					try {
						controller.enqueue(encoder.encode(": keepalive\n\n"));
					} catch {
						cleanup();
					}
				}, 15_000);

				c.req.raw.signal.addEventListener("abort", cleanup);
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});
}

// ============================================================================
// Synthesis Routes
// ============================================================================

function registerSynthesis(app: Hono): void {
	// Get synthesis config
	app.get("/api/hooks/synthesis/config", (c) => {
		const config = loadMemoryConfig(AGENTS_DIR).pipelineV2.synthesis;
		return c.json(config);
	});

	// Request MEMORY.md synthesis
	app.post("/api/hooks/synthesis", async (c) => {
		try {
			const body = (await c.req.json()) as SynthesisRequest & { agentId?: string; sessionKey?: string };
			const scopedAgent = resolveScopedAgentId(
				c,
				resolveAgentId({
					agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
					sessionKey: body.sessionKey ?? c.req.header("x-signet-session-key"),
				}),
			);
			if (scopedAgent.error) {
				return c.json({ error: scopedAgent.error }, 403);
			}
			const result = await handleSynthesisRequest(body, { agentId: scopedAgent.agentId, writeToDisk: false });
			return c.json(result);
		} catch (e) {
			logger.error("hooks", "Synthesis request failed", e as Error);
			return c.json({ error: "Synthesis request failed" }, 500);
		}
	});

	// Save synthesized MEMORY.md
	app.post("/api/hooks/synthesis/complete", async (c) => {
		try {
			const body = (await c.req.json()) as { content: string; agentId?: string; sessionKey?: string };

			if (!body.content) {
				return c.json({ error: "content is required" }, 400);
			}

			const worker = getSynthesisWorker();
			if (!worker) {
				return c.json({ error: "Synthesis worker not running" }, 503);
			}

			let lockToken: number | null = null;
			if (!worker.running) {
				return c.json({ error: "Synthesis worker is shutting down" }, 503);
			}

			lockToken = worker.acquireWriteLock();
			if (lockToken === null) {
				return worker.running
					? c.json({ error: "Synthesis already in progress" }, 409)
					: c.json({ error: "Synthesis worker is shutting down" }, 503);
			}

			try {
				const scopedAgent = resolveScopedAgentId(
					c,
					resolveAgentId({
						agentId: body.agentId ?? c.req.header("x-signet-agent-id"),
						sessionKey: body.sessionKey ?? c.req.header("x-signet-session-key"),
					}),
				);
				if (scopedAgent.error) {
					return c.json({ error: scopedAgent.error }, 403);
				}
				const result = writeMemoryMd(body.content, {
					agentId: scopedAgent.agentId,
					owner: "api-hooks-synthesis-complete",
				});
				if (!result.ok) {
					const status = result.code === "busy" ? 409 : 400;
					return c.json({ error: result.error }, status);
				}
				logger.info("hooks", "MEMORY.md synthesized");
			} finally {
				if (worker) {
					worker.releaseWriteLock(lockToken);
				}
			}

			return c.json({ success: true });
		} catch (e) {
			logger.error("hooks", "Synthesis complete failed", e instanceof Error ? e : new Error(String(e)));
			return c.json({ error: "Failed to save MEMORY.md" }, 500);
		}
	});

	// Trigger immediate MEMORY.md synthesis
	app.post("/api/synthesis/trigger", async (c) => {
		try {
			const worker = getSynthesisWorker();
			if (!worker) {
				return c.json({ error: "Synthesis worker not running" }, 503);
			}
			const result = await worker.triggerNow();
			return c.json(result);
		} catch (e) {
			logger.error("synthesis", "Synthesis trigger failed", e as Error);
			return c.json({ error: "Synthesis trigger failed" }, 500);
		}
	});

	// Synthesis worker status
	app.get("/api/synthesis/status", (c) => {
		const worker = getSynthesisWorker();
		const config = loadMemoryConfig(AGENTS_DIR).pipelineV2.synthesis;
		const lastRunAt = readLastSynthesisTime();
		return c.json({
			running: worker?.running ?? false,
			lastRunAt: lastRunAt > 0 ? new Date(lastRunAt).toISOString() : null,
			config,
		});
	});
}

/**
 * Wrap an embed function so embeddings produced during a recall hook are
 * attributed to the recall source. Query-role embeddings (the search query
 * vector) are "recall"; the document-role embed aggregateRecall performs on
 * the synthesized aggregate memory content is a memory write, so it records
 * as "memory-capture". Both carry the resolved agent id.
 */
function recallAttributedEmbedFn(
	embedFn: typeof fetchEmbedding,
	agentId: string,
	onFailure?: (causeFamily: PipelineCauseFamily) => void,
): (text: string, cfg: EmbeddingConfig, role?: EmbeddingRole) => Promise<number[] | null> {
	return (text, cfg, role) =>
		embedFn(text, cfg, role, {
			usage: { source: role === "query" ? "recall" : "memory-capture", agentId },
			onFailure,
		});
}

export function registerHooksRoutes(app: Hono): void {
	app.use("/api/cross-agent", async (c, next) => {
		if (c.req.method === "GET") {
			return requirePermission("recall", authConfig)(c, next);
		}
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/cross-agent/*", async (c, next) => {
		if (c.req.method === "GET") {
			return requirePermission("recall", authConfig)(c, next);
		}
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/cross-agent/messages", async (c, next) => {
		if (c.req.method !== "POST") {
			await next();
			return;
		}
		return requireRateLimit("cross-agent-message", authCrossAgentMessageLimiter, authConfig)(c, next);
	});

	registerSessionStart(app);
	registerUserPromptSubmit(app);
	registerNotifications(app);
	registerSessionEnd(app);
	registerSkillInvocation(app);
	registerCheckpointExtract(app);
	registerRemember(app);
	registerRecall(app);
	registerPreCompaction(app);
	registerCompactionComplete(app);
	registerCrossAgentPresence(app);
	registerCrossAgentMessages(app);
	registerCrossAgentStream(app);
	registerSynthesis(app);
}

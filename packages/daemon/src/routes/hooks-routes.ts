import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { emptyHookRecallResponse, withHookRecallCompat } from "@signet/core";
import type { Context } from "hono";
import type { Hono } from "hono";
import { getAgentScope, resolveAgentId } from "../agent-id";
import { requirePermission, requireRateLimit } from "../auth";
import {
	type AgentMessage,
	type AgentMessageType,
	createAgentMessage,
	isMessageVisibleToAgent,
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
	resetPromptDedup,
	writeMemoryMd,
} from "../hooks.js";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { writeCompactionArtifact } from "../memory-lineage.js";
import { hybridRecall } from "../memory-search";
import { getSynthesisWorker, readLastSynthesisTime } from "../pipeline";
import { isNoiseSession } from "../session-noise";
import {
	type RuntimePath,
	claimSession,
	getActiveSessions,
	getSessionPath,
	hasSession,
	isSessionBypassed,
	normalizeSessionKey,
	releaseSession,
	renewSession,
} from "../session-tracker.js";
import { upsertThreadHead } from "../thread-heads";
import {
	AGENTS_DIR,
	INTERNAL_SELF_HOST,
	MEMORY_DB,
	PORT,
	authConfig,
	authCrossAgentMessageLimiter,
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
): Response | null {
	if (!sessionKey || !runtimePath) return null;

	const owner = getSessionPath(sessionKey);
	if (owner && owner !== runtimePath) {
		return c.json({ error: `session claimed by ${owner} path` }, 409) as unknown as Response;
	}
	return null;
}

// Guard against recursive hook calls from spawned agent contexts
function isInternalCall(c: Context): boolean {
	return c.req.header("x-signet-no-hooks") === "1";
}

// Check whether the session is bypassed (hooks return no-op responses)
function checkBypass(body?: { sessionKey?: string; sessionId?: string }): boolean {
	const key = body?.sessionKey ?? body?.sessionId;
	if (!key) return false;
	return isSessionBypassed(key);
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
			bypassed: isSessionBypassed(key),
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
		try {
			const body = (await c.req.json()) as SessionStartRequest;

			if (!body.harness) {
				return c.json({ error: "harness is required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			if (body.sessionKey && runtimePath) {
				const claim = claimSession(
					body.sessionKey,
					runtimePath,
					resolveAgentId({ agentId: body.agentId, sessionKey: body.sessionKey }),
				);
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
				agentId: parseOptionalString(body.agentId) ?? "default",
				harness: body.harness,
				project: parseOptionalString(body.project),
				runtimePath,
				provider: body.harness,
			});

			stampHarness(body.harness);

			if (checkBypass(body)) {
				return c.json({ inject: "", memories: [], bypassed: true });
			}

			const result = await handleSessionStart(body);
			return c.json(result);
		} catch (e) {
			logger.error("hooks", "Session start hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
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
			const known = sessionKey ? hasSession(sessionKey) : false;

			const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
			if (conflict) return conflict;
			const agentId = parseOptionalString(body.agentId) ?? "default";
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

			const result = await handleUserPromptSubmit(body);
			return c.json({ ...result, sessionKnown: known });
		} catch (e) {
			logger.error("hooks", "User prompt submit hook failed", e as Error);
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

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			stampHarness(body.harness);

			const sessionKey = body.sessionKey || body.sessionId;

			if (sessionKey && isSessionBypassed(sessionKey)) {
				releaseSession(sessionKey);
				removeAgentPresence(sessionKey);
				return c.json({ memoriesSaved: 0, bypassed: true });
			}

			try {
				const result = handleSessionEnd(body);
				return c.json(result);
			} finally {
				if (sessionKey) {
					releaseSession(sessionKey);
					removeAgentPresence(sessionKey);
				}
			}
		} catch (e) {
			logger.error("hooks", "Session end hook failed", e as Error);
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

			const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
			if (conflict) return conflict;

			stampHarness(body.harness);

			if (isSessionBypassed(body.sessionKey)) {
				return c.json({ skipped: true });
			}

			renewSession(body.sessionKey);

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

			const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
			if (conflict) return conflict;

			if (checkBypass(body)) {
				return c.json({ success: true, memories: [], bypassed: true });
			}

			const auth = c.req.header("authorization");
			const headers: Record<string, string> = auth
				? { "Content-Type": "application/json", Authorization: auth }
				: { "Content-Type": "application/json" };
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
		try {
			const body = (await c.req.json()) as RecallRequest;

			if (!body.harness || !body.query) {
				return c.json({ error: "harness and query are required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
			if (conflict) return conflict;

			if (checkBypass(body)) {
				return c.json(emptyHookRecallResponse(body.query, { bypassed: true }));
			}

			const agentId = resolveAgentId({
				agentId: c.req.header("x-signet-agent-id"),
				sessionKey: body.sessionKey,
			});
			const agentScope = getAgentScope(agentId);
			const cfg = loadMemoryConfig(AGENTS_DIR);
			const result = await hybridRecall(
				{
					query: body.query,
					keywordQuery: body.keywordQuery,
					limit: body.limit,
					project: body.project,
					type: body.type,
					tags: body.tags,
					who: body.who,
					since: body.since,
					until: body.until,
					expand: body.expand,
					agentId,
					readPolicy: agentScope.readPolicy,
					policyGroup: agentScope.policyGroup,
				},
				cfg,
				fetchEmbedding,
			);
			return c.json(withHookRecallCompat(result));
		} catch (e) {
			logger.error("hooks", "Recall hook failed", e as Error);
			return c.json({ error: "Hook execution failed" }, 500);
		}
	});
}

// Pre-compaction hook - provides summary instructions
function registerPreCompaction(app: Hono): void {
	app.post("/api/hooks/pre-compaction", async (c) => {
		try {
			const body = (await c.req.json()) as PreCompactionRequest;

			if (!body.harness) {
				return c.json({ error: "harness is required" }, 400);
			}

			const runtimePath = resolveRuntimePath(c, body);
			if (runtimePath) body.runtimePath = runtimePath;

			const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
			if (conflict) return conflict;

			if (checkBypass(body)) {
				return c.json({ instructions: "", bypassed: true });
			}

			const result = handlePreCompaction(body);
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

			const runtimePath = resolveRuntimePath(c, body);
			const conflict = checkSessionClaim(c, body.sessionKey, runtimePath);
			if (conflict) return conflict;

			if (checkBypass(body)) {
				return c.json({ success: true, bypassed: true });
			}

			if (!existsSync(MEMORY_DB)) {
				return c.json({ error: "Memory database not found" }, 500);
			}

			const now = new Date().toISOString();
			const scopedAgent = resolveScopedAgentId(
				c,
				resolveAgentId({ agentId: body.agentId, sessionKey: body.sessionKey }),
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
							who, tags, project, agent_id, created_at, updated_at, updated_by
						)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						summaryId,
						body.summary,
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
						body.summary,
						Math.ceil(body.summary.length / 4),
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
						content: body.summary,
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
						summary: body.summary,
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

			if (body.sessionKey) {
				resetPromptDedup(body.sessionKey);
			}

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

function registerCrossAgentMessages(app: Hono): void {
	app.get("/api/cross-agent/messages", (c) => {
		const requestedAgentId = parseOptionalString(c.req.query("agent_id"));
		const sessionKey = parseOptionalString(c.req.query("session_key"));
		const since = parseOptionalString(c.req.query("since"));
		const includeSent = parseOptionalBoolean(c.req.query("include_sent")) ?? false;
		const includeBroadcast = parseOptionalBoolean(c.req.query("include_broadcast")) ?? true;
		const limit = parseOptionalInt(c.req.query("limit")) ?? 100;
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

		const items = listAgentMessages({
			agentId: scopedAgent.agentId,
			sessionKey,
			since,
			includeSent,
			includeBroadcast,
			limit,
		});

		return c.json({
			items,
			count: items.length,
		});
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

		let deliveryStatus: "queued" | "delivered" | "failed" = "delivered";
		let deliveryError: string | undefined;
		let deliveryReceipt: Record<string, unknown> | undefined;

		if (deliveryPath === "acp") {
			const acpPayload = toRecord(payload.acp);
			const baseUrl = parseOptionalString(acpPayload?.baseUrl) ?? parseOptionalString(acpPayload?.url);
			const targetAgentName =
				parseOptionalString(acpPayload?.targetAgentName) ?? parseOptionalString(acpPayload?.agentName);

			if (!baseUrl || !targetAgentName) {
				return c.json(
					{
						error: "acp.baseUrl and acp.targetAgentName are required when via='acp'",
					},
					400,
				);
			}

			const timeoutMs = parseOptionalInt(acpPayload?.timeoutMs);
			const metadata = toRecord(acpPayload?.metadata) ?? undefined;

			const relay = await relayMessageViaAcp({
				baseUrl,
				targetAgentName,
				content,
				fromAgentId: scopedSender.agentId,
				fromSessionKey,
				timeoutMs,
				metadata,
			});

			deliveryStatus = relay.ok ? "delivered" : "failed";
			deliveryError = relay.error;
			const receipt: Record<string, unknown> = {
				status: relay.status,
			};
			if (relay.runId) {
				receipt.runId = relay.runId;
			}
			deliveryReceipt = receipt;
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
				deliveryStatus,
				deliveryError,
				deliveryReceipt,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return c.json({ error: msg }, 400);
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
	registerSessionEnd(app);
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

import type { Hono } from "hono";
import { resolveAgentId } from "../agent-id.js";
import { requirePermission, requirePermissionWithRateLimit } from "../auth";

import { getAgentPresenceForSessionAgent, listAgentPresence, touchAgentPresence } from "../cross-agent.js";
import { contentRead } from "../content-read";
import { resolveRouteReadScope } from "./read-scope";
import { getDbAccessor } from "../db-accessor.js";
import { jsonBody } from "../request-body";
import { reportReadResult } from "../request-read";
import {
	bypassSession,
	getActiveSessions,
	isSessionBypassed,
	normalizeSessionKey,
	renewSession,
	unbypassSession,
} from "../session-tracker.js";
import { deleteSessionTranscript } from "../session-transcript-lifecycle";

import { clampGitSyncIntervalSeconds } from "./git-config.js";
import { authAdminLimiter, authConfig, authForgetLimiter } from "./state.js";
import {
	parseOptionalString,
	readOptionalJsonObject,
	resolveScopedAgentId,
	resolveScopedProject,
	validateSessionControl,
} from "./utils.js";

function listLiveSessions(agentId: string): Array<{
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

export interface GitConfig {
	enabled: boolean;
	autoCommit: boolean;
	autoSync: boolean;
	syncInterval: number;
	remote: string;
	branch: string;
}

export function applyGitConfigPatch(gc: GitConfig, body: Partial<GitConfig>): void {
	if (body.autoCommit !== undefined && typeof body.autoCommit === "boolean") gc.autoCommit = body.autoCommit;
	if (body.autoSync !== undefined && typeof body.autoSync === "boolean") gc.autoSync = body.autoSync;
	if (body.syncInterval !== undefined) {
		gc.syncInterval = clampGitSyncIntervalSeconds(body.syncInterval) ?? gc.syncInterval;
	}
	if (typeof body.remote === "string" && body.remote.length > 0) gc.remote = body.remote;
	if (typeof body.branch === "string" && body.branch.length > 0) gc.branch = body.branch;
}

export interface SessionRoutesDeps {
	gitConfig: GitConfig;
	stopGitSyncTimer: () => Promise<void>;
	startGitSyncTimer: () => void;
	getGitStatus: () => Promise<Record<string, unknown>>;
	gitPull: () => Promise<Record<string, unknown>>;
	gitPush: () => Promise<Record<string, unknown>>;
	gitSync: () => Promise<Record<string, unknown>>;
}

export function registerSessionRoutes(app: Hono, deps: SessionRoutesDeps): void {
	const { gitConfig: gc, stopGitSyncTimer, startGitSyncTimer, getGitStatus, gitPull, gitPush, gitSync } = deps;
	app.use("/api/sessions/summaries", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/sessions/search", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/sessions/blackbox", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/sessions/:key{(?!summaries$)[^/]+}/blackbox", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/sessions/:key{(?!summaries$)[^/]+}/transcript", async (c, next) => {
		if (c.req.method === "DELETE") {
			if (c.req.query("purge") === "hard")
				return requirePermissionWithRateLimit("admin", "admin", authAdminLimiter, authConfig)(c, next);
			return requirePermissionWithRateLimit("forget", "forget", authForgetLimiter, authConfig)(c, next);
		}
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/sessions/:key{(?!summaries$)[^/]+}/bypass", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/sessions/:key{(?!summaries$)[^/]+}/renew", async (c, next) => {
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/git/*", async (c, next) => {
		return requirePermission("admin", authConfig)(c, next);
	});

	app.get("/api/sessions", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		if (!c.get("organization") && resolved.scope.projects === null) {
			const sessions = listLiveSessions(resolved.agentId);
			return c.json({ sessions, count: sessions.length });
		}
		const rows = await contentRead<Array<Record<string, unknown>>>(
			{ op: "transcripts", mode: "list", scope: resolved.scope, limit: 500 },
			c.req.raw.signal,
		);
		const sessions = rows.map(({ content: _content, ...row }) => ({
			...row,
			key: row.sessionKey,
			runtimePath: "transcript",
			status: row.completedAt ? "stored" : "active",
		}));
		return c.json({ sessions, count: sessions.length });
	});

	app.get("/api/sessions/blackbox", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const raw = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 50;
		const sessions = await contentRead<unknown[]>(
			{ op: "blackbox_list", scope: resolved.scope, agentId: resolved.agentId, project: c.req.query("project"), limit },
			c.req.raw.signal,
		);
		return c.json({ agentId: resolved.agentId, project: c.req.query("project"), sessions, count: sessions.length });
	});

	app.post("/api/sessions/search", async (c) => {
		const body = await readOptionalJsonObject(c);
		if (!body) return c.json({ error: "Invalid JSON body" }, 400);
		const query = typeof body.query === "string" ? body.query.trim() : "";
		if (!query) return c.json({ error: "query is required" }, 400);
		const resolved = await resolveRouteReadScope(c, {
			agentId: parseOptionalString(body.agentId) ?? parseOptionalString(body.agent_id),
			project: parseOptionalString(body.project),
		});
		if (resolved instanceof Response) return resolved;
		const raw = typeof body.limit === "number" ? body.limit : Number(c.req.query("limit") ?? 10);
		const limit = Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.trunc(raw))) : 10;
		const hits = await contentRead<Array<Record<string, unknown>>>(
			{
				op: "transcripts",
				mode: "search",
				query,
				scope: resolved.scope,
				sessionKey: parseOptionalString(body.sessionKey) ?? parseOptionalString(body.session_key),
				limit,
			},
			c.req.raw.signal,
		);
		reportReadResult(c, resolved.agentId, hits.length);
		return c.json({ query, hits, count: hits.length });
	});

	app.delete("/api/sessions/:key{(?!summaries$)[^/]+}/transcript", async (c) => {
		const requestedGeneration = c.req.query("generation");
		const generation = requestedGeneration === undefined ? undefined : Number(requestedGeneration);
		if (
			requestedGeneration !== undefined &&
			(!/^[1-9][0-9]*$/.test(requestedGeneration) || !Number.isSafeInteger(generation))
		)
			return c.json({ error: "generation must be a positive safe integer" }, 400);
		const purge = c.req.query("purge");
		if (purge !== undefined && purge !== "hard") return c.json({ error: "purge must be hard or omitted" }, 400);
		if (purge === "hard") {
			if (authConfig.mode !== "local" && c.get("auth")?.claims?.role !== "admin")
				return c.json({ error: "Admin credential required for hard purge" }, 403);
		}
		const aliases = [c.req.query("agent_id"), c.req.query("agentId"), c.req.header("x-signet-agent-id")].filter(
			(value) => value !== undefined,
		);
		if (aliases.some((value) => !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) || new Set(aliases).size > 1)
			return c.json({ error: "Invalid agent identity" }, 400);
		const requested = aliases[0] ?? c.get("auth")?.claims?.scope?.agent;
		if (requested !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(requested))
			return c.json({ error: "Invalid agent identity" }, 400);
		if (!requested && authConfig.mode !== "local") return c.json({ error: "Explicit agent identity is required" }, 400);
		const agent = resolveScopedAgentId(c, requested, "default");
		const project = resolveScopedProject(c, c.req.query("project"));
		if (agent.error || project.error) return c.json({ error: "Transcript not found" }, 404);
		const key = normalizeSessionKey(c.req.param("key"));
		if (!key || key.length > 512) return c.json({ error: "Invalid session key" }, 400);
		const presence = getAgentPresenceForSessionAgent(key, agent.agentId);
		const result = await deleteSessionTranscript(
			{
				sessionKey: key,
				generation,
				agentId: agent.agentId,
				project: project.project,
				hard: purge === "hard",
				changedBy: c.get("auth")?.claims?.sub ?? "local",
				...(presence ? { live: { harness: presence.harness, project: presence.project ?? null } } : {}),
			},
			c.req.raw.signal,
		);
		if (result.status === "not_found") return c.json({ error: "Transcript not found" }, 404);
		if (result.status === "conflict")
			return c.json({ error: "Transcript generation changed", generation: result.generation }, 409);
		return c.json(result);
	});

	app.get("/api/sessions/:key{(?!summaries$)[^/]+}/transcript", async (c) => {
		const key = normalizeSessionKey(c.req.param("key"));
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const row = await contentRead<Record<string, unknown> | null>(
			{ op: "transcripts", mode: "detail", scope: resolved.scope, sessionKey: key, limit: 1 },
			c.req.raw.signal,
		);
		if (!row) return c.json({ error: "Transcript not found" }, 404);
		return c.json(row);
	});

	app.get("/api/sessions/:key{(?!summaries$)[^/]+}/blackbox", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const at = c.req.query("at");
		if (at && Number.isNaN(Date.parse(at))) return c.json({ error: "at must be an ISO timestamp" }, 400);
		const raw = Number.parseInt(c.req.query("limit") ?? "500", 10);
		const limit = Number.isFinite(raw) ? Math.max(1, Math.min(500, raw)) : 500;
		const result = await contentRead<import("../black-box").BlackBoxSession>(
			{
				op: "blackbox",
				scope: resolved.scope,
				agentId: resolved.agentId,
				sessionKey: normalizeSessionKey(c.req.param("key")),
				project: c.req.query("project"),
				at,
				limit,
			},
			c.req.raw.signal,
		);
		return c.json(result);
	});

	app.get("/api/sessions/:key{(?!summaries$)[^/]+}", async (c) => {
		const key = normalizeSessionKey(c.req.param("key"));
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const stored = await contentRead<Record<string, unknown> | null>(
			{ op: "transcripts", mode: "detail", scope: resolved.scope, sessionKey: key, limit: 1 },
			c.req.raw.signal,
		);
		if (!c.get("organization") && (resolved.scope.projects === null || stored)) {
			const live = listLiveSessions(resolved.agentId).find((row) => row.key === key);
			if (live) return c.json(live);
		}
		if (!stored) return c.json({ error: "Session not found" }, 404);
		const { content: _content, ...row } = stored;
		return c.json({
			...row,
			key: `session:${stored.sessionKey}`,
			runtimePath: "transcript",
			provider: "session_transcripts",
			startedAt: stored.createdAt,
			lastSeenAt: stored.updatedAt ?? stored.createdAt,
			status: "stored",
		});
	});

	app.post("/api/sessions/:key{(?!summaries$)[^/]+}/bypass", async (c) => {
		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const key = normalizeSessionKey(c.req.param("key"));
		const sessions = listLiveSessions(scopedAgent.agentId);
		const session = sessions.find((s) => s.key === key);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const bindingError = await validateSessionControl(c, key, scopedAgent.agentId, {
			context: "session",
		});
		if (bindingError) return c.json({ error: bindingError }, 403);

		const body = await readOptionalJsonObject(c);
		if (!body || typeof body.enabled !== "boolean") {
			return c.json({ error: "enabled (boolean) is required" }, 400);
		}
		const enabled = body.enabled === true;

		if (enabled) {
			const ok = bypassSession(key, { allowUnknown: session.expiresAt === null }, scopedAgent.agentId);
			if (!ok) {
				return c.json({ error: "Session not found or already released" }, 404);
			}
		} else {
			unbypassSession(key, scopedAgent.agentId);
			if (isSessionBypassed(key, scopedAgent.agentId))
				return c.json({ error: "Deleted transcript capture stays bypassed until session end" }, 409);
		}
		return c.json({ key, bypassed: enabled });
	});

	app.post("/api/sessions/:key{(?!summaries$)[^/]+}/renew", async (c) => {
		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const key = normalizeSessionKey(c.req.param("key"));
		const session = listLiveSessions(scopedAgent.agentId).find((s) => s.key === key);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const bindingError = await validateSessionControl(c, key, scopedAgent.agentId, {
			context: "session",
		});
		if (bindingError) return c.json({ error: bindingError }, 403);
		if (session.expiresAt === null) {
			touchAgentPresence(key, scopedAgent.agentId);
			return c.json({ key, renewed: true });
		}
		const expiresAt = renewSession(key, scopedAgent.agentId);
		if (!expiresAt) {
			return c.json({ error: "Session not found or expired" }, 404);
		}
		return c.json({ key, renewed: true, expiresAt });
	});

	app.get("/api/sessions/summaries", async (c) => {
		const resolved = await resolveRouteReadScope(c, { allowAllAgents: true });
		if (resolved instanceof Response) return resolved;
		const depthRaw = c.req.query("depth");
		const depth = depthRaw === undefined ? undefined : Number(depthRaw);
		if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0 || depthRaw?.trim() === ""))
			return c.json({ error: "depth must be a non-negative integer" }, 400);
		const limit = Math.max(0, Math.min(200, Number.parseInt(c.req.query("limit") ?? "50", 10) || 0));
		const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
		const result = await contentRead<{ summaries: Array<Record<string, unknown>>; total: number }>(
			{
				op: "summaries",
				scope: resolved.scope,
				depth,
				sessionKey: c.req.query("session_key") ?? c.req.query("sessionKey"),
				limit,
				offset,
			},
			c.req.raw.signal,
		);
		return c.json(result);
	});

	app.post("/api/sessions/summaries/expand", async (c) => {
		const body = await jsonBody(c)().catch((): Record<string, unknown> => ({}));
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (!id) {
			return c.json({ error: "id is required" }, 400);
		}

		const includeTranscript = typeof body.includeTranscript === "boolean" ? body.includeTranscript : true;
		const transcriptCharLimit =
			typeof body.transcriptCharLimit === "number" && Number.isFinite(body.transcriptCharLimit)
				? Math.max(200, Math.min(12000, Math.trunc(body.transcriptCharLimit)))
				: undefined;
		const resolved = await resolveRouteReadScope(c, {
			agentId: parseOptionalString(body.agentId),
			project: parseOptionalString(body.project),
		});
		if (resolved instanceof Response) return resolved;
		const result = await contentRead<Record<string, unknown> | null>(
			{
				op: "summary_expand",
				id,
				agentId: resolved.agentId,
				scope: resolved.scope,
				includeTranscript,
				transcriptCharLimit,
			},
			c.req.raw.signal,
		);
		if (!result) {
			return c.json({ error: "summary node not found" }, 404);
		}
		return c.json(result);
	});

	app.get("/api/git/status", async (c) => {
		try {
			const status = await getGitStatus();
			return c.json(status);
		} catch (error) {
			return c.json(
				{
					isRepo: false,
					hasCredentials: false,
					autoSync: gc.autoSync,
					degraded: true,
					degradedReason: `Git status unavailable: ${error instanceof Error ? error.message : String(error)}`,
				},
				200,
			);
		}
	});

	app.post("/api/git/pull", async (c) => {
		try {
			const result = await gitPull();
			return c.json(result);
		} catch (error) {
			return c.json({
				success: false,
				message: `Git pull unavailable: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	});

	app.post("/api/git/push", async (c) => {
		try {
			const result = await gitPush();
			return c.json(result);
		} catch (error) {
			return c.json({
				success: false,
				message: `Git push unavailable: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	});

	app.post("/api/git/sync", async (c) => {
		try {
			const result = await gitSync();
			return c.json(result);
		} catch (error) {
			return c.json({
				success: false,
				message: `Git sync unavailable: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	});

	app.get("/api/git/config", (c) => {
		return c.json(gc);
	});

	app.post("/api/git/config", async (c) => {
		const body = (await jsonBody(c)()) as Partial<GitConfig>;

		applyGitConfigPatch(gc, body);

		if (typeof body.autoSync === "boolean" || body.syncInterval !== undefined) {
			await stopGitSyncTimer();
			if (gc.autoSync) {
				startGitSyncTimer();
			}
		}

		return c.json({ success: true, config: gc });
	});
}

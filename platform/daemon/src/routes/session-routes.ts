import type { Hono } from "hono";
import { resolveAgentId } from "../agent-id.js";
import { requirePermission } from "../auth";
import { buildBlackBoxSession, listBlackBoxSessions } from "../black-box.js";
import { listAgentPresence, touchAgentPresence } from "../cross-agent.js";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import {
	type RuntimePath,
	bypassSession,
	getActiveSessions,
	isSessionBypassed,
	normalizeSessionKey,
	renewSession,
	unbypassSession,
} from "../session-tracker.js";
import { getSessionTranscriptContent } from "../session-transcripts.js";
import { searchSessionTranscripts } from "../subagent-context.js";
import { expandTemporalNode } from "../temporal-expand.js";
import { authConfig } from "./state.js";
import { parseOptionalString, readOptionalJsonObject, resolveScopedAgentId, resolveScopedProject } from "./utils.js";

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
			bypassed: isSessionBypassed(key),
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
	if (body.syncInterval !== undefined && typeof body.syncInterval === "number" && Number.isFinite(body.syncInterval)) {
		gc.syncInterval = body.syncInterval;
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

	// Permission guards
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
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/git/*", async (c, next) => {
		return requirePermission("admin", authConfig)(c, next);
	});

	app.get("/api/sessions", (c) => {
		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const sessions = listLiveSessions(scopedAgent.agentId);
		return c.json({ sessions, count: sessions.length });
	});

	app.get("/api/sessions/blackbox", (c) => {
		const scopedAgent = resolveScopedAgentId(
			c,
			parseOptionalString(c.req.query("agent_id")) ?? parseOptionalString(c.req.query("agentId")),
			"default",
		);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const scopedProject = resolveScopedProject(c, c.req.query("project"));
		if (scopedProject.error) return c.json({ error: scopedProject.error }, 403);
		const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
		const sessions = listBlackBoxSessions(getDbAccessor(), {
			agentId: scopedAgent.agentId,
			project: scopedProject.project,
			limit,
		});
		return c.json({ agentId: scopedAgent.agentId, project: scopedProject.project, sessions, count: sessions.length });
	});

	app.post("/api/sessions/search", async (c) => {
		const body = await readOptionalJsonObject(c);
		if (!body) return c.json({ error: "Invalid JSON body" }, 400);
		const query = typeof body.query === "string" ? body.query.trim() : "";
		if (query.length === 0) return c.json({ error: "query is required" }, 400);

		const rawAgentId =
			(typeof body.agentId === "string" ? body.agentId : undefined) ??
			(typeof body.agent_id === "string" ? body.agent_id : undefined) ??
			c.req.query("agent_id");
		const rawCurrentSessionKey =
			(typeof body.currentSessionKey === "string" ? body.currentSessionKey : undefined) ??
			(typeof body.current_session_key === "string" ? body.current_session_key : undefined);
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId: rawAgentId,
				sessionKey: rawCurrentSessionKey ?? (typeof body.sessionKey === "string" ? body.sessionKey : undefined),
			}),
		);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);

		const scopedProject = resolveScopedProject(
			c,
			(typeof body.project === "string" ? body.project : undefined) ?? c.req.query("project"),
		);
		if (scopedProject.error) return c.json({ error: scopedProject.error }, 403);

		const limitRaw = typeof body.limit === "number" ? body.limit : Number(c.req.query("limit") ?? 10);
		const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.trunc(limitRaw))) : 10;
		const sessionKey =
			(typeof body.sessionKey === "string" ? body.sessionKey : undefined) ??
			(typeof body.session_key === "string" ? body.session_key : undefined);

		const hits = getDbAccessor().withReadDb((db) =>
			searchSessionTranscripts({
				db,
				query,
				agentId: scopedAgent.agentId,
				sessionKey,
				currentSessionKey: rawCurrentSessionKey,
				project: scopedProject.project,
				limit,
			}),
		);
		return c.json({ query, hits, count: hits.length });
	});

	app.get("/api/sessions/:key{(?!summaries$)[^/]+}/transcript", (c) => {
		const key = normalizeSessionKey(c.req.param("key"));
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId: c.req.query("agent_id") ?? c.req.header("x-signet-agent-id"),
				sessionKey: key,
			}),
		);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const content = getSessionTranscriptContent(key, scopedAgent.agentId);
		if (!content) return c.json({ error: "Transcript not found" }, 404);
		return c.json({ sessionKey: key, agentId: scopedAgent.agentId, content });
	});

	app.get("/api/sessions/:key{(?!summaries$)[^/]+}/blackbox", (c) => {
		const key = c.req.param("key").trim();
		const requestedAgentId =
			parseOptionalString(c.req.query("agent_id")) ??
			parseOptionalString(c.req.query("agentId")) ??
			parseOptionalString(c.req.header("x-signet-agent-id"));
		const scopedAgent = resolveScopedAgentId(
			c,
			requestedAgentId ?? (key.startsWith("agent:") ? resolveAgentId({ sessionKey: key }) : undefined),
		);
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const scopedProject = resolveScopedProject(c, c.req.query("project"));
		if (scopedProject.error) return c.json({ error: scopedProject.error }, 403);
		const atRaw = parseOptionalString(c.req.query("at"));
		let at: string | undefined;
		if (atRaw) {
			const parsed = new Date(atRaw);
			if (Number.isNaN(parsed.getTime())) return c.json({ error: "at must be an ISO timestamp" }, 400);
			at = parsed.toISOString();
		}
		const limitRaw = Number.parseInt(c.req.query("limit") ?? "500", 10);
		const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 500;
		return c.json(
			buildBlackBoxSession(getDbAccessor(), {
				agentId: scopedAgent.agentId,
				sessionKey: key,
				project: scopedProject.project,
				at,
				limit,
			}),
		);
	});

	app.get("/api/sessions/:key{(?!summaries$)[^/]+}", (c) => {
		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const key = normalizeSessionKey(c.req.param("key"));
		const sessions = listLiveSessions(scopedAgent.agentId);
		const session = sessions.find((s) => s.key === key);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(session);
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

		const body = await readOptionalJsonObject(c);
		if (!body || typeof body.enabled !== "boolean") {
			return c.json({ error: "enabled (boolean) is required" }, 400);
		}
		const enabled = body.enabled === true;

		if (enabled) {
			const ok = bypassSession(key, { allowUnknown: session.expiresAt === null });
			if (!ok) {
				return c.json({ error: "Session not found or already released" }, 404);
			}
		} else {
			unbypassSession(key);
		}
		return c.json({ key, bypassed: enabled });
	});

	app.post("/api/sessions/:key{(?!summaries$)[^/]+}/renew", (c) => {
		const scopedAgent = resolveScopedAgentId(c, c.req.query("agent_id"), "default");
		if (scopedAgent.error) return c.json({ error: scopedAgent.error }, 403);
		const key = normalizeSessionKey(c.req.param("key"));
		const session = listLiveSessions(scopedAgent.agentId).find((s) => s.key === key);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		if (session.expiresAt === null) {
			touchAgentPresence(key, scopedAgent.agentId);
			return c.json({ key, renewed: true });
		}
		const expiresAt = renewSession(key);
		if (!expiresAt) {
			return c.json({ error: "Session not found or expired" }, 404);
		}
		return c.json({ key, renewed: true, expiresAt });
	});

	app.get("/api/sessions/summaries", (c) => {
		const accessor = getDbAccessor();
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId:
					parseOptionalString(c.req.query("agent_id")) ??
					parseOptionalString(c.req.query("agentId")) ??
					parseOptionalString(c.req.header("x-signet-agent-id")),
				sessionKey:
					parseOptionalString(c.req.query("session_key")) ??
					parseOptionalString(c.req.query("sessionKey")) ??
					parseOptionalString(c.req.header("x-signet-session-key")),
			}),
		);
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const scopedProject = resolveScopedProject(c, c.req.query("project"));
		if (scopedProject.error) {
			return c.json({ error: scopedProject.error }, 403);
		}
		const agentId = scopedAgent.agentId;
		const project = scopedProject.project;
		const depthRaw = c.req.query("depth");
		const depthNum = depthRaw !== undefined ? Number(depthRaw) : undefined;
		if (
			depthNum !== undefined &&
			(Number.isNaN(depthNum) || !Number.isInteger(depthNum) || depthNum < 0 || depthRaw?.trim() === "")
		) {
			return c.json({ error: "depth must be a non-negative integer" }, 400);
		}
		const limitParsed = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParsed = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParsed) ? Math.min(Math.max(limitParsed, 0), 200) : 50;
		const offset = Number.isFinite(offsetParsed) ? Math.max(offsetParsed, 0) : 0;

		const tableExists = accessor.withReadDb((db) =>
			db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries'`).get(),
		);
		if (!tableExists) {
			return c.json({ summaries: [], total: 0 });
		}

		return accessor.withReadDb((db) => {
			let where = "WHERE agent_id = ?";
			const params: unknown[] = [agentId];

			if (project) {
				where += " AND project = ?";
				params.push(project);
			}
			if (depthNum !== undefined) {
				where += " AND depth = ?";
				params.push(depthNum);
			}

			const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM session_summaries ${where}`).get(...params) as
				| { cnt: number }
				| undefined;

			const summaries = db
				.prepare(
					`SELECT id, project, depth, kind, content, token_count,
					        earliest_at, latest_at, session_key, harness, agent_id,
					        source_type, source_ref, meta_json, created_at
					 FROM session_summaries
					 ${where}
					 ORDER BY latest_at DESC
					 LIMIT ? OFFSET ?`,
				)
				.all(...params, limit, offset) as Array<Record<string, unknown>>;

			const childCountStmt = db.prepare("SELECT COUNT(*) as cnt FROM session_summary_children WHERE parent_id = ?");

			const enriched = summaries.map((s) => {
				const childRow = childCountStmt.get(s.id) as { cnt: number } | undefined;
				return { ...s, childCount: childRow?.cnt ?? 0 };
			});

			return c.json({
				summaries: enriched,
				total: countRow?.cnt ?? 0,
			});
		});
	});

	app.post("/api/sessions/summaries/expand", async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (!id) {
			return c.json({ error: "id is required" }, 400);
		}

		const includeTranscript = typeof body.includeTranscript === "boolean" ? body.includeTranscript : true;
		const transcriptCharLimit =
			typeof body.transcriptCharLimit === "number" && Number.isFinite(body.transcriptCharLimit)
				? Math.max(200, Math.min(12000, Math.trunc(body.transcriptCharLimit)))
				: undefined;
		const scopedAgent = resolveScopedAgentId(
			c,
			resolveAgentId({
				agentId: typeof body.agentId === "string" ? body.agentId : c.req.header("x-signet-agent-id"),
				sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : c.req.header("x-signet-session-key"),
			}),
		);
		if (scopedAgent.error) {
			return c.json({ error: scopedAgent.error }, 403);
		}
		const scopedProject = resolveScopedProject(c, undefined);
		if (scopedProject.error) {
			return c.json({ error: scopedProject.error }, 403);
		}

		const result = expandTemporalNode(id, scopedAgent.agentId, {
			includeTranscript,
			project: scopedProject.project,
			transcriptCharLimit,
		});
		if (!result) {
			return c.json({ error: "summary node not found" }, 404);
		}
		return c.json(result);
	});

	// Git Sync API

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
		const body = (await c.req.json()) as Partial<GitConfig>;

		applyGitConfigPatch(gc, body);

		if (
			typeof body.autoSync === "boolean" ||
			(typeof body.syncInterval === "number" && Number.isFinite(body.syncInterval))
		) {
			stopGitSyncTimer();
			if (gc.autoSync) {
				startGitSyncTimer();
			}
		}

		return c.json({ success: true, config: gc });
	});
}

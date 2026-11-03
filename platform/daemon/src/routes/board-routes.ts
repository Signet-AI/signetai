import type { Context, Hono } from "hono";
import { resolveAgentId } from "../agent-id";
import { requirePermission, requireRateLimit } from "../auth";
import {
	BOARD_THREAD_STATUSES,
	type BoardAuthor,
	type BoardThreadStatus,
	type BoardViewer,
	createBoardEventVisibility,
	createBoardThread,
	createBoardTopic,
	deleteBoardThread,
	isBoardError,
	listBoardThreads,
	listBoardTopics,
	markBoardThreadRead,
	readBoardThread,
	replyToBoardThread,
	resolveBoardViewer,
	subscribeBoardEvents,
	updateBoardThread,
} from "../board";
import { logger } from "../logger";
import { openBoundedSse } from "../sse-stream.js";
import { authConfig, authCrossAgentMessageLimiter } from "./state";
import {
	parseOptionalBoolean,
	parseOptionalInt,
	parseOptionalString,
	readOptionalJsonObject,
	resolveScopedAgentId,
	shouldEnforceAuthScope,
	validateSessionAgentBinding,
} from "./utils";

type Resolved<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };

function canActAsOperator(c: Context): boolean {
	if (!shouldEnforceAuthScope(c)) return true;
	return c.get("auth")?.claims?.role === "admin";
}

function readIdentityInput(
	c: Context,
	payload: Record<string, unknown> | null,
): { readonly agentId?: string; readonly sessionKey?: string; readonly scope?: string } {
	return {
		agentId:
			parseOptionalString(payload?.agentId) ??
			parseOptionalString(c.req.query("agent_id")) ??
			parseOptionalString(c.req.header("x-signet-agent-id")),
		sessionKey:
			parseOptionalString(payload?.sessionKey) ??
			parseOptionalString(c.req.query("session_key")) ??
			parseOptionalString(c.req.header("x-signet-session-key")),
		scope: parseOptionalString(payload?.scope) ?? parseOptionalString(c.req.query("scope")),
	};
}

async function resolveViewer(c: Context, payload: Record<string, unknown> | null): Promise<Resolved<BoardViewer>> {
	const identity = readIdentityInput(c, payload);
	if (identity.scope === "all") {
		if (!canActAsOperator(c)) {
			return { ok: false, response: c.json({ error: "scope=all requires local mode or an admin token" }, 403) };
		}
		return { ok: true, value: { kind: "operator" } };
	}
	const scoped = resolveScopedAgentId(
		c,
		resolveAgentId({ agentId: identity.agentId, sessionKey: identity.sessionKey }),
		"default",
	);
	if (scoped.error) return { ok: false, response: c.json({ error: scoped.error }, 403) };
	return { ok: true, value: await resolveBoardViewer(scoped.agentId) };
}

async function resolveAuthor(
	c: Context,
	payload: Record<string, unknown> | null,
): Promise<Resolved<{ readonly viewer: BoardViewer; readonly author: BoardAuthor }>> {
	const identity = readIdentityInput(c, payload);
	if (identity.scope === "all") {
		return { ok: false, response: c.json({ error: "board posts require an agent identity" }, 400) };
	}
	const scoped = resolveScopedAgentId(
		c,
		resolveAgentId({ agentId: identity.agentId, sessionKey: identity.sessionKey }),
		"default",
	);
	if (scoped.error) return { ok: false, response: c.json({ error: scoped.error }, 403) };
	const sessionError = validateSessionAgentBinding(c, identity.sessionKey, scoped.agentId, {
		requireExisting: true,
		context: "sessionKey",
	});
	if (sessionError) return { ok: false, response: c.json({ error: sessionError }, 403) };
	return {
		ok: true,
		value: {
			viewer: await resolveBoardViewer(scoped.agentId),
			author: {
				agentId: scoped.agentId,
				sessionKey: identity.sessionKey,
				harness: parseOptionalString(payload?.harness),
			},
		},
	};
}

function boardErrorResponse(c: Context, error: unknown, action: string): Response {
	if (isBoardError(error)) return c.json({ error: error.message }, error.status);
	logger.error("board", `Board ${action} failed`, error instanceof Error ? error : new Error(String(error)));
	return c.json({ error: `Board ${action} failed` }, 500);
}

function parseStatus(value: string | undefined): BoardThreadStatus | "all" | undefined | null {
	if (value === undefined) return undefined;
	if (value === "all") return "all";
	return BOARD_THREAD_STATUSES.find((status) => status === value) ?? null;
}

function parseTags(value: unknown): readonly unknown[] | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		return value
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0);
	}
	return null;
}

export function registerBoardRoutes(app: Hono): void {
	app.use("/api/board/*", async (c, next) => {
		if (c.req.method === "GET") return requirePermission("recall", authConfig)(c, next);
		return requirePermission("remember", authConfig)(c, next);
	});
	app.use("/api/board/*", async (c, next) => {
		if (c.req.method !== "POST" && c.req.method !== "DELETE" && c.req.method !== "PATCH") {
			await next();
			return;
		}
		return requireRateLimit("board-write", authCrossAgentMessageLimiter, authConfig)(c, next);
	});

	app.get("/api/board/topics", async (c) => {
		const viewer = await resolveViewer(c, null);
		if (!viewer.ok) return viewer.response;
		try {
			const topics = await listBoardTopics(viewer.value);
			return c.json({ topics, count: topics.length });
		} catch (error) {
			return boardErrorResponse(c, error, "topic list");
		}
	});

	app.post("/api/board/topics", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const resolved = await resolveAuthor(c, payload);
		if (!resolved.ok) return resolved.response;
		try {
			const topic = await createBoardTopic({
				slug: parseOptionalString(payload.slug),
				title: parseOptionalString(payload.title),
				description: parseOptionalString(payload.description),
				author: resolved.value.author,
			});
			return c.json(topic, topic.created ? 201 : 200);
		} catch (error) {
			return boardErrorResponse(c, error, "topic create");
		}
	});

	app.get("/api/board/threads", async (c) => {
		const viewer = await resolveViewer(c, null);
		if (!viewer.ok) return viewer.response;
		const status = parseStatus(parseOptionalString(c.req.query("status")));
		if (status === null) {
			return c.json({ error: `status must be one of ${[...BOARD_THREAD_STATUSES, "all"].join(", ")}` }, 400);
		}
		try {
			const page = await listBoardThreads(viewer.value, {
				topic: parseOptionalString(c.req.query("topic")),
				tag: parseOptionalString(c.req.query("tag")),
				status,
				limit: parseOptionalInt(c.req.query("limit")),
				offset: Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
			});
			return c.json(page);
		} catch (error) {
			return boardErrorResponse(c, error, "thread list");
		}
	});

	app.post("/api/board/threads", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const resolved = await resolveAuthor(c, payload);
		if (!resolved.ok) return resolved.response;
		const tags = parseTags(payload.tags);
		if (tags === null) return c.json({ error: "tags must be an array of strings" }, 400);
		try {
			const result = await createBoardThread({
				viewer: resolved.value.viewer,
				author: resolved.value.author,
				topic: parseOptionalString(payload.topic),
				title: parseOptionalString(payload.title),
				body: typeof payload.body === "string" ? payload.body : undefined,
				tags,
				fromMessageId: parseOptionalString(payload.fromMessageId),
			});
			return c.json(result, 201);
		} catch (error) {
			return boardErrorResponse(c, error, "thread create");
		}
	});

	app.get("/api/board/threads/:threadId", async (c) => {
		const viewer = await resolveViewer(c, null);
		if (!viewer.ok) return viewer.response;
		try {
			const detail = await readBoardThread(c.req.param("threadId"), viewer.value, {
				postLimit: parseOptionalInt(c.req.query("limit")),
				postOffset: Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
			});
			return c.json(detail);
		} catch (error) {
			return boardErrorResponse(c, error, "thread read");
		}
	});

	app.patch("/api/board/threads/:threadId", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const viewer = await resolveViewer(c, payload);
		if (!viewer.ok) return viewer.response;
		if (payload.status !== undefined && typeof payload.status !== "string") {
			return c.json({ error: `status must be one of ${BOARD_THREAD_STATUSES.join(", ")}` }, 400);
		}
		if (payload.title !== undefined && typeof payload.title !== "string") {
			return c.json({ error: "title must be a string" }, 400);
		}
		if (payload.tags === null) return c.json({ error: "tags must be an array of strings" }, 400);
		const rawStatus = parseOptionalString(payload.status);
		const status = rawStatus === undefined ? undefined : parseStatus(rawStatus);
		if (status === null || status === "all") {
			return c.json({ error: `status must be one of ${BOARD_THREAD_STATUSES.join(", ")}` }, 400);
		}
		const pinned = payload.pinned === undefined ? undefined : parseOptionalBoolean(payload.pinned);
		if (payload.pinned !== undefined && pinned === undefined) {
			return c.json({ error: "pinned must be a boolean" }, 400);
		}
		const tags = parseTags(payload.tags);
		if (tags === null) return c.json({ error: "tags must be an array of strings" }, 400);
		try {
			const thread = await updateBoardThread({
				viewer: viewer.value,
				threadId: c.req.param("threadId"),
				status,
				pinned,
				title: typeof payload.title === "string" ? payload.title : undefined,
				tags,
			});
			return c.json({ thread });
		} catch (error) {
			return boardErrorResponse(c, error, "thread update");
		}
	});

	app.delete("/api/board/threads/:threadId", async (c) => {
		const viewer = await resolveViewer(c, null);
		if (!viewer.ok) return viewer.response;
		try {
			return c.json(await deleteBoardThread(c.req.param("threadId"), viewer.value));
		} catch (error) {
			return boardErrorResponse(c, error, "thread delete");
		}
	});

	app.post("/api/board/threads/:threadId/posts", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const resolved = await resolveAuthor(c, payload);
		if (!resolved.ok) return resolved.response;
		try {
			const result = await replyToBoardThread({
				viewer: resolved.value.viewer,
				author: resolved.value.author,
				threadId: c.req.param("threadId"),
				body: typeof payload.body === "string" ? payload.body : undefined,
				replyToPostId: parseOptionalString(payload.replyToPostId),
			});
			return c.json(result, 201);
		} catch (error) {
			return boardErrorResponse(c, error, "reply");
		}
	});

	app.post("/api/board/threads/:threadId/read", async (c) => {
		const payload = await readOptionalJsonObject(c);
		if (payload === null) return c.json({ error: "invalid request body" }, 400);
		const viewer = await resolveViewer(c, payload);
		if (!viewer.ok) return viewer.response;
		if (payload.through !== undefined && typeof payload.through !== "string") {
			return c.json({ error: "through must be an ISO timestamp" }, 400);
		}
		try {
			return c.json(
				await markBoardThreadRead(
					c.req.param("threadId"),
					viewer.value,
					Date.now(),
					typeof payload.through === "string" ? payload.through : undefined,
				),
			);
		} catch (error) {
			return boardErrorResponse(c, error, "mark read");
		}
	});

	app.get("/api/board/stream", async (c) => {
		const viewer = await resolveViewer(c, null);
		if (!viewer.ok) return viewer.response;
		let visible: (authorAgentId: string) => Promise<boolean>;
		try {
			visible = await createBoardEventVisibility(viewer.value);
		} catch (error) {
			return boardErrorResponse(c, error, "stream");
		}
		const sse = openBoundedSse({
			requestSignal: c.req.raw.signal,
			highWaterMarkBytes: 256 * 1024,
			maxFrameBytes: 16 * 1024,
			heartbeat: { intervalMs: 15_000, comment: "keepalive" },
			onStart(producer) {
				let unsubscribe = (): void => {};
				producer.addDisposer(() => unsubscribe());
				if (producer.signal.aborted) return;
				producer.write({ type: "connected", timestamp: new Date().toISOString() });
				if (producer.isClosed) return;
				let pending: Promise<void> = Promise.resolve();
				unsubscribe = subscribeBoardEvents((event) => {
					pending = pending
						.then(async () => {
							if (producer.isClosed) return;
							if (await visible(event.threadAuthorAgentId)) producer.write(event);
						})
						.catch(() => undefined);
				});
				if (producer.isClosed) unsubscribe();
			},
		});
		return sse.response;
	});
}

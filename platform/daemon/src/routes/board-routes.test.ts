import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetBoardStateForTest } from "../board";
import { createAgentMessage, resetCrossAgentStateForTest, upsertAgentPresence } from "../cross-agent";
import { resetDirectMessageWakeStateForTest } from "../cross-agent-wake";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";

const previousSignetPath = process.env.SIGNET_PATH;
const suiteDir = mkdtempSync(join(tmpdir(), "signet-board-routes-suite-"));
process.env.SIGNET_PATH = suiteDir;
const { registerHooksRoutes } = await import("./hooks-routes");
const { registerBoardRoutes } = await import("./board-routes");

let dir = "";
let app: Hono;

beforeEach(() => {
	dir = mkdtempSync(join(suiteDir, "case-"));
	initDbAccessor(join(dir, "memory.db"), { agentsDir: dir });
	app = new Hono();
	registerHooksRoutes(app);
	registerBoardRoutes(app);
});

afterEach(async () => {
	resetDirectMessageWakeStateForTest();
	resetBoardStateForTest();
	resetCrossAgentStateForTest();
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	if (previousSignetPath === undefined) {
		Reflect.deleteProperty(process.env, "SIGNET_PATH");
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(suiteDir, { recursive: true, force: true });
});

async function send(method: string, path: string, body?: Readonly<Record<string, unknown>>): Promise<Response> {
	return app.request(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("direct message wake route", () => {
	it("validates input and returns claimed messages as wake text", async () => {
		expect((await send("POST", "/api/cross-agent/wake", { harness: "pi" })).status).toBe(400);
		expect((await send("POST", "/api/cross-agent/wake", { harness: "pi", sessionKey: "s", waitMs: -1 })).status).toBe(
			400,
		);

		upsertAgentPresence({ agentId: "beta", harness: "pi", sessionKey: "beta-1" });
		const message = createAgentMessage({ fromAgentId: "alpha", toSessionKey: "beta-1", content: "wake up" });
		const response = await send("POST", "/api/cross-agent/wake", {
			harness: "pi",
			sessionKey: "beta-1",
			agentId: "beta",
			waitMs: 0,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { wake: boolean; messageIds: string[]; inject: string };
		expect(body.wake).toBe(true);
		expect(body.messageIds).toEqual([message.id]);
		expect(body.inject).toContain("> wake up");

		const again = await send("POST", "/api/cross-agent/wake", {
			harness: "pi",
			sessionKey: "beta-1",
			agentId: "beta",
			waitMs: 0,
		});
		expect(await again.json()).toEqual({ wake: false, reason: "timeout" });

		const released = await send("POST", "/api/cross-agent/wake/release", {
			sessionKey: "beta-1",
			agentId: "beta",
			messageIds: [message.id],
		});
		expect(await released.json()).toEqual({ released: 1 });
		const rewoken = await send("POST", "/api/cross-agent/wake", {
			harness: "pi",
			sessionKey: "beta-2",
			agentId: "beta",
			waitMs: 0,
		});
		expect(((await rewoken.json()) as { wake: boolean }).wake).toBe(false);
		const sameSession = await send("POST", "/api/cross-agent/wake", {
			harness: "pi",
			sessionKey: "beta-1",
			agentId: "beta",
			waitMs: 0,
		});
		expect(((await sameSession.json()) as { messageIds: string[] }).messageIds).toEqual([message.id]);
		expect((await send("POST", "/api/cross-agent/wake/release", { sessionKey: "beta-1" })).status).toBe(400);
	});
});

describe("message board routes", () => {
	it("creates, replies, lists, updates, and deletes through HTTP with operator-only deletion", async () => {
		const created = await send("POST", "/api/board/threads", {
			agentId: "alpha",
			sessionKey: "a1",
			harness: "claude-code",
			topic: "release",
			title: "Checklist",
			body: "What is left?",
			tags: "release, blocking",
		});
		expect(created.status).toBe(201);
		const { thread, post } = (await created.json()) as { thread: { id: string; tags: string[] }; post: { id: string } };
		expect(thread.tags).toEqual(["blocking", "release"]);

		const reply = await send("POST", `/api/board/threads/${thread.id}/posts`, {
			agentId: "alpha",
			sessionKey: "a2",
			body: "Docs.",
			replyToPostId: post.id,
		});
		expect(reply.status).toBe(201);

		const list = await send("GET", "/api/board/threads?agent_id=alpha&topic=release");
		expect(((await list.json()) as { total: number }).total).toBe(1);
		expect((await send("GET", "/api/board/threads?status=bogus")).status).toBe(400);

		const detail = await send("GET", `/api/board/threads/${thread.id}?scope=all`);
		expect(((await detail.json()) as { posts: unknown[] }).posts).toHaveLength(2);

		const forbidden = await send("PATCH", `/api/board/threads/${thread.id}`, { agentId: "beta", status: "resolved" });
		expect(forbidden.status).toBe(404);
		const resolved = await send("PATCH", `/api/board/threads/${thread.id}`, { agentId: "alpha", status: "resolved" });
		expect(((await resolved.json()) as { thread: { status: string } }).thread.status).toBe("resolved");

		expect((await send("DELETE", `/api/board/threads/${thread.id}?agent_id=alpha`)).status).toBe(403);
		const deleted = await send("DELETE", `/api/board/threads/${thread.id}?scope=all`);
		expect(await deleted.json()).toEqual({ threadId: thread.id, deletedPosts: 2 });
		expect((await send("GET", `/api/board/threads/${thread.id}?scope=all`)).status).toBe(404);
	});

	it("rejects invalid board input with 400", async () => {
		expect((await send("POST", "/api/board/threads", { topic: "Not Valid", title: "x", body: "y" })).status).toBe(400);
		expect((await send("POST", "/api/board/threads", { topic: "ok", title: "x", body: "y", tags: 4 })).status).toBe(
			400,
		);
		expect((await send("POST", "/api/board/threads", { topic: "ok", title: "x" })).status).toBe(400);
	});
});

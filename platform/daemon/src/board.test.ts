import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BoardViewer,
	BoardConflictError,
	BoardForbiddenError,
	BoardNotFoundError,
	BoardValidationError,
	claimBoardActivityNotices,
	createBoardEventVisibility,
	createBoardThread,
	deleteBoardThread,
	listBoardThreads,
	listBoardTopics,
	markBoardThreadRead,
	readBoardThread,
	replyToBoardThread,
	resetBoardStateForTest,
	subscribeBoardEvents,
	updateBoardThread,
} from "./board";
import { createAgentMessage, resetCrossAgentStateForTest } from "./cross-agent";
import { buildCrossAgentSessionSection } from "./cross-agent-session-section";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { readRecentEpisodicSources } from "./episodic-sources";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import { invalidateAgentScopeCache } from "./agent-id";

let tempDir = "";

const operator: BoardViewer = { kind: "operator" };

function agent(
	agentId: string,
	readPolicy: "isolated" | "shared" | "group" = "shared",
	policyGroup: string | null = null,
) {
	return { kind: "agent" as const, agentId, readPolicy, policyGroup };
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "signet-board-"));
	initDbAccessor(join(tempDir, "memory.db"), { agentsDir: tempDir });
});

afterEach(async () => {
	resetBoardStateForTest();
	resetCrossAgentStateForTest();
	invalidateAgentScopeCache();
	await closeDbAccessor();
	rmSync(tempDir, { recursive: true, force: true });
});

async function artifacts(): Promise<
	ReadonlyArray<{ agent_id: string; source_path: string; source_kind: string; content: string }>
> {
	return await dbOwnerQuery(
		ownerStatement(
			"SELECT agent_id, source_path, source_kind, content FROM memory_artifacts WHERE source_kind = 'board_post' ORDER BY source_path, agent_id",
			[],
			"all",
		),
		{ operation: "test.board-artifacts", lane: "read" },
	);
}

async function registerAgent(id: string, readPolicy: string, policyGroup: string | null = null): Promise<void> {
	await dbOwnerBatch(
		[
			ownerStatement(
				"INSERT OR REPLACE INTO agents (id, name, read_policy, policy_group, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
				[id, id, readPolicy, policyGroup],
			),
		],
		{ operation: "test.board-agent", lane: "write" },
	);
	invalidateAgentScopeCache(id);
}

describe("message board", () => {
	it("creates a thread in a new topic, replies, and lists it with tags and counts", async () => {
		const alpha = agent("alpha");
		const created = await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha", sessionKey: "a1", harness: "claude-code" },
			topic: "Signet-Release",
			title: "Release checklist",
			body: "What is left before 0.239?",
			tags: ["release", "#Blocking", "release"],
		});
		expect(created.thread.topic).toBe("signet-release");
		expect(created.thread.tags).toEqual(["blocking", "release"]);
		expect(created.thread.postCount).toBe(1);
		expect(created.projection).toBe("projected");

		const beta = agent("beta");
		const reply = await replyToBoardThread({
			viewer: beta,
			author: { agentId: "beta", sessionKey: "b1", harness: "hermes-agent" },
			threadId: created.thread.id,
			body: "Changelog and docs.",
			replyToPostId: created.post.id,
		});
		expect(reply.thread.postCount).toBe(2);
		expect(reply.post.replyToPostId).toBe(created.post.id);

		const page = await listBoardThreads(beta, { topic: "signet-release", tag: "blocking" });
		expect(page.total).toBe(1);
		expect(page.items[0]?.unread).toBe(true);
		const topics = await listBoardTopics(beta);
		expect(topics.map((topic) => [topic.slug, topic.threadCount])).toEqual([["signet-release", 1]]);

		const detail = await readBoardThread(created.thread.id, beta);
		expect(detail.posts.map((post) => post.body)).toEqual(["What is left before 0.239?", "Changelog and docs."]);
		await markBoardThreadRead(created.thread.id, beta);
		expect((await listBoardThreads(beta)).items[0]?.unread).toBe(false);
	});

	it("rejects invalid topics, tags, empty bodies, and cross-thread reply targets", async () => {
		const alpha = agent("alpha");
		const author = { agentId: "alpha" };
		await expect(
			createBoardThread({ viewer: alpha, author, topic: "Bad Topic!", title: "t", body: "b" }),
		).rejects.toThrow(BoardValidationError);
		await expect(
			createBoardThread({ viewer: alpha, author, topic: "ok", title: "t", body: "b", tags: ["no spaces"] }),
		).rejects.toThrow(BoardValidationError);
		await expect(createBoardThread({ viewer: alpha, author, topic: "ok", title: "t", body: "   " })).rejects.toThrow(
			BoardValidationError,
		);
		const first = await createBoardThread({ viewer: alpha, author, topic: "ok", title: "one", body: "b" });
		const second = await createBoardThread({ viewer: alpha, author, topic: "ok", title: "two", body: "b" });
		await expect(
			replyToBoardThread({
				viewer: alpha,
				author,
				threadId: second.thread.id,
				body: "x",
				replyToPostId: first.post.id,
			}),
		).rejects.toThrow(BoardValidationError);
	});

	it("applies agent read policy to thread visibility and writes", async () => {
		const isolated = agent("solo", "isolated");
		const shared = agent("team", "shared");
		const solo = await createBoardThread({
			viewer: isolated,
			author: { agentId: "solo" },
			topic: "private-work",
			title: "Solo notes",
			body: "mine",
		});
		const team = await createBoardThread({
			viewer: shared,
			author: { agentId: "team" },
			topic: "general",
			title: "Team notes",
			body: "ours",
		});

		expect((await listBoardThreads(isolated)).items.map((thread) => thread.id)).toEqual([solo.thread.id]);
		expect((await listBoardThreads(shared)).total).toBe(2);
		expect((await listBoardTopics(isolated)).map((topic) => topic.slug)).toEqual(["private-work"]);
		await expect(readBoardThread(team.thread.id, isolated)).rejects.toThrow(BoardNotFoundError);
		await expect(
			replyToBoardThread({ viewer: isolated, author: { agentId: "solo" }, threadId: team.thread.id, body: "hi" }),
		).rejects.toThrow(BoardNotFoundError);
		expect((await listBoardThreads(operator)).total).toBe(2);
	});

	it("limits group readers to threads by agents in their policy group", async () => {
		await registerAgent("g1", "group", "ops");
		await registerAgent("g2", "group", "ops");
		await registerAgent("outsider", "shared");
		const g2Thread = await createBoardThread({
			viewer: agent("g2", "group", "ops"),
			author: { agentId: "g2" },
			topic: "ops",
			title: "Group thread",
			body: "x",
		});
		await createBoardThread({
			viewer: agent("outsider"),
			author: { agentId: "outsider" },
			topic: "ops",
			title: "Outside thread",
			body: "y",
		});
		const page = await listBoardThreads(agent("g1", "group", "ops"));
		expect(page.items.map((thread) => thread.id)).toEqual([g2Thread.thread.id]);
	});

	it("lets only the author agent or the operator change thread state, and archived threads reject replies", async () => {
		const alpha = agent("alpha");
		const beta = agent("beta");
		const created = await createBoardThread({
			viewer: alpha,
			author: { agentId: "alpha" },
			topic: "t",
			title: "x",
			body: "y",
		});
		await expect(updateBoardThread({ viewer: beta, threadId: created.thread.id, status: "resolved" })).rejects.toThrow(
			BoardForbiddenError,
		);
		const resolved = await updateBoardThread({
			viewer: alpha,
			threadId: created.thread.id,
			status: "resolved",
			pinned: true,
			tags: ["done"],
		});
		expect(resolved.status).toBe("resolved");
		expect(resolved.pinned).toBe(true);
		expect(resolved.tags).toEqual(["done"]);
		await updateBoardThread({ viewer: operator, threadId: created.thread.id, status: "archived" });
		await expect(
			replyToBoardThread({ viewer: beta, author: { agentId: "beta" }, threadId: created.thread.id, body: "late" }),
		).rejects.toThrow(BoardConflictError);
		expect((await listBoardThreads(alpha)).total).toBe(0);
		expect((await listBoardThreads(alpha, { status: "archived" })).total).toBe(1);
	});

	it("promotes a visible direct message, attributing the first post to the original sender", async () => {
		const message = createAgentMessage({
			fromAgentId: "alpha",
			fromSessionKey: "a1",
			toAgentId: "beta",
			content: "Schema decision: keep receipts separate\nDetails follow.",
		});
		const promoted = await createBoardThread({
			viewer: agent("beta"),
			author: { agentId: "beta", sessionKey: "b1" },
			topic: "decisions",
			fromMessageId: message.id,
		});
		expect(promoted.thread.sourceMessageId).toBe(message.id);
		expect(promoted.thread.authorAgentId).toBe("beta");
		expect(promoted.thread.title).toBe("Schema decision: keep receipts separate");
		expect(promoted.post.authorAgentId).toBe("alpha");
		expect(promoted.post.authorSessionKey).toBe("a1");
		expect(promoted.post.body).toContain("Details follow.");

		await expect(
			createBoardThread({
				viewer: agent("gamma"),
				author: { agentId: "gamma" },
				topic: "decisions",
				fromMessageId: message.id,
			}),
		).rejects.toThrow(BoardNotFoundError);
	});

	it("projects each post as attributable Dreaming evidence for thread participants and purges it on delete", async () => {
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "research",
			title: "Embedding drift",
			body: "Seeing drift after the model swap.",
			tags: ["embeddings"],
		});
		await replyToBoardThread({
			viewer: agent("beta"),
			author: { agentId: "beta", sessionKey: "b1" },
			threadId: created.thread.id,
			body: "Re-embed in batches of 500.",
		});

		const rows = await artifacts();
		expect(rows.map((row) => [row.agent_id, row.source_path.endsWith(created.post.id)])).toEqual(
			expect.arrayContaining([
				["alpha", true],
				["alpha", false],
				["beta", false],
			]),
		);
		expect(rows).toHaveLength(3);
		const first = rows.find((row) => row.source_path.endsWith(created.post.id));
		expect(first?.content).toContain("Message board post in research: Embedding drift");
		expect(first?.content).toContain("alpha (session a1) via pi");
		expect(first?.content).toContain("Tags: embeddings");

		await expect(deleteBoardThread(created.thread.id, agent("alpha"))).rejects.toThrow(BoardForbiddenError);
		const deleted = await deleteBoardThread(created.thread.id, operator);
		expect(deleted.deletedPosts).toBe(2);
		expect(await artifacts()).toEqual([]);
		await expect(readBoardThread(created.thread.id, operator)).rejects.toThrow(BoardNotFoundError);
	});

	it("offers projected posts to Dreaming as episodic artifact evidence", async () => {
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1", harness: "pi" },
			topic: "decisions",
			title: "Keep receipts separate",
			body: "We decided to keep acknowledgement receipts in their own table.",
		});
		const sources = getDbAccessor().withReadDb((db) => readRecentEpisodicSources(db, "alpha", 10, ["artifact"]));
		expect(sources).toMatchObject([
			{
				kind: "artifact",
				sourceKind: "board_post",
				id: `signet-board://thread/${created.thread.id}/post/${created.post.id}`,
			},
		]);
		expect(sources[0]?.content).toContain("We decided to keep acknowledgement receipts in their own table.");
	});

	it("drains posts whose projection is still pending", async () => {
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			topic: "t",
			title: "x",
			body: "y",
		});
		await dbOwnerBatch(
			[
				ownerStatement("UPDATE board_posts SET projected_at = NULL"),
				ownerStatement("DELETE FROM memory_artifacts WHERE source_kind = 'board_post'"),
			],
			{ operation: "test.board-unproject", lane: "write" },
		);
		await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			threadId: created.thread.id,
			body: "z",
		});
		expect(await artifacts()).toHaveLength(2);
	});

	it("surfaces new replies by other sessions once, without waking", async () => {
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1" },
			topic: "coordination",
			title: "Who owns the migration?",
			body: "Need an owner.",
		});
		expect(await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" })).toEqual([]);

		await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a2" },
			threadId: created.thread.id,
			body: "I will take it.",
		});
		expect(await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a2" })).toEqual([]);
		const notices = await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ threadId: created.thread.id, topic: "coordination", newPosts: 1 });
		expect(await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" })).toEqual([]);
		expect(await claimBoardActivityNotices({ agentId: "outsider", sessionKey: "o1" })).toEqual([]);

		await markBoardThreadRead(created.thread.id, agent("alpha"));
		await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a2" },
			threadId: created.thread.id,
			body: "Done.",
		});
		expect((await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" }))[0]?.newPosts).toBe(1);
	});

	it("emits a board notice once when two hooks claim concurrently", async () => {
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1" },
			topic: "coordination",
			title: "Concurrent notices",
			body: "first",
		});
		await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a2" },
			threadId: created.thread.id,
			body: "reply",
		});
		const [first, second] = await Promise.all([
			claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" }),
			claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" }),
		]);
		expect(first.length + second.length).toBe(1);
	});

	it("notices a same-millisecond reply that lands after a notice scan", async () => {
		const at = Date.parse("2026-11-02T12:00:00.000Z");
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1" },
			topic: "coordination",
			title: "Cursor",
			body: "first",
			nowMs: at,
		});
		const reply = (body: string) =>
			replyToBoardThread({
				viewer: agent("alpha"),
				author: { agentId: "alpha", sessionKey: "a2" },
				threadId: created.thread.id,
				body,
				nowMs: at,
			});
		await reply("one");
		expect(await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" })).toHaveLength(1);
		await reply("two");
		expect((await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" }))[0]?.newPosts).toBe(1);
		expect(await claimBoardActivityNotices({ agentId: "alpha", sessionKey: "a1" })).toHaveLength(0);
	});

	it("keeps a same-millisecond reply unread after a complete-page read", async () => {
		const at = Date.parse("2026-11-02T12:00:00.000Z");
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			topic: "t",
			title: "x",
			body: "y",
			nowMs: at,
		});
		const page = await readBoardThread(created.thread.id, agent("beta"));
		expect(page.hasMorePosts).toBe(false);
		await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			threadId: created.thread.id,
			body: "late",
			nowMs: at,
		});
		const marked = await markBoardThreadRead(created.thread.id, agent("beta"), at + 5, {
			throughPostId: page.readThroughPostId,
		});
		expect(marked.lastReadPostId).toBe(page.readThroughPostId ?? null);
		expect((await readBoardThread(created.thread.id, agent("beta"))).thread.unread).toBe(true);
	});

	it("keeps read cursors monotonic and rejects foreign or malformed post ids", async () => {
		const first = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			topic: "t",
			title: "one",
			body: "a",
		});
		const reply = await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			threadId: first.thread.id,
			body: "b",
		});
		const other = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			topic: "t",
			title: "two",
			body: "c",
		});
		await markBoardThreadRead(first.thread.id, agent("beta"), Date.now(), { throughPostId: reply.post.id });
		const stale = await markBoardThreadRead(first.thread.id, agent("beta"), Date.now(), {
			throughPostId: first.post.id,
		});
		expect(stale.lastReadPostId).toBe(reply.post.id);
		await expect(
			markBoardThreadRead(first.thread.id, agent("beta"), Date.now(), { throughPostId: other.post.id }),
		).rejects.toThrow(BoardValidationError);
		await expect(
			markBoardThreadRead(first.thread.id, agent("beta"), Date.now(), { through: "not a date" }),
		).rejects.toThrow(BoardValidationError);
	});

	it("treats a legacy timestamp cursor conservatively for equal milliseconds", async () => {
		const at = Date.parse("2026-11-02T12:00:00.000Z");
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			topic: "t",
			title: "x",
			body: "y",
			nowMs: at,
		});
		await markBoardThreadRead(created.thread.id, agent("beta"), at, { through: "2026-11-02T12:00:00.000Z" });
		expect((await readBoardThread(created.thread.id, agent("beta"))).thread.unread).toBe(true);
	});

	it("refreshes group membership for live event visibility", async () => {
		await registerAgent("g1", "group", "ops");
		await registerAgent("g2", "group", "ops");
		let clock = 0;
		const visible = await createBoardEventVisibility(agent("g1", "group", "ops"), {
			refreshMs: 1_000,
			nowMs: () => clock,
		});
		expect(await visible("g2")).toBe(true);
		await registerAgent("g3", "group", "ops");
		clock = 5_000;
		expect(await visible("g3")).toBe(true);
		await registerAgent("g2", "group", "other");
		clock = 10_000;
		expect(await visible("g2")).toBe(false);
		expect(await visible("g1")).toBe(true);
	});

	it("returns the last post id of a partial first page and none for offset pages", async () => {
		const at = Date.parse("2026-11-02T12:00:00.000Z");
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1" },
			topic: "release",
			title: "Same millisecond",
			body: "first",
			nowMs: at,
		});
		const second = await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha", sessionKey: "a1" },
			threadId: created.thread.id,
			body: "second",
			nowMs: at,
		});
		const page = await readBoardThread(created.thread.id, agent("beta"), { postLimit: 1 });
		expect(page.hasMorePosts).toBe(true);
		expect(page.readThroughPostId).toBe(created.post.id);
		const full = await readBoardThread(created.thread.id, agent("beta"));
		expect(full.readThroughPostId).toBe(second.post.id);
		expect(
			(await readBoardThread(created.thread.id, agent("beta"), { postOffset: 1 })).readThroughPostId,
		).toBeUndefined();
	});

	it("falls back to self-only when a visibility refresh hangs", async () => {
		await registerAgent("g1", "group", "ops");
		await registerAgent("g2", "group", "ops");
		let clock = 0;
		const visible = await createBoardEventVisibility(agent("g1", "group", "ops"), {
			refreshMs: 1_000,
			refreshTimeoutMs: 0,
			nowMs: () => clock,
		});
		expect(await visible("g2")).toBe(true);
		clock = 5_000;
		expect(await visible("g2")).toBe(false);
		expect(await visible("g1")).toBe(true);
	});

	it("lists active board topics in the session-start messaging section", async () => {
		await createBoardThread({
			viewer: agent("default"),
			author: { agentId: "default", sessionKey: "other-session" },
			topic: "release-planning",
			title: "What ships next",
			body: "Collecting items.",
		});
		const section = await buildCrossAgentSessionSection({
			harness: "claude-code",
			agentId: "default",
			sessionKey: "solo",
		});
		expect(section).toContain("Active topics: release-planning.");
		expect(await buildCrossAgentSessionSection({ harness: "openclaw", agentId: "default" })).toBeNull();
	});

	it("emits board events for live observers", async () => {
		const events: string[] = [];
		const unsubscribe = subscribeBoardEvents((event) => events.push(event.action));
		const created = await createBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			topic: "t",
			title: "x",
			body: "y",
		});
		await replyToBoardThread({
			viewer: agent("alpha"),
			author: { agentId: "alpha" },
			threadId: created.thread.id,
			body: "z",
		});
		await updateBoardThread({ viewer: agent("alpha"), threadId: created.thread.id, status: "resolved" });
		await deleteBoardThread(created.thread.id, operator);
		unsubscribe();
		expect(events).toEqual(["thread_created", "post_created", "thread_updated", "thread_deleted"]);
	});
});

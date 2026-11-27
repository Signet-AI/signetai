import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createDbOwnerClient } from "./db-owner-client";
import { closeDbAccessor, getDbAccessor, initDbAccessor, prepareTypedStatement } from "./db-accessor";
import { deleteSessionTranscript, updateTranscriptLifecycle } from "./session-transcript-lifecycle";
import { upsertSessionTranscriptAsync } from "./session-transcripts";

let root = "";
let app: Hono;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "session-compaction-owner-"));
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(
		join(root, "agent.yaml"),
		"embedding:\n  provider: none\nsearch:\n  rehearsal_enabled: false\nmemory:\n  pipelineV2:\n    enabled: true\n",
	);
	process.env.SIGNET_PATH = root;
	initDbAccessor(join(root, "memory", "memories.db"));
	app = (await import("./daemon")).app;
});

afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
	await closeDbAccessor();
	rmSync(root, { recursive: true, force: true });
});

async function deleteCompletely(sessionKey: string): Promise<void> {
	await upsertSessionTranscriptAsync(
		sessionKey,
		"User: doomed turn",
		"claude-code",
		null,
		"default",
		"2020-01-01T00:00:00.000Z",
	);
	let result = await deleteSessionTranscript({ agentId: "default", sessionKey, hard: false, changedBy: "test" });
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({ agentId: "default", sessionKey, hard: false, changedBy: "test" });
	expect(result.status).toBe("complete");
}

function compact(body: Record<string, unknown>): Promise<Response> {
	return app.request("/api/hooks/compaction-complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ harness: "claude-code", agentId: "default", ...body }),
	});
}

async function stored(summary: string): Promise<{ memories: number; nodes: number }> {
	return getDbAccessor().withReadDbAsync((db) => ({
		memories:
			prepareTypedStatement<{ n: number }>(
				db,
				"SELECT COUNT(*) AS n FROM memories WHERE type = 'session_summary' AND content = ?",
			).get(summary)?.n ?? 0,
		nodes:
			prepareTypedStatement<{ n: number }>(
				db,
				"SELECT COUNT(*) AS n FROM session_summaries WHERE source_type = 'compaction' AND content = ?",
			).get(summary)?.n ?? 0,
	}));
}

describe("compaction summary admission follows the evidence timestamp", () => {
	it("rejects delayed and undated summaries after key reuse and accepts a fresh one", async () => {
		const key = "reuse-key";
		await deleteCompletely(key);
		expect((await compact({ sessionKey: key, summary: "blocked before reuse" })).status).toBe(200);
		expect(await stored("blocked before reuse")).toEqual({ memories: 0, nodes: 0 });
		await updateTranscriptLifecycle({ agentId: "default", sessionKey: key, action: "start" });

		const delayed = await compact({
			sessionKey: key,
			summary: "delayed old summary",
			capturedAt: "2020-01-01T00:00:01.000Z",
		});
		expect(delayed.status).toBe(200);
		expect(await delayed.json()).toMatchObject({ bypassed: true });
		expect(await stored("delayed old summary")).toEqual({ memories: 0, nodes: 0 });

		const undated = await compact({ sessionKey: key, summary: "undated old summary" });
		expect(undated.status).toBe(200);
		expect(await undated.json()).toMatchObject({ bypassed: true });
		expect(await stored("undated old summary")).toEqual({ memories: 0, nodes: 0 });

		const fresh = await compact({
			sessionKey: key,
			summary: "fresh new summary",
			capturedAt: new Date().toISOString(),
		});
		expect(fresh.status).toBe(200);
		expect(await fresh.json()).toMatchObject({ success: true, memoryId: expect.any(String) });
		expect(await stored("fresh new summary")).toEqual({ memories: 1, nodes: 1 });
	});

	it("keeps accepting undated summaries for keys that were never deleted", async () => {
		const res = await compact({ sessionKey: "never-deleted", summary: "ordinary summary" });
		expect(res.status).toBe(200);
		expect(await stored("ordinary summary")).toEqual({ memories: 1, nodes: 1 });
	});

	it.each(["not-a-date", 123, null, ""])("rejects malformed capturedAt %p", async (capturedAt: unknown) => {
		const res = await compact({ sessionKey: "bad-date", summary: "bad date summary", capturedAt });
		expect(res.status).toBe(400);
		expect(await stored("bad date summary")).toEqual({ memories: 0, nodes: 0 });
	});
});

describe("compaction summary commits through the database owner process", () => {
	it("writes memory, node and thread head together, and refuses a deleted key", async () => {
		const ownerRoot = mkdtempSync(join(tmpdir(), "session-compaction-process-"));
		mkdirSync(join(ownerRoot, "memory"));
		const owner = createDbOwnerClient({ dbPath: join(ownerRoot, "memory", "memories.db") });
		const commit = (sessionKey: string, summaryId: string, capturedAt?: string): Promise<boolean> =>
			owner.submit<boolean>(
				{
					kind: "session_compaction_summary",
					input: {
						author: { userId: null, credential: "system" },
						agentId: "agent-a",
						sessionKey,
						harness: "claude-code",
						project: null,
						summary: `owner summary ${summaryId}`,
						summaryId,
						now: new Date().toISOString(),
						capturedAt,
					},
				},
				{ operation: "test.compaction", lane: "write", deadlineMs: 5000 },
			).result;
		const count = (sql: string): Promise<{ n: number }> =>
			owner.submit<{ n: number }>(
				{ kind: "query", statement: { sql, result: "get", readonly: true } },
				{ operation: "test.count", lane: "read", deadlineMs: 5000 },
			).result;
		try {
			await owner.start();
			await owner.initialize(ownerRoot);
			expect(await commit("owner-key", "m1")).toBe(true);
			expect(await count("SELECT COUNT(*) AS n FROM memories WHERE id = 'm1'")).toEqual({ n: 1 });
			expect(await count("SELECT COUNT(*) AS n FROM session_summaries WHERE content = 'owner summary m1'")).toEqual({
				n: 1,
			});
			expect(await count("SELECT COUNT(*) AS n FROM memory_thread_heads WHERE agent_id = 'agent-a'")).toEqual({ n: 1 });

			await owner.submit(
				{
					kind: "session_transcript_write",
					input: {
						agentId: "agent-a",
						sessionKey: "owner-deleted",
						harness: "claude-code",
						project: null,
						transcript: "User: doomed",
					},
				},
				{ operation: "test.seed", lane: "write", deadlineMs: 5000 },
			).result;
			const input = {
				basePath: ownerRoot,
				agentId: "agent-a",
				sessionKey: "owner-deleted",
				hard: false,
				changedBy: "test",
			};
			for (let i = 0; i < 20; i++) {
				const result = await owner.submit<{ status: string }>(
					{ kind: "session_transcript_delete", input },
					{ operation: "test.delete", lane: "write", deadlineMs: 5000 },
				).result;
				if (result.status === "complete") break;
			}
			await owner.submit(
				{
					kind: "session_transcript_lifecycle",
					input: { agentId: "agent-a", sessionKey: "owner-deleted", action: "start" },
				},
				{ operation: "test.start", lane: "write", deadlineMs: 5000 },
			).result;
			expect(await commit("owner-deleted", "m2", "2020-01-01T00:00:01.000Z")).toBe(false);
			expect(await commit("owner-deleted", "m3")).toBe(false);
			expect(await commit("owner-deleted", "m4", new Date().toISOString())).toBe(true);
			expect(await count("SELECT COUNT(*) AS n FROM memories WHERE id IN ('m2','m3')")).toEqual({ n: 0 });
		} finally {
			await owner.close();
			rmSync(ownerRoot, { recursive: true, force: true });
		}
	}, 30000);
});

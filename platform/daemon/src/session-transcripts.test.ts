import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbAccessor, type WriteDb, closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	appendSessionTranscriptAsync,
	getStoredSessionTranscriptInfoAsync,
	searchTranscriptFallback,
	upsertSessionTranscript,
	upsertSessionTranscriptAsync,
} from "./session-transcripts";

let dir = "";

describe("session transcript lookup", () => {
	afterEach(async () => {
		await closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function init(): void {
		dir = mkdtempSync(join(tmpdir(), "signet-session-transcripts-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	}

	it("exact query with colon alias returns hyphen stored session key", () => {
		init();
		upsertSessionTranscript(
			"019f3a7a-218f-7000-b6a3-0dcc8801a625",
			"User: asked about mesh PR 9147 and 9146. Assistant: gave answer.",
			"oh-my-pi",
			"/repo-a",
			"noam",
		);

		const hits = searchTranscriptFallback({
			query: "019f3a7a-218f:7000:b6a3-0dcc8801a625",
			agentId: "noam",
			limit: 5,
		});

		expect(hits).toHaveLength(1);
		expect(hits[0]?.sessionKey).toBe("019f3a7a-218f-7000-b6a3-0dcc8801a625");
	});

	it("exact query returns row when params sessionKey equals query", () => {
		init();
		upsertSessionTranscript(
			"same-session",
			"User: exact same session lookup should return stored content. Assistant: yes.",
			"oh-my-pi",
			"/repo-a",
			"noam",
		);

		const hits = searchTranscriptFallback({
			query: "same-session",
			agentId: "noam",
			sessionKey: "same-session",
			limit: 5,
		});

		expect(hits).toHaveLength(1);
		expect(hits[0]?.sessionKey).toBe("same-session");
	});
});

describe("session transcript live append", () => {
	afterEach(async () => {
		await closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function init(): DbAccessor {
		dir = mkdtempSync(join(tmpdir(), "signet-session-transcripts-append-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		return getDbAccessor();
	}

	it("appends to the stored row inside one write transaction", async () => {
		const accessor = init();
		await upsertSessionTranscriptAsync("live-session", "User: first", "claude-code", "/repo", "agent-a");

		await appendSessionTranscriptAsync({
			sessionKey: "live-session",
			agentId: "agent-a",
			harness: "claude-code",
			project: "/repo",
			append: (existing) => `${existing}\nAssistant: second`,
		});

		const stored = await getStoredSessionTranscriptInfoAsync("live-session", "agent-a", accessor);
		expect(stored).toMatchObject({
			content: "User: first\nAssistant: second",
			project: "/repo",
			harness: "claude-code",
		});
	});

	it("fails the append without overwriting the row when the in-transaction read fails", async () => {
		const accessor = init();
		await upsertSessionTranscriptAsync("live-session", "User: first", "claude-code", "/repo", "agent-a");
		const failingRead: DbAccessor = {
			...accessor,
			withWriteTxAsync: (fn, options) =>
				accessor.withWriteTxAsync(
					(db) =>
						fn(
							new Proxy(db, {
								get(target, property, receiver) {
									if (property !== "prepare") return Reflect.get(target, property, receiver);
									return (sql: string) => {
										if (sql.includes("SELECT session_key, agent_id, content")) throw new Error("forced read failure");
										return target.prepare(sql);
									};
								},
							}) as WriteDb,
						),
					options,
				),
		};

		await expect(
			appendSessionTranscriptAsync(
				{
					sessionKey: "live-session",
					agentId: "agent-a",
					harness: "claude-code",
					project: "/repo",
					append: (existing) => `${existing ?? ""}\nAssistant: second`.trim(),
				},
				failingRead,
			),
		).rejects.toThrow("forced read failure");

		const stored = await getStoredSessionTranscriptInfoAsync("live-session", "agent-a", accessor);
		expect(stored?.content).toBe("User: first");
	});
});

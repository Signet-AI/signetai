import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DbAccessor, closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	appendSessionTranscriptAsync,
	ensureCanonicalTranscriptHistory,
	getStoredSessionTranscriptInfoAsync,
	searchTranscriptFallback,
	upsertSessionTranscript,
	upsertSessionTranscriptAsync,
} from "./session-transcripts";
import { canonicalTranscriptPath } from "./transcript-jsonl";

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

describe("canonical transcript backfill of legacy records", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await closeDbAccessor();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	const collapsedLegacyTurns = [
		{ role: "user", content: "legacy prompt" },
		{ role: "unknown", content: "with a second line" },
		{ role: "assistant", content: "reply with spaces" },
	];
	const originalLegacyTranscript = "User:  legacy   prompt\n  with  a second line\n\nAssistant: reply\twith  spaces  ";

	function makeRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "signet-session-transcripts-backfill-"));
		roots.push(root);
		return root;
	}

	function markerExists(root: string): boolean {
		return existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"));
	}

	function readJsonlLines(root: string): ReadonlyArray<string> {
		return readFileSync(canonicalTranscriptPath(root, "codex"), "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0);
	}

	function writeCollapsedLegacyRecords(
		root: string,
		sessionKey: string,
		turns: ReadonlyArray<{ readonly role: string; readonly content: string }>,
	): void {
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		mkdirSync(dirname(jsonlPath), { recursive: true });
		const lines = turns.map((turn, index) =>
			JSON.stringify({
				schema: "signet.transcript.v1",
				id: `legacy-${index + 1}`,
				captured_at: "2026-04-28T00:00:00.000Z",
				agent_id: "default",
				harness: "codex",
				session_key: sessionKey,
				session_id: sessionKey,
				project: null,
				seq: index + 1,
				role: turn.role,
				content: turn.content,
				source_format: "markdown",
				source_sha256: "legacy",
			}),
		);
		writeFileSync(jsonlPath, `${lines.join("\n")}\n`, "utf8");
	}

	function writeTranscriptArtifact(root: string, sessionKey: string, transcript: string): void {
		const artifact = join(root, "memory", `2026-04-28T00-00-00Z--${sessionKey}--transcript.md`);
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				`session_key: ${JSON.stringify(sessionKey)}`,
				`session_id: ${JSON.stringify(sessionKey)}`,
				'captured_at: "2026-04-28T00:00:00.000Z"',
				"---",
				transcript,
				"",
			].join("\n"),
			"utf8",
		);
	}

	async function insertTranscriptRow(root: string, sessionKey: string, content: string): Promise<void> {
		initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
		await getDbAccessor().withWriteTxAsync((db) => {
			db.exec(
				`CREATE TABLE IF NOT EXISTS session_transcripts (
					session_key TEXT NOT NULL,
					content TEXT NOT NULL,
					harness TEXT,
					project TEXT,
					agent_id TEXT,
					created_at TEXT,
					updated_at TEXT
				)`,
			);
			db.prepare(
				`INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(sessionKey, content, "codex", null, "default", "2026-04-28", "2026-04-28");
		});
	}

	it("settles the marker when legacy records match the Markdown they were written from", async () => {
		const root = makeRoot();
		writeCollapsedLegacyRecords(root, "legacy-session", collapsedLegacyTurns);
		writeTranscriptArtifact(root, "legacy-session", originalLegacyTranscript);

		await ensureCanonicalTranscriptHistory(root, "default");

		expect(readJsonlLines(root)).toHaveLength(3);
		expect(markerExists(root)).toBe(true);
	});

	it("settles the marker when legacy records match the DB row they were written from", async () => {
		const root = makeRoot();
		writeCollapsedLegacyRecords(root, "legacy-db-session", collapsedLegacyTurns);
		await insertTranscriptRow(root, "legacy-db-session", originalLegacyTranscript);

		await ensureCanonicalTranscriptHistory(root, "default");

		expect(readJsonlLines(root)).toHaveLength(3);
		expect(markerExists(root)).toBe(true);
	});

	it("withholds the marker when legacy records and Markdown differ by a word", async () => {
		const root = makeRoot();
		writeCollapsedLegacyRecords(root, "legacy-session", collapsedLegacyTurns);
		writeTranscriptArtifact(root, "legacy-session", originalLegacyTranscript.replace("spaces", "tabs"));

		await ensureCanonicalTranscriptHistory(root, "default");

		expect(markerExists(root)).toBe(false);
	});

	it("withholds the marker when a DB row is a whitespace-poorer copy of a current-format record", async () => {
		const root = makeRoot();
		writeTranscriptArtifact(root, "fresh-session", "User:  fresh   prompt\nAssistant: fresh\treply  ");
		await insertTranscriptRow(root, "fresh-session", "User: fresh prompt\nAssistant: fresh reply");

		await ensureCanonicalTranscriptHistory(root, "default");

		expect(readJsonlLines(root)).toHaveLength(2);
		expect(markerExists(root)).toBe(false);
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
			transcript: "Assistant: second",
		});

		const stored = await getStoredSessionTranscriptInfoAsync("live-session", "agent-a", accessor);
		expect(stored).toMatchObject({
			content: "User: first\nAssistant: second",
			project: "/repo",
			harness: "claude-code",
		});
	});

	it("writes upserts and concurrent appends through the database owner without a local write", async () => {
		const accessor = init();
		const { dbOwnerQuery, getDbOwner, ownerStatement } = await import("./db-owner-runtime");
		await dbOwnerQuery(ownerStatement("SELECT 1", [], "get"), { operation: "test.transcript.owner.ready" });
		const owner = await getDbOwner();
		expect(owner.health().pid).toBeGreaterThan(0);
		expect(owner.health().pid).not.toBe(process.pid);
		const local = spyOn(accessor, "withWriteTxAsync").mockImplementation(() => {
			throw new Error("request-thread transcript write");
		});
		try {
			expect(
				await upsertSessionTranscriptAsync("owner-session", "User: first", "claude-code", "/repo", "agent-a"),
			).toBe(true);
			const replies = Array.from({ length: 8 }, (_, i) => `Assistant: concurrent ${i}`);
			const append = (transcript: string) =>
				appendSessionTranscriptAsync({
					sessionKey: "owner-session",
					agentId: "agent-a",
					harness: "claude-code",
					project: null,
					transcript,
				});
			await Promise.all(replies.map(append));
			await append("Assistant: retried");
			await append("Assistant: retried");
			await append("User: again");
			await append("Assistant: retried");
			const row = await dbOwnerQuery<{ content: string; project: string; agent_id: string }>(
				ownerStatement(
					"SELECT content, project, agent_id FROM session_transcripts WHERE session_key = ? AND agent_id = ?",
					["owner-session", "agent-a"],
					"get",
				),
				{ operation: "test.transcript.owner.readback" },
			);
			expect(row.agent_id).toBe("agent-a");
			expect(row.project).toBe("/repo");
			expect(row.content.split("\n").sort()).toEqual(
				["User: first", ...replies, "Assistant: retried", "User: again", "Assistant: retried"].sort(),
			);
			expect(local).not.toHaveBeenCalled();
		} finally {
			local.mockRestore();
		}
	});

	it("fails the append without overwriting the row when the in-transaction read fails", async () => {
		const accessor = init();
		await upsertSessionTranscriptAsync("live-session", "User: first", "claude-code", "/repo", "agent-a");
		const { dbOwnerQuery, ownerStatement } = await import("./db-owner-runtime");
		const rename = (from: string, to: string) =>
			dbOwnerQuery(ownerStatement(`ALTER TABLE session_transcripts RENAME COLUMN ${from} TO ${to}`, [], "run"), {
				operation: "test.transcript.owner.rename",
				lane: "write",
			});
		await rename("content", "unavailable_content");
		try {
			await expect(
				appendSessionTranscriptAsync({
					sessionKey: "live-session",
					agentId: "agent-a",
					harness: "claude-code",
					project: "/repo",
					transcript: "Assistant: second",
				}),
			).rejects.toThrow("no such column: content");
		} finally {
			await rename("unavailable_content", "content");
		}

		const stored = await getStoredSessionTranscriptInfoAsync("live-session", "agent-a", accessor);
		expect(stored?.content).toBe("User: first");
	});

	it("keeps the stored project when an append has no project", async () => {
		const accessor = init();
		await upsertSessionTranscriptAsync("live-session", "User: first", "claude-code", "/repo", "agent-a");

		await appendSessionTranscriptAsync({
			sessionKey: "live-session",
			agentId: "agent-a",
			harness: "claude-code",
			project: null,
			transcript: "Assistant: second",
		});

		const stored = await getStoredSessionTranscriptInfoAsync("live-session", "agent-a", accessor);
		expect(stored).toMatchObject({ content: "User: first\nAssistant: second", project: "/repo" });
	});

	it("appends to the exact session key without copying a row stored under an alias", async () => {
		const accessor = init();
		const hyphenKey = "019f3a7a-218f-7000-b6a3-0dcc8801a625";
		const colonKey = "019f3a7a-218f:7000:b6a3-0dcc8801a625";
		await upsertSessionTranscriptAsync(hyphenKey, "User: first", "oh-my-pi", "/repo", "agent-a");

		await appendSessionTranscriptAsync({
			sessionKey: colonKey,
			agentId: "agent-a",
			harness: "oh-my-pi",
			project: "/repo",
			transcript: "Assistant: second",
		});

		const rows = await accessor.withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT session_key, content FROM session_transcripts WHERE agent_id = ? ORDER BY session_key")
					.all("agent-a") as Array<{ session_key: string; content: string }>,
		);
		expect(rows).toEqual([
			{ session_key: hyphenKey, content: "User: first" },
			{ session_key: colonKey, content: "Assistant: second" },
		]);
	});
});

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DbAccessor, closeDbAccessor, getDbAccessor, initDbAccessor, prepareTypedStatement } from "./db-accessor";
import {
	appendSessionTranscriptAsync,
	backfillTranscriptTurnsFtsChunkInDb,
	ensureCanonicalTranscriptHistory,
	getStoredSessionTranscriptInfoAsync,
	upsertSessionTranscript,
	upsertSessionTranscriptAsync,
} from "./session-transcripts";
import { searchSessionTranscripts } from "./subagent-context";
import { canonicalTranscriptPath } from "./transcript-jsonl";

let dir = "";

describe("session transcript turn index", () => {
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

	async function indexedTurns(sessionKey: string): Promise<string[]> {
		return (await turnRows(sessionKey)).map((row) => row.text);
	}

	async function turnRows(
		sessionKey: string,
	): Promise<Array<{ id: number; seq: number; byte_offset: number; text: string }>> {
		return await getDbAccessor().withReadDbAsync((db) =>
			prepareTypedStatement<{ id: number; seq: number; byte_offset: number; text: string }>(
				db,
				"SELECT id, seq, byte_offset, text FROM session_transcript_turns WHERE session_key = ? AND agent_id = ? ORDER BY seq",
			).all(sessionKey, "noam"),
		);
	}

	async function indexedMatches(term: string): Promise<number> {
		const row = await getDbAccessor().withReadDbAsync((db) =>
			prepareTypedStatement<{ count: number }>(
				db,
				"SELECT COUNT(*) AS count FROM session_transcript_turns_fts WHERE session_transcript_turns_fts MATCH ?",
			).get(term),
		);
		return row?.count ?? 0;
	}

	async function searchHits(
		query: string,
		scope: { project?: string; currentSessionKey?: string } = {},
	): Promise<Array<{ sessionKey: string; rank: number }>> {
		return await getDbAccessor().withReadDbAsync((db) =>
			searchSessionTranscripts({ db, query, agentId: "noam", limit: 10, ...scope }),
		);
	}

	async function search(
		query: string,
		scope: { project?: string; currentSessionKey?: string } = {},
	): Promise<string[]> {
		return (await searchHits(query, scope)).map((hit) => hit.sessionKey).sort();
	}

	async function backfillChunk(maxRows?: number): Promise<{ complete: boolean; indexed: number }> {
		return await getDbAccessor().withWriteTxAsync((db) =>
			backfillTranscriptTurnsFtsChunkInDb(db, maxRows === undefined ? {} : { maxRows }),
		);
	}

	async function resetTurnIndex(): Promise<void> {
		await write("DELETE FROM session_transcript_turns");
		await write(
			"UPDATE session_transcript_turns_backfill SET cursor = NULL, end_rowid = (SELECT MAX(rowid) FROM session_transcripts)",
		);
	}

	async function insertAt(rowid: "-9223372036854775808" | "1", sessionKey: string, content: string): Promise<void> {
		await write(
			`INSERT INTO session_transcripts (rowid, session_key, content, harness, project, agent_id, created_at, updated_at) VALUES (${rowid}, ?, ?, 'codex', '/repo', 'noam', ?, ?)`,
			sessionKey,
			content,
			"2026-11-25T10:00:00.000Z",
			"2026-11-25T10:00:00.000Z",
		);
	}

	async function write(sql: string, ...params: Array<string | number>): Promise<void> {
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(sql).run(...params);
		});
	}

	async function append(sessionKey: string, transcript: string): Promise<void> {
		await appendSessionTranscriptAsync({ sessionKey, agentId: "noam", harness: "codex", project: "/repo", transcript });
	}

	it("indexes only the new text when a live turn is appended", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");

		expect(await indexedTurns("sess-a")).toEqual(["User: alpha question", "\nAssistant: bravo answer"]);
	});

	it("keeps the indexed turns when only the row metadata changes", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");
		await write(
			"UPDATE session_transcripts SET completed_at = ? WHERE session_key = ?",
			"2026-11-25T10:00:00.000Z",
			"sess-a",
		);

		expect(await indexedTurns("sess-a")).toEqual(["User: alpha question", "\nAssistant: bravo answer"]);
	});

	it("reindexes the whole session when its content is rewritten", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");
		upsertSessionTranscript("sess-a", "User: charlie rewrite", "codex", "/repo", "noam");

		expect(await indexedTurns("sess-a")).toEqual(["User: charlie rewrite"]);
		expect(await indexedMatches("alpha")).toBe(0);
		expect(await search("charlie")).toEqual(["sess-a"]);
	});

	it("drops the indexed turns of a deleted transcript row", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");
		upsertSessionTranscript("sess-b", "User: alpha other", "codex", "/repo", "noam");
		await write("DELETE FROM session_transcripts WHERE agent_id = ?", "noam");
		upsertSessionTranscript("sess-c", "User: delta fresh", "codex", "/repo", "noam");

		expect(await indexedTurns("sess-c")).toEqual(["User: delta fresh"]);
		expect(await indexedMatches("alpha OR bravo")).toBe(0);
		expect(await indexedMatches("delta")).toBe(1);
	});

	it("matches a session when the query terms sit in different turns", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");
		expect(await indexedTurns("sess-a")).toEqual(["User: alpha question", "\nAssistant: bravo answer"]);
		upsertSessionTranscript("sess-b", "User: alpha only", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-c", "User: bravo only", "codex", "/repo", "noam");

		expect(await search("alpha bravo")).toEqual(["sess-a"]);
		expect(await search("alpha")).toEqual(["sess-a", "sess-b"]);
	});

	it("searches with LIKE until the backfill indexes rows written before the index", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: charlie legacy", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-b", "User: charlie second", "codex", "/repo", "noam");
		await resetTurnIndex();
		await append("sess-b", "Assistant: echo reply");

		expect((await searchHits("charlie")).map((hit) => hit.rank)).toEqual([1, 1]);
		expect(await indexedTurns("sess-b")).toEqual(["User: charlie second\nAssistant: echo reply"]);

		expect((await backfillChunk(1)).complete).toBe(false);
		expect((await backfillChunk(1)).complete).toBe(true);

		expect(await indexedTurns("sess-a")).toEqual(["User: charlie legacy"]);
		expect(await indexedTurns("sess-b")).toEqual(["User: charlie second\nAssistant: echo reply"]);
		const hits = await searchHits("charlie");
		expect(hits.map((hit) => hit.sessionKey).sort()).toEqual(["sess-a", "sess-b"]);
		expect(hits.every((hit) => hit.rank < 0)).toBe(true);
	});

	it("indexes transcripts from the minimum rowid one row per chunk when the backfill has not started", async () => {
		init();
		await insertAt("-9223372036854775808", "sess-a", "User: kilo boundary");
		await insertAt("1", "sess-b", "User: lima second");
		await resetTurnIndex();

		expect(await backfillChunk(1)).toEqual({ complete: false, indexed: 1 });
		expect(await backfillChunk(1)).toEqual({ complete: true, indexed: 1 });
		expect(await turnRows("sess-a")).toEqual([
			expect.objectContaining({ seq: 1, byte_offset: 0, text: "User: kilo boundary" }),
		]);
		expect(await indexedTurns("sess-b")).toEqual(["User: lima second"]);
	});

	it("never returns another agent's session and honors the project and current-session scope", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: foxtrot plan", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-b", "User: foxtrot other", "codex", "/other", "noam");
		upsertSessionTranscript("sess-x", "User: foxtrot plan", "codex", "/repo", "intruder");
		upsertSessionTranscript("sess-a", "User: foxtrot secretword", "codex", "/repo", "intruder");

		expect(await search("secretword")).toEqual([]);
		expect((await searchHits("foxtrot secretword")).filter((hit) => hit.rank < 0)).toEqual([]);
		expect(await search("foxtrot plan")).toEqual(["sess-a"]);
		expect(await search("foxtrot")).toEqual(["sess-a", "sess-b"]);
		expect(await search("foxtrot", { project: "/other" })).toEqual(["sess-b"]);
		expect(await search("foxtrot", { currentSessionKey: "sess-a" })).toEqual(["sess-b"]);
		await write("DELETE FROM session_transcripts WHERE agent_id = ?", "intruder");
		expect(await indexedMatches("foxtrot")).toBe(2);
	});

	it("replaces the indexed turns when a row is replaced or moves to another session key", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: quartz original", "codex", "/repo", "noam");
		await write(
			"INSERT OR REPLACE INTO session_transcripts (session_key, content, harness, project, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			"sess-a",
			"User: romeo replaced",
			"codex",
			"/repo",
			"noam",
			"2026-11-25T10:00:00.000Z",
			"2026-11-25T10:00:00.000Z",
		);
		expect(await indexedTurns("sess-a")).toEqual(["User: romeo replaced"]);

		await write("UPDATE session_transcripts SET session_key = ? WHERE session_key = ?", "sess-b", "sess-a");
		expect(await indexedTurns("sess-a")).toEqual([]);
		expect(await indexedTurns("sess-b")).toEqual(["User: romeo replaced"]);
		expect(await search("romeo")).toEqual(["sess-b"]);
	});

	it("keeps the indexed turns when the same content is stored again", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: sierra question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: tango answer");
		const stored = "User: sierra question\nAssistant: tango answer";
		upsertSessionTranscript("sess-a", stored, "codex", "/repo", "noam");

		expect(await indexedTurns("sess-a")).toEqual(["User: sierra question", "\nAssistant: tango answer"]);
	});

	it("splits on whitespace at the end of the old text and reindexes a word continued with a multibyte letter", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: uniform ", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-a", "User: uniform victor", "codex", "/repo", "noam");
		expect(await indexedTurns("sess-a")).toEqual(["User: uniform ", "victor"]);

		upsertSessionTranscript("sess-a", "User: uniform victoré", "codex", "/repo", "noam");
		expect(await indexedTurns("sess-a")).toEqual(["User: uniform ", "victoré"]);
	});

	it("reindexes the whole session when the old content was empty", async () => {
		init();
		await write(
			"INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			"sess-a",
			"",
			"codex",
			"/repo",
			"noam",
			"2026-11-25T10:00:00.000Z",
			"2026-11-25T10:00:00.000Z",
		);
		expect(await indexedTurns("sess-a")).toEqual([""]);
		upsertSessionTranscript("sess-a", "whiskey first", "codex", "/repo", "noam");

		expect(await indexedTurns("sess-a")).toEqual(["whiskey first"]);
	});

	it("returns the stored session for an exact session key, including its colon alias", async () => {
		init();
		const key = "019f3a7a-218f-7000-b6a3-0dcc8801a625";
		upsertSessionTranscript(key, "User: asked about mesh PR 9147. Assistant: answer.", "oh-my-pi", "/repo-a", "noam");

		expect(await searchHits("019f3a7a-218f:7000:b6a3-0dcc8801a625")).toMatchObject([{ sessionKey: key, rank: 0 }]);
		expect(await searchHits(key)).toMatchObject([{ sessionKey: key, rank: 0 }]);
	});

	it("matches any word when the query has more than three words", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: golf only", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-b", "User: hotel only", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-c", "User: unrelated", "codex", "/repo", "noam");

		expect(await search("golf hotel india juliet")).toEqual(["sess-a", "sess-b"]);
		expect((await searchHits("golf hotel india juliet")).every((hit) => hit.rank < 0)).toBe(true);
	});

	it("keeps turns attached to their session when transcript rowids change", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: kilo question", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-b", "User: lima question", "codex", "/repo", "noam");
		await write("UPDATE session_transcripts SET rowid = rowid + 1000");
		await write("UPDATE session_transcripts SET rowid = 1 WHERE session_key = ?", "sess-b");

		expect(await search("kilo")).toEqual(["sess-a"]);
		expect(await search("lima")).toEqual(["sess-b"]);
		await append("sess-b", "Assistant: mike reply");
		expect(await indexedTurns("sess-b")).toEqual(["User: lima question", "\nAssistant: mike reply"]);
	});

	it("indexes a session that moved below the backfill cursor before reporting completion", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: november first", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-b", "User: november second", "codex", "/repo", "noam");
		await resetTurnIndex();

		expect(await backfillChunk(1)).toEqual({ complete: false, indexed: 1 });
		await write("UPDATE session_transcripts SET rowid = -5 WHERE session_key = ?", "sess-b");
		expect(await backfillChunk(1)).toEqual({ complete: false, indexed: 0 });
		expect(await backfillChunk(1)).toEqual({ complete: false, indexed: 1 });
		expect(await backfillChunk(1)).toEqual({ complete: true, indexed: 0 });
		expect(await indexedTurns("sess-b")).toEqual(["User: november second"]);
	});

	it("stops a backfill chunk at the byte budget and finishes on the next chunk", async () => {
		init();
		const large = `User: oscar ${"x".repeat(5 * 1024 * 1024)}`;
		upsertSessionTranscript("sess-a", large, "codex", "/repo", "noam");
		upsertSessionTranscript("sess-b", large, "codex", "/repo", "noam");
		await resetTurnIndex();

		expect(await backfillChunk()).toEqual({ complete: false, indexed: 1 });
		expect(await backfillChunk()).toEqual({ complete: true, indexed: 1 });
	});

	it("reindexes from the last turn when new text continues its last word", async () => {
		init();
		upsertSessionTranscript("sess-a", "Assistant: deploy the kuber", "codex", "/repo", "noam");
		upsertSessionTranscript("sess-a", "Assistant: deploy the kubernetes cluster", "codex", "/repo", "noam");
		expect(await indexedTurns("sess-a")).toEqual(["Assistant: deploy the kubernetes cluster"]);

		upsertSessionTranscript("sess-b", "User: alpha", "codex", "/repo", "noam");
		await append("sess-b", "Assistant: deploy the kuber");
		const [first] = await turnRows("sess-b");
		upsertSessionTranscript("sess-b", "User: alpha\nAssistant: deploy the kubernetes", "codex", "/repo", "noam");

		expect(await turnRows("sess-b")).toEqual([
			{ id: first?.id, seq: 1, byte_offset: 0, text: "User: alpha" },
			expect.objectContaining({ seq: 2, byte_offset: 11, text: "\nAssistant: deploy the kubernetes" }),
		]);
		expect(await indexedMatches("kubernetes")).toBe(2);
		expect(await indexedMatches("kuber")).toBe(0);
	});

	it("reindexes only from the first changed turn when a later turn is rewritten", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");
		await append("sess-a", "User: charlie next");
		const [first] = await turnRows("sess-a");
		upsertSessionTranscript(
			"sess-a",
			"User: alpha question\nAssistant: delta answer\nUser: charlie next",
			"codex",
			"/repo",
			"noam",
		);

		expect(await turnRows("sess-a")).toEqual([
			{ id: first?.id, seq: 1, byte_offset: 0, text: "User: alpha question" },
			expect.objectContaining({ seq: 2, byte_offset: 20, text: "\nAssistant: delta answer\nUser: charlie next" }),
		]);
		expect(await indexedMatches("bravo")).toBe(0);
		expect(await search("delta charlie")).toEqual(["sess-a"]);
	});

	it("drops the trailing turns when the content shrinks to a turn boundary", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");
		await append("sess-a", "Assistant: bravo answer");
		upsertSessionTranscript("sess-a", "User: alpha question", "codex", "/repo", "noam");

		expect(await indexedTurns("sess-a")).toEqual(["User: alpha question"]);
		expect(await indexedMatches("bravo")).toBe(0);
	});

	it("keeps turn rows that rebuild the stored content through appends, rewrites and renames", async () => {
		init();
		const steps = [
			"User: one",
			"User: one\nAssistant: two",
			"User: one\nAssistant: two\nUser: thrée",
			"User: one\nAssistant: twofold\nUser: thrée",
			"User: one\nAssistant: twofold",
			"User: oné",
			"",
			"User: five six",
		];
		upsertSessionTranscript("sess-a", steps[0] ?? "", "codex", "/repo", "noam");
		for (const content of steps) {
			await write("UPDATE session_transcripts SET content = ? WHERE session_key = ?", content, "sess-a");
			const rows = await turnRows("sess-a");
			expect(rows.map((row) => row.text).join("")).toBe(content);
			expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => index + 1));
			let offset = 0;
			for (const row of rows) {
				expect(row.byte_offset).toBe(offset);
				offset += Buffer.byteLength(row.text);
			}
		}
		await write("UPDATE session_transcripts SET session_key = ? WHERE session_key = ?", "sess-b", "sess-a");
		expect(await turnRows("sess-a")).toEqual([]);
		expect(await indexedTurns("sess-b")).toEqual(["User: five six"]);
	});

	it("ignores punctuation-only and control characters in the query", async () => {
		init();
		upsertSessionTranscript("sess-a", "User: papa then quebec", "codex", "/repo", "noam");

		expect((await searchHits("papa -> quebec")).map((hit) => hit.rank < 0)).toEqual([true]);
		expect((await searchHits("papa\u0000quebec")).map((hit) => hit.rank < 0)).toEqual([true]);
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

	it("backfills the turn index through the database owner without a local write", async () => {
		const accessor = init();
		const { dbOwnerBackfillTranscriptTurns, dbOwnerBatch, dbOwnerQuery, getDbOwner, ownerStatement } = await import(
			"./db-owner-runtime"
		);
		await upsertSessionTranscriptAsync("owner-a", "User: echo first", "claude-code", "/repo", "agent-a");
		await upsertSessionTranscriptAsync("owner-b", "User: echo second", "claude-code", "/repo", "agent-a");
		await dbOwnerBatch(
			[
				ownerStatement("DELETE FROM session_transcript_turns", [], "run"),
				ownerStatement(
					"UPDATE session_transcript_turns_backfill SET cursor = 0, end_rowid = (SELECT MAX(rowid) FROM session_transcripts)",
					[],
					"run",
				),
			],
			{ operation: "test.transcript.turns.reset" },
		);
		const owner = await getDbOwner();
		const local = spyOn(accessor, "withWriteTxAsync").mockImplementation(() => {
			throw new Error("request-thread backfill write");
		});
		try {
			const chunk = () => dbOwnerBackfillTranscriptTurns(owner, { maxRows: 1 }, { operation: "test.transcript.turns" });
			const first = await chunk();
			const second = await chunk();
			expect([first, second]).toEqual([
				{ complete: false, indexed: 1 },
				{ complete: true, indexed: 1 },
			]);
			expect(local).not.toHaveBeenCalled();
		} finally {
			local.mockRestore();
		}
		const indexed = await dbOwnerQuery<{ count: number }>(
			ownerStatement(
				"SELECT COUNT(*) AS count FROM session_transcript_turns_fts WHERE session_transcript_turns_fts MATCH 'echo'",
				[],
				"get",
			),
			{ operation: "test.transcript.turns.readback" },
		);
		expect(indexed.count).toBe(2);
	});

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

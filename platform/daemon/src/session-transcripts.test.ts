import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	ensureCanonicalTranscriptHistory,
	searchTranscriptFallback,
	upsertSessionTranscript,
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

	function insertTranscriptRow(root: string, sessionKey: string, content: string): void {
		initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
		getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
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
		insertTranscriptRow(root, "legacy-db-session", originalLegacyTranscript);

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
		insertTranscriptRow(root, "fresh-session", "User: fresh prompt\nAssistant: fresh reply");

		await ensureCanonicalTranscriptHistory(root, "default");

		expect(readJsonlLines(root)).toHaveLength(2);
		expect(markerExists(root)).toBe(false);
	});
});

import { getSyncDbAccessor } from "../legacy-sync/db-accessor-sync";
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as timers from "node:timers/promises";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { ensureCanonicalTranscriptHistory } from "./session-transcripts";
import {
	appendCanonicalTranscriptSnapshotIfMissing,
	appendCanonicalTranscriptTurns,
	canonicalTranscriptPath,
	isLegacyLayoutSession,
	legacyTranscriptTurns,
	readCanonicalTranscriptSessionKeys,
	rewriteReplacingLiveOnlySessions,
	sessionSeqCacheKey,
	writeCanonicalTranscriptSnapshot,
} from "./transcript-jsonl";

const roots: string[] = [];

function makeRoot(name: string): string {
	const root = join(tmpdir(), `signet-transcript-jsonl-${name}-${process.pid}-${Date.now()}`);
	roots.push(root);
	return root;
}

function readSessionRecords(path: string): Array<[string, string, string]> {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { role: string; content: string; source_format: string })
		.map((record) => [record.role, record.content, record.source_format]);
}

function appendLiveTurns(
	root: string,
	turns: Parameters<typeof appendCanonicalTranscriptTurns>[0]["turns"],
): Promise<string | null> {
	return appendCanonicalTranscriptTurns({
		basePath: root,
		agentId: "default",
		harness: "claude-code",
		sessionKey: "session-1",
		sourceFormat: "live",
		turns,
	});
}

function writeSourceSnapshot(
	root: string,
	lines: readonly string[],
	preserveExistingSession?: boolean,
	sessionKey = "session-1",
): ReturnType<typeof writeCanonicalTranscriptSnapshot> {
	return writeCanonicalTranscriptSnapshot({
		basePath: root,
		agentId: "default",
		harness: "claude-code",
		sessionKey,
		sourceFormat: "jsonl",
		sourcePath: join(root, `${sessionKey}.jsonl`),
		preserveExistingSession,
		transcript: lines.join("\n"),
	});
}

async function measureLongestBlock<T>(work: () => Promise<T>): Promise<[T, number]> {
	let longestBlock = 0;
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		longestBlock = Math.max(longestBlock, now - last);
		last = now;
	}, 1);
	try {
		const result = await work();
		return [result, Math.max(longestBlock, performance.now() - last)];
	} finally {
		clearInterval(timer);
	}
}

function advancePastBackfillRetry(): void {
	setSystemTime(new Date(Date.now() + 61 * 60_000));
}

afterEach(async () => {
	setSystemTime();
	await closeDbAccessor();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("canonical transcript JSONL", () => {
	test("preserves multiline and whitespace-sensitive content in completed snapshots", async () => {
		const root = makeRoot("fidelity");
		const transcript = "User:  leading  spaces\nline two\nAssistant: answer\n\nwith  spacing  ";
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "agent-fidelity",
			harness: "codex",
			sessionKey: "fidelity-session",
			sessionId: "fidelity-id",
			project: "project",
			sourceFormat: "markdown",
			capturedAt: "2026-09-22T00:00:00.000Z",
			transcript,
		});

		const records = readFileSync(canonicalTranscriptPath(root, "codex"), "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => {
				const { role, content, captured_at } = JSON.parse(line) as {
					role: string;
					content: string;
					captured_at: string;
				};
				return { role, content, captured_at };
			});
		expect(records).toEqual([
			{ role: "user", content: " leading  spaces\nline two", captured_at: "2026-09-22T00:00:00.000Z" },
			{ role: "assistant", content: "answer\n\nwith  spacing  ", captured_at: "2026-09-22T00:00:00.000Z" },
		]);
	});

	test("v2 backfill retains migrated Markdown roles, multiline bytes, time, and original provenance", async () => {
		const root = makeRoot("v2-markdown-upgrade");
		const artifactName = "2026-04-28T00-00-00Z--migrationproof00--transcript.md";
		mkdirSync(join(root, "transcripts"), { recursive: true });
		writeFileSync(join(root, "workspace-layout.json"), JSON.stringify({ version: 2 }), "utf8");
		writeFileSync(
			join(root, "transcripts", artifactName),
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "migration-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				"---",
				"User:  leading  spaces",
				"line two",
				"Assistant: complete reply",
				"",
			].join("\n"),
		);
		await ensureCanonicalTranscriptHistory(root, "default");
		const records = readFileSync(canonicalTranscriptPath(root, "codex"), "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { role: string; content: string; captured_at: string; source_path: string });
		expect(
			records.map(({ role, content, captured_at, source_path }) => ({ role, content, captured_at, source_path })),
		).toEqual([
			{
				role: "user",
				content: " leading  spaces\nline two",
				captured_at: "2026-04-28T00:00:00.000Z",
				source_path: `memory/${artifactName}`,
			},
			{
				role: "assistant",
				content: "complete reply",
				captured_at: "2026-04-28T00:00:00.000Z",
				source_path: `memory/${artifactName}`,
			},
		]);
	});

	test("waits for the transcript file lock before writing live turns", async () => {
		const root = makeRoot("lock");
		const path = canonicalTranscriptPath(root, "codex");
		const lock = `${path}.lock`;
		mkdirSync(lock, { recursive: true });

		const moduleUrl = pathToFileURL(fileURLToPath(new URL("./transcript-jsonl.ts", import.meta.url))).href;
		const worker = join(root, "append-worker.mjs");
		writeFileSync(
			worker,
			`
import { appendCanonicalTranscriptTurns } from ${JSON.stringify(moduleUrl)};

await appendCanonicalTranscriptTurns({
  basePath: process.env.TEST_SIGNET_ROOT,
  agentId: "default",
  harness: "codex",
  sessionKey: "locked-session",
  sourceFormat: "live",
  turns: [{ role: "user", content: "queued while lock is held" }],
});
`,
			"utf8",
		);

		const proc = Bun.spawn([process.execPath, worker], {
			env: { ...process.env, TEST_SIGNET_ROOT: root },
			stdout: "pipe",
			stderr: "pipe",
		});

		await Bun.sleep(100);
		expect(existsSync(path)).toBe(false);

		rmSync(lock, { recursive: true, force: true });
		expect(await proc.exited).toBe(0);
		expect(readFileSync(path, "utf8")).toContain("queued while lock is held");
	});

	test("reaps a known-dead owner without waiting for the stale-age threshold", async () => {
		const root = makeRoot("dead-owner");
		const path = canonicalTranscriptPath(root, "codex");
		const lock = `${path}.lock`;
		mkdirSync(lock, { recursive: true });
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid + 100_000, token: "dead-owner-test" }));

		const startedAt = performance.now();
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "dead-owner-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "recovered after dead owner" }],
		});

		expect(performance.now() - startedAt).toBeLessThan(500);
		expect(readFileSync(path, "utf8")).toContain("recovered after dead owner");
	});

	test("does not reap a live owner merely because the lock is old", async () => {
		const root = makeRoot("live-owner");
		const path = canonicalTranscriptPath(root, "codex");
		const lock = `${path}.lock`;
		mkdirSync(lock, { recursive: true });
		writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "live-owner-test" }));
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);

		const write = appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "live-owner-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "waited for live owner" }],
		});

		await Bun.sleep(25);
		expect(existsSync(path)).toBe(false);
		rmSync(lock, { recursive: true, force: true });
		await write;
		expect(readFileSync(path, "utf8")).toContain("waited for live owner");
	});

	test("retries legacy markdown backfill after a transient read failure", async () => {
		const root = makeRoot("retry");
		const memoryDir = join(root, "memory");
		const artifact = join(memoryDir, "2026-04-26T00-00-00Z--aaaaaaaaaaaaaaaa--transcript.md");
		mkdirSync(dirname(artifact), { recursive: true });
		mkdirSync(artifact);
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(existsSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"))).toBe(false);
		rmSync(artifact, { recursive: true, force: true });
		advancePastBackfillRetry();

		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "retry-session"',
				'session_id: "retry-session"',
				'captured_at: "2026-04-26T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: legacy hello",
				"Assistant: migrated now",
				"",
			].join("\n"),
			"utf8",
		);
		await ensureCanonicalTranscriptHistory(root, "default");

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript).toContain("legacy hello");
		expect(transcript).toContain("migrated now");
	});

	test("preserves concurrent live appends to the same harness file", async () => {
		const root = makeRoot("concurrent");
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				Promise.resolve().then(() =>
					appendCanonicalTranscriptTurns({
						basePath: root,
						agentId: "default",
						harness: "codex",
						sessionKey: "concurrent-session",
						sourceFormat: "live",
						turns: [{ role: "user", content: `concurrent turn ${index}` }],
					}),
				),
			),
		);

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		for (let index = 0; index < 12; index++) {
			expect(transcript).toContain(`concurrent turn ${index}`);
		}
	});

	test("deduplicates retried live appends for the same trailing turns", async () => {
		const root = makeRoot("dedupe");
		const input = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "retry-live-session",
			sourceFormat: "live" as const,
			turns: [
				{ role: "assistant" as const, content: "same assistant context" },
				{ role: "user" as const, content: "same retried prompt" },
			],
		};

		await appendCanonicalTranscriptTurns(input);
		await appendCanonicalTranscriptTurns(input);

		const transcript = readFileSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript.match(/same assistant context/g)?.length).toBe(1);
		expect(transcript.match(/same retried prompt/g)?.length).toBe(1);
	});

	test("deduplicates retried live appends whose records exceed the tail scan window", async () => {
		const root = makeRoot("dedupe-large");
		const reply = { role: "assistant" as const, content: "界".repeat(120_000) };
		const prompt = { role: "user" as const, content: "large retried prompt" };

		await appendLiveTurns(root, [reply, prompt]);
		await appendLiveTurns(root, [reply, prompt]);
		await appendLiveTurns(root, [reply]);
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-2",
			sourceFormat: "live",
			turns: [{ role: "user", content: "other session prompt" }],
		});
		await appendLiveTurns(root, [reply]);

		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code")).map(([role]) => role)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
		]);
	});

	test("deduplicates a retried batch whose last record exceeds the tail scan window", async () => {
		const root = makeRoot("dedupe-large-last");
		const batch = [
			{ role: "assistant" as const, content: "short reply before a large prompt" },
			{ role: "user" as const, content: "界".repeat(100_000) },
		];

		await appendLiveTurns(root, batch);
		await appendLiveTurns(root, batch);

		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code")).map(([role]) => role)).toEqual([
			"assistant",
			"user",
		]);
	});

	test("does not read a large older record beyond the tail needed to deduplicate a small batch", async () => {
		const root = makeRoot("dedupe-bounded");
		const huge = "x".repeat(2 * 1024 * 1024);
		await appendLiveTurns(root, [{ role: "user", content: huge }]);
		await appendLiveTurns(root, [{ role: "assistant", content: "Done." }]);
		const reads = spyOn(syncFs, "readSync");
		const fullReads = spyOn(syncFs, "readFileSync");
		try {
			await appendLiveTurns(root, [{ role: "assistant", content: "Done." }]);
			const bytes = reads.mock.calls.reduce(
				(total, args: readonly unknown[]) => total + (typeof args[3] === "number" ? args[3] : 0),
				0,
			);
			expect(bytes).toBeGreaterThan(0);
			expect(bytes).toBeLessThan(huge.length);
			expect(fullReads.mock.calls.some(([path]) => path === canonicalTranscriptPath(root, "claude-code"))).toBe(false);
		} finally {
			reads.mockRestore();
			fullReads.mockRestore();
		}

		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code")).map(([role]) => role)).toEqual([
			"user",
			"assistant",
		]);
	});
});

describe("backfill OOM regression (#587)", () => {
	test("skips backfill when persistent marker exists", async () => {
		const root = makeRoot("marker-skip");
		const memDir = join(root, "memory");
		mkdirSync(memDir, { recursive: true });
		const artifact = join(memDir, "2026-04-28T00-00-00Z--markertest000000--transcript.md");
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "marker-skip-session"',
				'session_id: "marker-skip-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: should not appear if marker works",
				"Assistant: marker test reply",
				"",
			].join("\n"),
			"utf8",
		);
		const markerPath = join(memDir, ".canonical-transcript-backfill-v1.default");
		writeFileSync(markerPath, JSON.stringify({ completed_at: new Date().toISOString(), agent_id: "default" }), "utf8");
		await ensureCanonicalTranscriptHistory(root, "default");
		const jsonlPath = join(memDir, "codex", "transcripts", "transcript.jsonl");
		expect(existsSync(jsonlPath)).toBe(false);
	});

	test("backfills missing sessions even when an existing JSONL is large", async () => {
		const root = makeRoot("populated-continue");
		const memDir = join(root, "memory");
		const transcriptsDir = join(memDir, "codex", "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });
		const jsonlPath = join(transcriptsDir, "transcript.jsonl");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "old-session-0",
			sourceFormat: "normalized",
			transcript: `User: ${"x".repeat(500)}`,
		});
		const seedRecord = JSON.parse(readFileSync(jsonlPath, "utf8")) as Record<string, unknown>;
		const lines = Array.from({ length: 2500 }, (_, index) =>
			JSON.stringify({
				...seedRecord,
				session_key: `old-session-${index}`,
				session_id: `old-session-${index}`,
				id: `old-record-${index}`,
			}),
		).join("\n");
		writeFileSync(jsonlPath, lines, "utf8");
		expect(statSync(jsonlPath).size).toBeGreaterThan(1024 * 1024);
		const artifact = join(memDir, "2026-04-28T00-00-00Z--populatedtest00--transcript.md");
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				'agent_id: "default"',
				'harness: "codex"',
				'session_key: "populated-skip-session"',
				'session_id: "populated-skip-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				'project: "/tmp/project"',
				"---",
				"User: should be appended despite existing JSONL",
				"",
			].join("\n"),
			"utf8",
		);

		const sizeBefore = statSync(jsonlPath).size;
		await ensureCanonicalTranscriptHistory(root, "default");

		expect(statSync(jsonlPath).size).toBeGreaterThan(sizeBefore);
		expect(readFileSync(jsonlPath, "utf8")).toContain("should be appended despite existing JSONL");

		expect(existsSync(join(memDir, ".canonical-transcript-backfill-v1.default"))).toBe(true);
	});

	test("scopes persistent markers by agent", async () => {
		const root = makeRoot("marker-agent-scope");
		const memDir = join(root, "memory");
		mkdirSync(memDir, { recursive: true });
		writeFileSync(
			join(memDir, ".canonical-transcript-backfill-v1.default"),
			JSON.stringify({ completed_at: new Date().toISOString(), agent_id: "default" }),
			"utf8",
		);
		writeFileSync(
			join(memDir, "2026-04-28T00-00-00Z--agenttwotest00--transcript.md"),
			[
				"---",
				'kind: "transcript"',
				'agent_id: "agent-two"',
				'harness: "codex"',
				'session_key: "agent-two-session"',
				'session_id: "agent-two-session"',
				'captured_at: "2026-04-28T00:00:00.000Z"',
				"---",
				"User: scoped marker should not suppress this",
				"",
			].join("\n"),
			"utf8",
		);

		await ensureCanonicalTranscriptHistory(root, "agent-two");

		const transcript = readFileSync(join(memDir, "codex", "transcripts", "transcript.jsonl"), "utf8");
		expect(transcript).toContain("scoped marker should not suppress this");
		expect(existsSync(join(memDir, ".canonical-transcript-backfill-v1.agent-two"))).toBe(true);
	});

	test("appendCanonicalTranscriptSnapshotIfMissing does not duplicate retried backfill sessions", async () => {
		const root = makeRoot("append-snapshot-missing");
		const jsonlPath = canonicalTranscriptPath(root, "codex");

		const input = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db" as const,
			transcript: "User: first session\nAssistant: first reply",
		};

		await appendCanonicalTranscriptSnapshotIfMissing(input);
		await appendCanonicalTranscriptSnapshotIfMissing(input);

		const content = readFileSync(jsonlPath, "utf8");
		expect(content.match(/first session/g)?.length).toBe(1);
		expect(content.match(/first reply/g)?.length).toBe(1);
	});

	test("overlapping backfills with stale session snapshots append a session once", async () => {
		const root = makeRoot("append-snapshot-stale-known");
		const jsonlPath = canonicalTranscriptPath(root, "claude-code");
		const input = {
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "imported-session",
			capturedAt: "2026-09-20T00:00:00.000Z",
			sourceFormat: "db" as const,
			transcript: "User: imported prompt\nAssistant: imported reply",
		};

		await Promise.all([
			appendCanonicalTranscriptSnapshotIfMissing(input, new Set()),
			appendCanonicalTranscriptSnapshotIfMissing(input, new Set()),
		]);
		await appendCanonicalTranscriptSnapshotIfMissing(input, new Set());

		expect(readFileSync(jsonlPath, "utf8").trim().split("\n")).toHaveLength(2);
		await expect(readCanonicalTranscriptSessionKeys({ basePath: root, harness: "claude-code" })).resolves.toBeDefined();
	});

	test("backfill with a stale session snapshot does not restart a live session's sequence", async () => {
		const root = makeRoot("append-snapshot-after-live");
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "pi",
			sessionKey: "live-then-import",
			sourceFormat: "live",
			turns: [{ role: "user", content: "live prompt" }],
		});

		await appendCanonicalTranscriptSnapshotIfMissing(
			{
				basePath: root,
				agentId: "default",
				harness: "pi",
				sessionKey: "live-then-import",
				sourceFormat: "db",
				transcript: "User: imported prompt\nAssistant: imported reply",
			},
			new Set(),
		);

		await expect(readCanonicalTranscriptSessionKeys({ basePath: root, harness: "pi" })).resolves.toBeDefined();
	});

	test("continues a session's sequence when its records are outside the recent tail", async () => {
		const root = makeRoot("append-seq-outside-tail");
		const jsonlPath = canonicalTranscriptPath(root, "oh-my-pi");
		const record = (sessionKey: string, seq: number, content: string): string =>
			JSON.stringify({
				schema: "signet.transcript.v1",
				id: `${sessionKey}-${seq}`,
				captured_at: "2026-09-20T00:00:00.000Z",
				agent_id: "default",
				harness: "oh-my-pi",
				session_key: sessionKey,
				session_id: sessionKey,
				project: null,
				seq,
				role: "user",
				content,
				source_format: "live",
				source_sha256: "0",
			});
		mkdirSync(dirname(jsonlPath), { recursive: true });
		writeFileSync(
			jsonlPath,
			`${[
				record("long-session", 1, "first"),
				record("long-session", 2, "second"),
				...Array.from({ length: 300 }, (_, index) => record("other-session", index + 1, "x".repeat(1024))),
			].join("\n")}\n`,
		);

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "oh-my-pi",
			sessionKey: "long-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "resumed after restart" }],
		});

		await expect(readCanonicalTranscriptSessionKeys({ basePath: root, harness: "oh-my-pi" })).resolves.toBeDefined();
		const resumed = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { content: string; seq: number })
			.find((entry) => entry.content === "resumed after restart");
		expect(resumed?.seq).toBe(3);
	});

	test("writeCanonicalTranscriptSnapshot replaces live partial turns for a session", async () => {
		const root = makeRoot("replace-snapshot");
		const jsonlPath = canonicalTranscriptPath(root, "codex");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "partial prompt" }],
		});
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			transcript: "User: final prompt\nAssistant: final reply",
		});
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-2",
			sourceFormat: "db",
			transcript: "User: second session\nAssistant: second reply",
		});

		const content = readFileSync(jsonlPath, "utf8");
		expect(content).not.toContain("partial prompt");
		expect(content).toContain("final prompt");
		expect(content).toContain("final reply");
		expect(content).toContain("second session");
	});

	test("preserves a completed session when a replacement snapshot is shorter or divergent", async () => {
		const root = makeRoot("preserve-divergent-snapshot");
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			sourcePath: join(root, "stale-source.jsonl"),
			transcript: "User: A\nAssistant: B\nUser: C",
		});

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			sourcePath: join(root, "stale-source.jsonl"),
			transcript: "User: A\nAssistant: X",
		});

		expect(replaced).toBeNull();
		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain('"content":"B"');
		expect(content).toContain('"content":"C"');
		expect(content).not.toContain('"content":"X"');
	});

	test("a source snapshot fills the gaps of a completed live-only session", async () => {
		const root = makeRoot("fill-live-only");
		await appendLiveTurns(root, [
			{ role: "user", content: "first  question" },
			{ role: "user", content: "second question" },
		]);

		const replaced = await writeSourceSnapshot(
			root,
			["User: first question", "Assistant: first answer", "User: second question", "Assistant: second answer"],
			true,
		);

		expect(replaced).not.toBeNull();
		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
			["user", "first question", "jsonl"],
			["assistant", "first answer", "jsonl"],
			["user", "second question", "jsonl"],
			["assistant", "second answer", "jsonl"],
		]);
	});

	test("a source snapshot fills a live-only session when hook output follows a user turn", async () => {
		const root = makeRoot("fill-live-only-hook-output");
		await appendLiveTurns(root, [
			{ role: "user", content: "first question" },
			{ role: "user", content: "second question" },
		]);

		const replaced = await writeSourceSnapshot(
			root,
			[
				"User: first question",
				"System: UserPromptSubmit hook additional context: project rules",
				"Assistant: first answer",
				"User: second question",
				"Assistant: second answer",
			],
			true,
		);

		expect(replaced).not.toBeNull();
		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
			["user", "first question\nSystem: UserPromptSubmit hook additional context: project rules", "jsonl"],
			["assistant", "first answer", "jsonl"],
			["user", "second question", "jsonl"],
			["assistant", "second answer", "jsonl"],
		]);
	});

	test("keeps a live turn that only shares a word prefix with the source as a live tail", async () => {
		const root = makeRoot("live-tail-word-prefix");
		await appendLiveTurns(root, [{ role: "user", content: "ok" }]);

		const replaced = await writeSourceSnapshot(root, ["User: okay then", "Assistant: done"], true);

		expect(replaced).not.toBeNull();
		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
			["user", "okay then", "jsonl"],
			["assistant", "done", "jsonl"],
			["user", "ok", "live"],
		]);
	});

	test("keeps a live turn that the source never had in its place between source turns", async () => {
		const root = makeRoot("live-middle-kept");
		await appendLiveTurns(root, [
			{ role: "user", content: "first question" },
			{ role: "user", content: "cancelled prompt" },
			{ role: "user", content: "second question" },
		]);

		for (const preserveExistingSession of [false, true]) {
			const replaced = await writeSourceSnapshot(
				root,
				["User: first question", "Assistant: first answer", "User: second question", "Assistant: second answer"],
				preserveExistingSession,
			);
			expect(replaced).not.toBeNull();
			expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
				["user", "first question", "jsonl"],
				["assistant", "first answer", "jsonl"],
				["user", "cancelled prompt", "live"],
				["user", "second question", "jsonl"],
				["assistant", "second answer", "jsonl"],
			]);
		}
	});

	test("keeps a retained live turn in place when a later source turn repeats its text", async () => {
		const root = makeRoot("live-repeated-later");
		await appendLiveTurns(root, [
			{ role: "user", content: "first question" },
			{ role: "user", content: "yes" },
			{ role: "user", content: "second question" },
		]);
		await writeSourceSnapshot(
			root,
			["User: first question", "Assistant: first answer", "User: second question", "Assistant: second answer"],
			true,
		);

		const replaced = await writeSourceSnapshot(
			root,
			[
				"User: first question",
				"Assistant: first answer",
				"User: second question",
				"Assistant: second answer",
				"User: yes",
				"Assistant: third answer",
			],
			true,
		);

		expect(replaced).not.toBeNull();
		expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
			["user", "first question", "jsonl"],
			["assistant", "first answer", "jsonl"],
			["user", "yes", "live"],
			["user", "second question", "jsonl"],
			["assistant", "second answer", "jsonl"],
			["user", "yes", "jsonl"],
			["assistant", "third answer", "jsonl"],
		]);
	});

	test("bounds prefix checks when live turns do not match a large source", async () => {
		const root = makeRoot("bounded-live-merge");
		const live = Array.from({ length: 80 }, (_, index) => ({
			role: "user" as const,
			content: `missing ${index}`,
		}));
		const source = Array.from({ length: 160 }, (_, index) => `User: source ${index}`);
		await appendLiveTurns(root, live);
		const startsWith = String.prototype.startsWith;
		let checks = 0;
		const prefix = spyOn(String.prototype, "startsWith").mockImplementation(function (
			this: string,
			search: string,
			position?: number,
		): boolean {
			if (startsWith.call(search, "missing ")) checks++;
			return startsWith.call(this, search, position);
		});
		let records: Awaited<ReturnType<typeof writeSourceSnapshot>>;
		try {
			records = await writeSourceSnapshot(root, source, true);
		} finally {
			prefix.mockRestore();
		}
		expect(records?.map((record) => record.content)).toEqual([
			...source.map((line) => line.slice("User: ".length)),
			...live.map((turn) => turn.content),
		]);
		expect(checks).toBeLessThanOrEqual(source.length + live.length);
	});

	test("yields across unmatched source roles and non-live anchors", async () => {
		const root = makeRoot("yield-source-anchors");
		await appendLiveTurns(root, [{ role: "user", content: "match" }]);
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			turns: [{ role: "user", content: "anchor" }],
		});
		const source = [
			...Array.from({ length: 2_048 }, (_, index) => `Assistant: answer ${index}`),
			"User: match",
			"User: anchor",
		];
		const yields = spyOn(timers, "setImmediate");
		try {
			const records = await writeSourceSnapshot(root, source, true);
			expect(records?.map((record) => record.content)).toEqual([
				...Array.from({ length: 2_048 }, (_, index) => `answer ${index}`),
				"match",
				"anchor",
			]);
			expect(yields).toHaveBeenCalled();
		} finally {
			yields.mockRestore();
		}
	});

	test("keeps the event loop responsive while it writes a large source snapshot", async () => {
		const root = makeRoot("large-snapshot-event-loop");
		await appendLiveTurns(root, [
			{ role: "user", content: "question 0" },
			{ role: "user", content: "cancelled prompt" },
		]);
		const pad = "w".repeat(4000);
		const lines = Array.from({ length: 1600 }, (_, index) => [
			`User: question ${index} ${pad}`,
			`Assistant: answer ${index}`,
		]).flat();
		lines[0] = "User: question 0";

		const [written, longestBlock] = await measureLongestBlock(() => writeSourceSnapshot(root, lines, true));

		expect(written).toHaveLength(3201);
		expect(written?.at(-1)).toMatchObject({ content: "cancelled prompt", source_format: "live" });
		expect(longestBlock).toBeLessThan(500);
	});

	test("serializes concurrent snapshot writes to the same transcript file", async () => {
		const root = makeRoot("concurrent-snapshots");
		const jsonlPath = canonicalTranscriptPath(root, "claude-code");
		await writeSourceSnapshot(root, ["User: seed"]);
		const writes = Array.from({ length: 6 }, (_, index) =>
			writeSourceSnapshot(
				root,
				[`User: question ${index}`, `Assistant: answer ${index}`],
				undefined,
				`session-${index + 2}`,
			),
		);
		writes.push(writeSourceSnapshot(root, ["User: seed", "Assistant: seed answer"], true));

		const results = await Promise.all(writes);

		expect(results.every((result) => result !== null)).toBe(true);
		const records = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { session_key: string; content: string });
		expect(records).toHaveLength(14);
		expect(records.filter((record) => record.session_key === "session-1").map((record) => record.content)).toEqual([
			"seed",
			"seed answer",
		]);
		expect(existsSync(`${jsonlPath}.snapshot-tmp`)).toBe(false);
	});

	test.each([false, true])(
		"syncs a new-session directory before accepting capture (existing file: %s)",
		async (existing: boolean) => {
			const root = makeRoot(`append-directory-sync-${existing}`);
			if (existing) await writeSourceSnapshot(root, ["User: seed"], undefined, "seed");
			const path = canonicalTranscriptPath(root, "claude-code");
			const failure = new Error("injected directory sync failure");
			const open = fs.open;
			let syncs = 0;
			const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
				const handle = await open(...args);
				if (args[0] === dirname(path)) {
					const sync = handle.sync.bind(handle);
					spyOn(handle, "sync").mockImplementation(async () => {
						syncs++;
						if (syncs === 1) throw failure;
						await sync();
					});
				}
				return handle;
			});
			try {
				await expect(writeSourceSnapshot(root, ["User: question", "Assistant: answer"])).rejects.toBe(failure);
				expect(syncs).toBe(1);
				const before = readFileSync(path, "utf8");
				expect(await writeSourceSnapshot(root, ["User: question", "Assistant: answer"])).toHaveLength(2);
				expect(syncs).toBe(2);
				expect(readFileSync(path, "utf8")).toBe(before);
				expect(existsSync(`${path}.snapshot-tmp`)).toBe(false);
				expect(existsSync(`${path}.lock`)).toBe(false);
			} finally {
				opening.mockRestore();
			}
		},
	);

	test.each(["write", "sync", "close", "rename"] as const)(
		"preserves the original and cleans temporary output after a snapshot %s failure",
		async (stage: "write" | "sync" | "close" | "rename") => {
			const root = makeRoot(`snapshot-${stage}-failure`);
			await writeSourceSnapshot(root, ["User: seed"]);
			const path = canonicalTranscriptPath(root, "claude-code");
			const before = readFileSync(path, "utf8");
			const failure = new Error(`injected ${stage} failure`);
			const open = fs.open;
			const rename = fs.rename;
			let injected = false;
			const fail = (): void => {
				expect(readFileSync(`${path}.snapshot-tmp`, "utf8")).toContain("new answer");
				expect(existsSync(`${path}.lock`)).toBe(true);
				injected = true;
				throw failure;
			};
			const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
				const handle = await open(...args);
				if (args[0] !== `${path}.snapshot-tmp`) return handle;
				if (stage === "write") {
					const write = handle.writeFile.bind(handle);
					spyOn(handle, "writeFile").mockImplementation(async (...args: Parameters<typeof write>) => {
						await write(...args);
						fail();
					});
				}
				if (stage === "sync") spyOn(handle, "sync").mockImplementation(async () => fail());
				if (stage === "close") {
					const close = handle.close.bind(handle);
					spyOn(handle, "close").mockImplementation(async () => {
						await close();
						if (!injected) fail();
					});
				}
				return handle;
			});
			const renaming = spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof rename>) => {
				if (stage === "rename" && args[0] === `${path}.snapshot-tmp`) fail();
				await rename(...args);
			});
			try {
				await expect(writeSourceSnapshot(root, ["User: seed", "Assistant: new answer"])).rejects.toBe(failure);
				expect(injected).toBe(true);
				expect(readFileSync(path, "utf8")).toBe(before);
				expect(existsSync(`${path}.snapshot-tmp`)).toBe(false);
				expect(existsSync(`${path}.lock`)).toBe(false);
			} finally {
				opening.mockRestore();
				renaming.mockRestore();
			}
			expect(await writeSourceSnapshot(root, ["User: seed", "Assistant: new answer"])).toHaveLength(2);
		},
	);

	test.each(["sync", "cleanup"] as const)(
		"holds the transcript lock across asynchronous %s",
		async (stage: "sync" | "cleanup") => {
			const root = makeRoot(`async-lock-${stage}`);
			await writeSourceSnapshot(root, ["User: seed"]);
			const path = canonicalTranscriptPath(root, "claude-code");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const open = fs.open;
			const rm = fs.rm;
			const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
				const handle = await open(...args);
				if (stage === "sync" && args[0] === `${path}.snapshot-tmp`) {
					const sync = handle.sync.bind(handle);
					spyOn(handle, "sync").mockImplementation(async () => {
						entered.resolve();
						await release.promise;
						await sync();
					});
				}
				return handle;
			});
			const removing = spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof rm>) => {
				if (stage === "cleanup" && args[0] === `${path}.snapshot-tmp`) {
					entered.resolve();
					await release.promise;
				}
				await rm(...args);
			});
			const writing = writeSourceSnapshot(
				root,
				stage === "cleanup" ? ["User: seed"] : ["User: seed", "Assistant: new answer"],
			);
			let appending: Promise<unknown> | undefined;
			try {
				await Promise.race([
					entered.promise,
					writing.then(() => {
						throw new Error(`Snapshot completed without awaiting asynchronous ${stage}`);
					}),
				]);
				expect(existsSync(`${path}.lock`)).toBe(true);
				let appended = false;
				appending = appendLiveTurns(root, [{ role: "user", content: "queued prompt" }]).then(() => {
					appended = true;
				});
				await new Promise((resolve) => setTimeout(resolve, 25));
				expect(appended).toBe(false);
				expect(readFileSync(path, "utf8")).not.toContain("queued prompt");
			} finally {
				release.resolve();
				try {
					await writing;
					await appending;
				} finally {
					opening.mockRestore();
					removing.mockRestore();
				}
			}
			expect(readSessionRecords(path)).toEqual([
				["user", "seed", "jsonl"],
				...(stage === "sync" ? [["assistant", "new answer", "jsonl"] as [string, string, string]] : []),
				["user", "queued prompt", "live"],
			]);
			expect(existsSync(`${path}.snapshot-tmp`)).toBe(false);
			expect(existsSync(`${path}.lock`)).toBe(false);
		},
	);

	test("does not remove the temporary name after publishing a snapshot", async () => {
		const root = makeRoot("published-temp");
		await writeSourceSnapshot(root, ["User: seed"]);
		const path = canonicalTranscriptPath(root, "claude-code");
		const removing = spyOn(fs, "rm");
		try {
			await writeSourceSnapshot(root, ["User: seed", "Assistant: new answer"]);
			expect(removing.mock.calls.some(([target]) => target === `${path}.snapshot-tmp`)).toBe(false);
			expect(readSessionRecords(path)).toEqual([
				["user", "seed", "jsonl"],
				["assistant", "new answer", "jsonl"],
			]);
		} finally {
			removing.mockRestore();
		}
	});

	test("recovers a cancelled snapshot owner without publishing its temporary output", async () => {
		const root = makeRoot("cancelled-snapshot-owner");
		await writeSourceSnapshot(root, ["User: seed"]);
		const path = canonicalTranscriptPath(root, "claude-code");
		const before = readFileSync(path, "utf8");
		const moduleUrl = new URL("./transcript-jsonl.ts", import.meta.url).href;
		const worker = join(root, "snapshot-worker.mjs");
		writeFileSync(
			worker,
			`
import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { writeCanonicalTranscriptSnapshot } from ${JSON.stringify(moduleUrl)};
const open = fs.open;
spyOn(fs, "open").mockImplementation(async (...args) => {
  const handle = await open(...args);
  if (args[0] === ${JSON.stringify(`${path}.snapshot-tmp`)}) {
    spyOn(handle, "sync").mockImplementation(async () => {
      console.log("snapshot-sync-paused");
      await new Promise(() => {});
    });
  }
  return handle;
});
setInterval(() => {}, 100);
await writeCanonicalTranscriptSnapshot({
  basePath: ${JSON.stringify(root)},
  agentId: "default", harness: "claude-code", sessionKey: "session-1",
  sourceFormat: "jsonl", sourcePath: ${JSON.stringify(join(root, "session-1.jsonl"))},
  transcript: "User: seed\\nAssistant: cancelled answer",
});
`,
		);
		const child = Bun.spawn([process.execPath, worker], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
		const output = child.stdout.getReader();
		try {
			const ready = await output.read();
			expect(new TextDecoder().decode(ready.value)).toContain("snapshot-sync-paused");
			expect(existsSync(`${path}.lock`)).toBe(true);
			expect(readFileSync(`${path}.snapshot-tmp`, "utf8")).toContain("cancelled answer");
			expect(readFileSync(path, "utf8")).toBe(before);
		} finally {
			child.kill();
			await child.exited;
			output.releaseLock();
		}
		expect(await new Response(child.stderr).text()).toBe("");
		expect(await writeSourceSnapshot(root, ["User: seed", "Assistant: recovered answer"])).toHaveLength(2);
		expect(readSessionRecords(path)).toEqual([
			["user", "seed", "jsonl"],
			["assistant", "recovered answer", "jsonl"],
		]);
		expect(existsSync(`${path}.snapshot-tmp`)).toBe(false);
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("keeps the project of a live turn that the source does not contain", async () => {
		const root = makeRoot("live-kept-project");
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			project: "/work/project-a",
			sourceFormat: "live",
			turns: [
				{ role: "user", content: "first question" },
				{ role: "user", content: "cancelled prompt" },
			],
		});

		await writeSourceSnapshot(root, ["User: first question", "Assistant: first answer"], true);

		const records = readFileSync(canonicalTranscriptPath(root, "claude-code"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { content: string; source_format: string; project: string | null });
		expect(records.map((record) => [record.content, record.source_format, record.project])).toEqual([
			["first question", "jsonl", null],
			["first answer", "jsonl", null],
			["cancelled prompt", "live", "/work/project-a"],
		]);
	});

	test("leaves the file untouched when a repeated source capture changes nothing", async () => {
		const root = makeRoot("live-kept-unchanged");
		const jsonlPath = canonicalTranscriptPath(root, "claude-code");
		await appendLiveTurns(root, [
			{ role: "user", content: "first question" },
			{ role: "user", content: "cancelled prompt" },
		]);
		const capture = (capturedAt: string) =>
			writeCanonicalTranscriptSnapshot({
				basePath: root,
				agentId: "default",
				harness: "claude-code",
				sessionKey: "session-1",
				sourceFormat: "jsonl",
				sourcePath: join(root, "session-1.jsonl"),
				preserveExistingSession: true,
				capturedAt,
				transcript: "User: first question\nAssistant: first answer",
			});
		expect(await capture("2026-06-20T10:00:00.000Z")).not.toBeNull();
		const before = readFileSync(jsonlPath, "utf8");

		expect(await capture("2026-06-20T11:00:00.000Z")).not.toBeNull();

		expect(readFileSync(jsonlPath, "utf8")).toBe(before);
		expect(readSessionRecords(jsonlPath)).toEqual([
			["user", "first question", "jsonl"],
			["assistant", "first answer", "jsonl"],
			["user", "cancelled prompt", "live"],
		]);
	});

	test("a source snapshot equal to the live records gives them source provenance", async () => {
		const root = makeRoot("live-exact-match");
		await appendLiveTurns(root, [
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
		]);

		const replaced = await writeSourceSnapshot(root, ["User: first question", "Assistant: first answer"], true);

		expect(replaced).not.toBeNull();
		const records = readFileSync(canonicalTranscriptPath(root, "claude-code"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { source_format: string; source_path?: string });
		expect(records.map((record) => [record.source_format, record.source_path])).toEqual([
			["jsonl", join(root, "session-1.jsonl")],
			["jsonl", join(root, "session-1.jsonl")],
		]);
	});

	test("keeps live turns that are newer than the source of a session in progress", async () => {
		const root = makeRoot("live-tail-in-progress");
		const jsonlPath = canonicalTranscriptPath(root, "claude-code");
		await appendLiveTurns(root, [
			{ role: "user", content: "first question" },
			{ role: "user", content: "second question" },
		]);

		expect(await writeSourceSnapshot(root, ["User: first question", "Assistant: first answer"])).not.toBeNull();
		expect(readSessionRecords(jsonlPath)).toEqual([
			["user", "first question", "jsonl"],
			["assistant", "first answer", "jsonl"],
			["user", "second question", "live"],
		]);

		const second = await writeSourceSnapshot(
			root,
			[
				"User: first question",
				"Assistant: first answer",
				"User: second question",
				"System: UserPromptSubmit hook additional context: project rules",
				"Assistant: second answer",
			],
			true,
		);
		expect(second).not.toBeNull();
		expect(readSessionRecords(jsonlPath)).toEqual([
			["user", "first question", "jsonl"],
			["assistant", "first answer", "jsonl"],
			["user", "second question\nSystem: UserPromptSubmit hook additional context: project rules", "jsonl"],
			["assistant", "second answer", "jsonl"],
		]);
	});

	describe("session with source records and a live tail", () => {
		async function seedMixedSession(root: string): Promise<void> {
			await writeSourceSnapshot(root, ["User: first question", "Assistant: first answer"]);
			await appendLiveTurns(root, [{ role: "user", content: "second question" }]);
		}

		test("a source snapshot absorbs the live tail", async () => {
			const root = makeRoot("mixed-live-tail");
			await seedMixedSession(root);

			const replaced = await writeSourceSnapshot(
				root,
				[
					"User: first question",
					"Assistant: first answer",
					"User: second question",
					"System: UserPromptSubmit hook additional context: project rules",
					"Assistant: second answer",
				],
				true,
			);

			expect(replaced).not.toBeNull();
			expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
				["user", "first question", "jsonl"],
				["assistant", "first answer", "jsonl"],
				["user", "second question\nSystem: UserPromptSubmit hook additional context: project rules", "jsonl"],
				["assistant", "second answer", "jsonl"],
			]);
		});

		test("a source snapshot keeps a live record with an invalid role as written and leaves it out of the merge", async () => {
			const root = makeRoot("mixed-invalid-role");
			await seedMixedSession(root);
			const path = canonicalTranscriptPath(root, "claude-code");
			const liveLine = readFileSync(path, "utf8").trim().split("\n").at(-1) ?? "";
			const { role: _role, ...withoutRole } = JSON.parse(liveLine) as Record<string, unknown>;
			const malformed = JSON.stringify({ ...withoutRole, seq: 4, content: "stray live text" });
			writeFileSync(path, `${readFileSync(path, "utf8")}${malformed}\n`);

			await writeSourceSnapshot(
				root,
				["User: first question", "Assistant: first answer", "User: second question", "Assistant: second answer"],
				true,
			);

			const lines = readFileSync(path, "utf8").trim().split("\n");
			expect(lines).toContain(malformed);
			expect(lines.filter((line) => line.includes("stray live text"))).toHaveLength(1);
		});

		test("refuses a source snapshot that does not start with the session's source records", async () => {
			const root = makeRoot("mixed-divergent-prefix");
			await seedMixedSession(root);

			const replaced = await writeSourceSnapshot(
				root,
				["User: another question", "Assistant: another answer", "User: second question"],
				true,
			);

			expect(replaced).toBeNull();
			expect(readSessionRecords(canonicalTranscriptPath(root, "claude-code"))).toEqual([
				["user", "first question", "jsonl"],
				["assistant", "first answer", "jsonl"],
				["user", "second question", "live"],
			]);
		});
	});

	test("an append after a crash-torn record drops the torn tail instead of corrupting the new records", async () => {
		const root = makeRoot("snapshot-append-torn-tail");
		const jsonlPath = canonicalTranscriptPath(root, "memorybench");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "agent-0",
			harness: "memorybench",
			sessionKey: "session-a",
			sourceFormat: "normalized",
			transcript: "User: first\nAssistant: reply",
		});
		const intact = readFileSync(jsonlPath, "utf8");
		writeFileSync(jsonlPath, `${intact}{"session_key":"session-torn","seq":1,"ro`, "utf8");

		const written = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "agent-0",
			harness: "memorybench",
			sessionKey: "session-b",
			sourceFormat: "normalized",
			transcript: "User: second\nAssistant: reply two",
		});

		expect(written).toHaveLength(2);
		const after = readFileSync(jsonlPath, "utf8");
		expect(after.startsWith(intact)).toBe(true);
		const lines = after.split("\n").filter((line) => line.trim().length > 0);
		const parsed = lines.map((line) => JSON.parse(line) as { session_key: string });
		expect(parsed.map((r) => r.session_key)).toEqual(["session-a", "session-a", "session-b", "session-b"]);
		await expect(readCanonicalTranscriptSessionKeys({ basePath: root, harness: "memorybench" })).resolves.toBeDefined();
	});

	test("writeCanonicalTranscriptSnapshot appends a new session in place instead of rewriting the file", async () => {
		const root = makeRoot("snapshot-append-new-session");
		const jsonlPath = canonicalTranscriptPath(root, "memorybench");
		for (let s = 0; s < 50; s++) {
			await writeCanonicalTranscriptSnapshot({
				basePath: root,
				agentId: `agent-${s % 5}`,
				harness: "memorybench",
				sessionKey: `session-${s}`,
				sourceFormat: "normalized",
				transcript: `User: prompt ${s}\nAssistant: reply ${s}`,
			});
		}
		const before = readFileSync(jsonlPath, "utf8");
		const inodeBefore = statSync(jsonlPath).ino;

		const written = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "agent-0",
			harness: "memorybench",
			sessionKey: "session-new",
			sourceFormat: "normalized",
			transcript: "User: new prompt\nAssistant: new reply",
		});

		expect(written).toHaveLength(2);
		expect(statSync(jsonlPath).ino).toBe(inodeBefore);
		const after = readFileSync(jsonlPath, "utf8");
		expect(after.startsWith(before)).toBe(true);
		const added = after
			.slice(before.length)
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { session_key: string; seq: number; role: string; content: string });
		expect(added.map((r) => [r.session_key, r.seq, r.role, r.content])).toEqual([
			["session-new", 1, "user", "new prompt"],
			["session-new", 2, "assistant", "new reply"],
		]);

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "agent-0",
			harness: "memorybench",
			sessionKey: "session-new",
			sourceFormat: "normalized",
			transcript: "User: new prompt\nAssistant: new reply\nUser: follow-up",
		});
		expect(replaced).toHaveLength(3);
		const records = readFileSync(jsonlPath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { session_key: string; content: string });
		expect(records.filter((r) => r.session_key === "session-new").map((r) => r.content)).toEqual([
			"new prompt",
			"new reply",
			"follow-up",
		]);
		expect(records).toHaveLength(103);
	});

	test("refuses a whitespace-poorer source for a completed session in the current format", async () => {
		const root = makeRoot("current-format-whitespace");
		const sourcePath = join(root, "session.jsonl");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			transcript: 'User: run {\n    "a": 1\n}  please\nAssistant: done',
		});

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: 'User: run { "a": 1 } please\nAssistant: done\nUser: one more turn',
		});

		expect(replaced).toBeNull();
		const records = readFileSync(canonicalTranscriptPath(root, "claude-code"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { content: string });
		expect(records.map((record) => record.content)).toEqual(['run {\n    "a": 1\n}  please', "done"]);
	});

	test.each([false, true])("restores legacy whitespace with appended source turns: %s", async (extend) => {
		const root = makeRoot("extend-legacy-whitespace");
		const sourcePath = join(root, "session.jsonl");
		const jsonlPath = writeLegacyRecords(root, sourcePath, [
			["user", 'run { "a": 1 } please'],
			["unknown", "then report"],
			["assistant", "done"],
		]);
		const replacements: Array<[number, number]> = [];
		const expected = [' run  {  "a": 1 }\tplease  \nthen  report', "done", ...(extend ? ["one more turn"] : [])];

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: `User:  run  {  "a": 1 }\tplease  \nthen  report\nAssistant: done${extend ? "\nUser: one more turn" : ""}`,
			onLegacySessionReplaced: (legacyTurns, sourceTurns) => {
				replacements.push([legacyTurns, sourceTurns]);
				expect(readSessionRecords(jsonlPath).map(([, content]) => content)).toEqual(expected);
			},
		});

		expect(replaced).not.toBeNull();
		expect(replacements).toEqual([[3, extend ? 3 : 2]]);
		const records = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { content: string });
		expect(records.map((record) => record.content)).toEqual(expected);
	});

	test("notifies legacy replacement only after asynchronous directory sync", async () => {
		const root = makeRoot("legacy-directory-sync");
		const sourcePath = join(root, "session.jsonl");
		const path = writeLegacyRecords(root, sourcePath, [
			["user", "question"],
			["unknown", "second line"],
			["assistant", "answer"],
		]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const replacements: Array<[number, number]> = [];
		const open = fs.open;
		const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
			const handle = await open(...args);
			if (args[0] === dirname(path)) {
				const sync = handle.sync.bind(handle);
				spyOn(handle, "sync").mockImplementation(async () => {
					entered.resolve();
					await release.promise;
					await sync();
				});
			}
			return handle;
		});
		const writing = writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: "User: question\nsecond line\nAssistant: answer",
			onLegacySessionReplaced: (legacyTurns, sourceTurns) => replacements.push([legacyTurns, sourceTurns]),
		});
		try {
			await Promise.race([
				entered.promise,
				writing.then(() => {
					throw new Error("Snapshot completed before its directory sync");
				}),
			]);
			expect(readSessionRecords(path).map(([, content]) => content)).toEqual(["question\nsecond line", "answer"]);
			expect(replacements).toEqual([]);
			release.resolve();
			expect(await writing).toHaveLength(2);
			expect(replacements).toEqual([[3, 2]]);
		} finally {
			release.resolve();
			try {
				await writing;
			} finally {
				opening.mockRestore();
			}
		}
	});

	test("keeps the exact comparison for collapsed one-line records without a split continuation line", async () => {
		const root = makeRoot("legacy-layout-unproven");
		const sourcePath = join(root, "session.jsonl");
		const jsonlPath = writeLegacyRecords(root, sourcePath, [
			["user", "A"],
			["assistant", "B"],
		]);

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: "User: A\n  Assistant: B\nUser: C",
		});

		expect(replaced).toBeNull();
		const records = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { role: string; content: string });
		expect(records.map((record) => [record.role, record.content])).toEqual([
			["user", "A"],
			["assistant", "B"],
		]);
	});

	test("preserves whitespace-only stored turns when the source omits them", async () => {
		const root = makeRoot("whitespace-only-stored-turn");
		const sourcePath = join(root, "session.jsonl");
		const jsonlPath = writeLegacyRecords(root, sourcePath, [
			["user", "A"],
			["unknown", "second line"],
			["assistant", " "],
			["user", "B"],
		]);
		const original = readFileSync(jsonlPath, "utf8");

		expect(await writeSourceSnapshot(root, ["User: A", "second line", "User: B"], true)).toBeNull();
		expect(readFileSync(jsonlPath, "utf8")).toBe(original);
	});

	test("still preserves a completed session when the replacement differs beyond whitespace", async () => {
		const root = makeRoot("legacy-whitespace-real-divergence");
		const sourcePath = join(root, "session.jsonl");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			transcript: "User: run it please\nAssistant: done",
		});

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: "User: run  it  now\nAssistant: done\nUser: one more turn",
		});

		expect(replaced).toBeNull();
		expect(readFileSync(canonicalTranscriptPath(root, "claude-code"), "utf8")).toContain('"content":"run it please"');
	});

	function writeLegacyRecords(root: string, sourcePath: string, turns: ReadonlyArray<[string, string]>): string {
		const jsonlPath = canonicalTranscriptPath(root, "claude-code");
		mkdirSync(dirname(jsonlPath), { recursive: true });
		const lines = turns.map(([role, content], index) =>
			JSON.stringify({
				schema: "signet.transcript.v1",
				captured_at: "2026-09-01T00:00:00.000Z",
				agent_id: "default",
				harness: "claude-code",
				session_key: "session-1",
				session_id: "session-1",
				project: null,
				seq: index + 1,
				role,
				content,
				source_format: "jsonl",
				source_path: sourcePath,
			}),
		);
		writeFileSync(jsonlPath, `${lines.join("\n")}\n`);
		return jsonlPath;
	}

	test("extends a completed session stored with legacy one-line turns", async () => {
		const root = makeRoot("extend-legacy-line-turns");
		const sourcePath = join(root, "session.jsonl");
		const jsonlPath = writeLegacyRecords(root, sourcePath, [
			["user", "run the checks"],
			["unknown", "System: hook ok"],
			["unknown", "then report"],
			["assistant", "done"],
		]);

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: "User: run  the checks\nSystem: hook ok\n\nthen report\nAssistant: done\nUser: one more turn",
		});

		expect(replaced).not.toBeNull();
		const records = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { role: string; content: string });
		expect(records.map((record) => record.role)).toEqual(["user", "assistant", "user"]);
		expect(records[0]?.content).toBe("run  the checks\nSystem: hook ok\n\nthen report");
	});

	test("still preserves legacy one-line turns when the replacement differs in content", async () => {
		const root = makeRoot("legacy-line-turns-real-divergence");
		const sourcePath = join(root, "session.jsonl");
		const jsonlPath = writeLegacyRecords(root, sourcePath, [
			["user", "run the checks"],
			["unknown", "then report"],
			["assistant", "done"],
		]);

		const replaced = await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "claude-code",
			sessionKey: "session-1",
			sourceFormat: "jsonl",
			sourcePath,
			preserveExistingSession: true,
			transcript: "User: run the checks\nthen skip the report\nAssistant: done\nUser: one more turn",
		});

		expect(replaced).toBeNull();
		expect(readFileSync(jsonlPath, "utf8")).toContain('"content":"then report"');
	});

	test("writeCanonicalTranscriptSnapshot handles large files without excessive memory (OOM guard)", async () => {
		const root = makeRoot("snapshot-oom-guard");
		const jsonlPath = canonicalTranscriptPath(root, "opencode");
		mkdirSync(dirname(jsonlPath), { recursive: true });
		const lines: string[] = [];
		for (let s = 0; s < 200; s++) {
			for (let t = 0; t < 10; t++) {
				lines.push(
					JSON.stringify({
						schema: "signet.transcript.v1",
						id: `pre-${s}-${t}`,
						captured_at: "2026-04-01T00:00:00.000Z",
						agent_id: "default",
						harness: "opencode",
						session_key: `session-${s}`,
						session_id: `session-${s}`,
						project: null,
						seq: t + 1,
						role: t % 2 === 0 ? "user" : "assistant",
						content: `Turn ${t} of session ${s} with padding ${"x".repeat(500)}`,
						source_format: "normalized",
						source_sha256: `sha-${s}-${t}`,
					}),
				);
			}
		}
		writeFileSync(jsonlPath, `${lines.join("\n")}\n`, "utf8");

		const sizeBefore = statSync(jsonlPath).size;
		expect(sizeBefore).toBeGreaterThan(1_000_000);
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "opencode",
			sessionKey: "session-50",
			sourceFormat: "normalized",
			transcript: "User: replaced prompt\nAssistant: replaced reply",
		});

		const content = readFileSync(jsonlPath, "utf8");
		const records = content
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as { session_key: string; content: string });
		const session50 = records.filter((r) => r.session_key === "session-50");
		expect(session50.length).toBe(2);
		expect(session50[0]?.content).toBe("replaced prompt");
		expect(session50[1]?.content).toBe("replaced reply");
		const session0 = records.filter((r) => r.session_key === "session-0");
		expect(session0.length).toBe(10);

		const session199 = records.filter((r) => r.session_key === "session-199");
		expect(session199.length).toBe(10);
		expect(records.length).toBe(1992);
	});

	test("writeCanonicalTranscriptSnapshot overwrites stale temp file from prior crash", async () => {
		const root = makeRoot("snapshot-stale-tmp");
		const jsonlPath = canonicalTranscriptPath(root, "opencode");
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "opencode",
			sessionKey: "existing-session",
			sourceFormat: "live",
			turns: [
				{ role: "user", content: "existing prompt" },
				{ role: "assistant", content: "existing reply" },
			],
		});
		const staleTmp = `${jsonlPath}.snapshot-tmp`;
		writeFileSync(staleTmp, "corrupted partial write\n", "utf8");
		expect(existsSync(staleTmp)).toBe(true);
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "opencode",
			sessionKey: "new-session",
			sourceFormat: "normalized",
			transcript: "User: new prompt\nAssistant: new reply",
		});
		expect(existsSync(staleTmp)).toBe(false);
		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain("existing prompt");
		expect(content).toContain("new prompt");
		expect(content).toContain("new reply");
	});
});

describe("backfill replaces live-only sessions", () => {
	function writeTranscriptArtifact(params: {
		readonly root: string;
		readonly fileName: string;
		readonly agentId?: string;
		readonly harness?: string;
		readonly sessionKey: string;
		readonly sessionId?: string;
		readonly capturedAt?: string;
		readonly transcript: string;
	}): void {
		const artifact = join(params.root, "memory", params.fileName);
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(
			artifact,
			[
				"---",
				'kind: "transcript"',
				`agent_id: ${JSON.stringify(params.agentId || "default")}`,
				`harness: ${JSON.stringify(params.harness || "codex")}`,
				`session_key: ${JSON.stringify(params.sessionKey)}`,
				`session_id: ${JSON.stringify(params.sessionId || params.sessionKey)}`,
				`captured_at: ${JSON.stringify(params.capturedAt || "2026-04-28T00:00:00.000Z")}`,
				"---",
				params.transcript,
				"",
			].join("\n"),
			"utf8",
		);
	}

	function readJsonlLines(root: string): Array<{
		readonly session_key: string | null;
		readonly source_format: string;
		readonly content: string;
	}> {
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		return readFileSync(jsonlPath, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map(
				(line) =>
					JSON.parse(line) as {
						readonly session_key: string | null;
						readonly source_format: string;
						readonly content: string;
					},
			);
	}

	function initTranscriptDb(root: string): void {
		initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
		getSyncDbAccessor().withWriteTx((db) => {
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
		});
	}

	test("markdown backfill replaces live-only session with fuller artifact data", async () => {
		const root = makeRoot("backfill-live-replace");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "live-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "partial live prompt" }],
		});

		writeTranscriptArtifact({
			root,
			fileName: "2026-04-29T00-00-00Z--livesession000000--transcript.md",
			sessionKey: "live-session",
			transcript: "User: fuller migrated prompt\nAssistant: fuller migrated reply",
		});

		await ensureCanonicalTranscriptHistory(root, "default");

		const lines = readJsonlLines(root);
		expect(lines.some((line) => line.session_key === "live-session" && line.source_format === "live")).toBe(false);
		expect(lines.some((line) => line.session_key === "live-session" && line.source_format === "markdown")).toBe(true);
		expect(
			lines.some((line) => line.session_key === "live-session" && line.content.includes("fuller migrated reply")),
		).toBe(true);
		expect(
			lines.some((line) => line.session_key === "live-session" && line.content.includes("partial live prompt")),
		).toBe(false);
	});

	test("does not duplicate a session when DB backfill follows markdown live-only promotion", async () => {
		const root = makeRoot("backfill-markdown-db-same-session");
		initTranscriptDb(root);

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "shared-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "partial live prompt" }],
		});

		writeTranscriptArtifact({
			root,
			fileName: "2026-04-29T00-00-00Z--sharedsession000--transcript.md",
			sessionKey: "shared-session",
			transcript: "User: markdown prompt\nAssistant: markdown reply",
		});

		getSyncDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					`INSERT INTO session_transcripts (
							session_key, content, harness, project, agent_id, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"shared-session",
					"User: db prompt\nAssistant: db reply",
					"codex",
					null,
					"default",
					"2026-04-29T00:01:00.000Z",
					"2026-04-29T00:01:00.000Z",
				),
		);

		await ensureCanonicalTranscriptHistory(root, "default");

		const lines = readJsonlLines(root).filter((line) => line.session_key === "shared-session");
		expect(lines).toHaveLength(2);
		expect(lines.every((line) => line.source_format === "markdown")).toBe(true);
		expect(lines.some((line) => line.content.includes("markdown reply"))).toBe(true);
		expect(lines.some((line) => line.content.includes("db reply"))).toBe(false);
		expect(lines.some((line) => line.source_format === "live")).toBe(false);
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
	});

	test("canonical sessions are not replaced during backfill", async () => {
		const root = makeRoot("backfill-canonical-untouched");

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "canonical-session",
			sourceFormat: "db",
			transcript: "User: canonical source\nAssistant: canonical source reply",
		});
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "live-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "live only content" }],
		});

		writeTranscriptArtifact({
			root,
			fileName: "2026-04-29T00-00-00Z--canon-session0000--transcript.md",
			sessionKey: "canonical-session",
			transcript: "User: markdown should not replace canonical\nAssistant: markdown should not replace canonical",
		});
		writeTranscriptArtifact({
			root,
			fileName: "2026-04-29T00-00-00Z--live-session00000--transcript.md",
			sessionKey: "live-session",
			transcript: "User: markdown replacement for live\nAssistant: markdown replacement reply",
		});

		await ensureCanonicalTranscriptHistory(root, "default");

		const lines = readJsonlLines(root);
		expect(
			lines.some((line) => line.session_key === "canonical-session" && line.content.includes("canonical source reply")),
		).toBe(true);
		expect(
			lines.some(
				(line) =>
					line.session_key === "canonical-session" && line.content.includes("markdown should not replace canonical"),
			),
		).toBe(false);
		expect(lines.some((line) => line.session_key === "live-session" && line.source_format === "live")).toBe(false);
		expect(
			lines.some((line) => line.session_key === "live-session" && line.content.includes("markdown replacement reply")),
		).toBe(true);
	});

	test("reports divergent completed JSONL and Markdown without settling the backfill marker", async () => {
		const root = makeRoot("diagnose-markdown-divergence");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "diagnostic-session",
			sourceFormat: "normalized",
			transcript: "User: canonical prompt\nAssistant: canonical reply",
		});
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--diagnosticsession--transcript.md",
			sessionKey: "diagnostic-session",
			transcript: "User: legacy prompt\nAssistant: legacy reply",
		});
		await ensureCanonicalTranscriptHistory(root, "default");
		const jsonl = readFileSync(canonicalTranscriptPath(root, "codex"), "utf8");
		expect(jsonl).toContain("canonical reply");
		expect(jsonl).not.toContain("legacy reply");
		expect(
			readFileSync(join(root, "memory", "2026-09-20T00-00-00Z--diagnosticsession--transcript.md"), "utf8"),
		).toContain("legacy reply");
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
	});

	test("defers retries of an incomplete backfill with bounded backoff", async () => {
		const root = makeRoot("deferred-backfill-retry");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "deferred-session",
			sourceFormat: "normalized",
			transcript: "User: canonical prompt\nAssistant: canonical reply",
		});
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--deferred-session--transcript.md",
			sessionKey: "deferred-session",
			transcript: "User: legacy prompt\nAssistant: legacy reply",
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
		const passes = () =>
			warn.mock.calls.filter(([, message]) => message === "Divergent completed transcript representation retained")
				.length;
		try {
			await Promise.all([
				ensureCanonicalTranscriptHistory(root, "default"),
				ensureCanonicalTranscriptHistory(root, "default"),
				ensureCanonicalTranscriptHistory(root, "default"),
			]);
			expect(passes()).toBe(1);
			expect(warn).toHaveBeenCalledWith(
				"transcripts",
				"Canonical transcript backfill incomplete; retry deferred",
				expect.objectContaining({ markdownFailures: 1, attempts: 1, retryInMs: 60_000 }),
			);

			await ensureCanonicalTranscriptHistory(root, "default");
			setSystemTime(new Date(Date.now() + 59_000));
			await ensureCanonicalTranscriptHistory(root, "default");
			expect(passes()).toBe(1);

			setSystemTime(new Date(Date.now() + 2_000));
			await ensureCanonicalTranscriptHistory(root, "default");
			expect(passes()).toBe(2);
			expect(warn).toHaveBeenCalledWith(
				"transcripts",
				"Canonical transcript backfill incomplete; retry deferred",
				expect.objectContaining({ attempts: 2, retryInMs: 120_000 }),
			);
		} finally {
			warn.mockRestore();
		}
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
	});

	test("does not settle backfill against incomplete canonical turn records", async () => {
		const root = makeRoot("incomplete-completed-jsonl");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "incomplete-session",
			sourceFormat: "normalized",
			transcript: "User: original prompt",
		});
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const record = JSON.parse(readFileSync(jsonlPath, "utf8")) as Record<string, unknown>;
		Reflect.deleteProperty(record, "role");
		const incomplete = `${JSON.stringify(record)}\n`;
		writeFileSync(jsonlPath, incomplete);
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--incomplete-session--transcript.md",
			sessionKey: "incomplete-session",
			transcript: "User: alternate prompt",
		});
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(readFileSync(jsonlPath, "utf8")).toBe(incomplete);
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
		record.role = "user";
		writeFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--incomplete-session--transcript.md",
			sessionKey: "incomplete-session",
			transcript: "User: original prompt",
		});
		advancePastBackfillRetry();
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(true);
	});

	test("does not settle backfill against duplicate canonical sequence numbers", async () => {
		const root = makeRoot("duplicate-completed-seq");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "sequence-session",
			sourceFormat: "normalized",
			transcript: "User: question\nAssistant: reply",
		});
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const records = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const reply = records[1];
		if (!reply) throw new Error("Expected a completed reply turn");
		reply.seq = 1;
		const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		writeFileSync(jsonlPath, original);
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--sequence-session--transcript.md",
			sessionKey: "sequence-session",
			transcript: "User: question\nAssistant: reply",
		});
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(readFileSync(jsonlPath, "utf8")).toBe(original);
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
	});

	test("scoped backfill rejects a foreign agent's duplicate canonical sequence", async () => {
		const root = makeRoot("foreign-duplicate-seq");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "agent-two",
			harness: "codex",
			sessionKey: "foreign-session",
			sourceFormat: "normalized",
			transcript: "User: foreign question\nAssistant: foreign reply",
		});
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const records = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const reply = records[1];
		if (!reply) throw new Error("Expected a foreign reply turn");
		reply.seq = 1;
		const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		writeFileSync(jsonlPath, original);
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--default-session--transcript.md",
			sessionKey: "default-session",
			transcript: "User: default prompt\nAssistant: default reply",
		});
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(readFileSync(jsonlPath, "utf8")).toBe(original);
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
	});

	test("backfills one agent's DB transcripts without paging through every other agent's rows", async () => {
		const root = makeRoot("agent-scoped-db-backfill");
		initTranscriptDb(root);
		getSyncDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			const insert = db.prepare(
				`INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			);
			for (let i = 0; i < 1_000; i++) {
				insert.run(
					`other-${i}`,
					`User: other ${i}`,
					"codex",
					null,
					`other-agent-${i % 10}`,
					"2026-09-20",
					"2026-09-20",
				);
			}
			insert.run(
				"mine",
				"User: my question\nAssistant: my reply",
				"codex",
				null,
				"agent-a",
				"2026-09-20",
				"2026-09-20",
			);
		});
		const accessor = getSyncDbAccessor();
		const reads = spyOn(accessor, "withReadDb");
		try {
			await ensureCanonicalTranscriptHistory(root, "agent-a");
			expect(reads.mock.calls.length).toBeLessThan(5);
		} finally {
			reads.mockRestore();
		}
		const records = readFileSync(canonicalTranscriptPath(root, "codex"), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { agent_id: string; session_key: string; content: string });
		expect(records.map((r) => [r.agent_id, r.session_key, r.content])).toEqual([
			["agent-a", "mine", "my question"],
			["agent-a", "mine", "my reply"],
		]);
	});

	test("reports reordered completed DB turns without settling the backfill marker", async () => {
		const root = makeRoot("diagnose-db-divergence");
		initTranscriptDb(root);
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "db-diagnostic-session",
			sourceFormat: "normalized",
			transcript: "User: question\nAssistant: reply",
		});
		getSyncDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) =>
			db
				.prepare(
					`INSERT INTO session_transcripts (session_key, content, harness, project, agent_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"db-diagnostic-session",
					"Assistant: reply\nUser: question",
					"codex",
					null,
					"default",
					"2026-09-20",
					"2026-09-20",
				),
		);
		const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			await ensureCanonicalTranscriptHistory(root, "default");
			expect(warn).toHaveBeenCalledWith(
				"transcripts",
				"Divergent completed transcript representation retained",
				expect.objectContaining({ sessionKey: "db-diagnostic-session", sourceFormat: "db" }),
			);
		} finally {
			warn.mockRestore();
		}
		const jsonl = readFileSync(canonicalTranscriptPath(root, "codex"), "utf8");
		expect(jsonl).toContain("question");
		expect(jsonl).toContain("reply");
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(false);
	});

	test("accepts equivalent completed JSONL and Markdown without appending duplicate turns", async () => {
		const root = makeRoot("equivalent-completed-markdown");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "matching-session",
			sourceFormat: "normalized",
			transcript: "User: question\nAssistant: reply",
		});
		writeTranscriptArtifact({
			root,
			fileName: "2026-09-20T00-00-00Z--matching-session--transcript.md",
			sessionKey: "matching-session",
			transcript: "User: question\nAssistant: reply",
		});
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(readJsonlLines(root).filter((line) => line.session_key === "matching-session")).toHaveLength(2);
		expect(existsSync(join(root, "memory", ".canonical-transcript-backfill-v1.default"))).toBe(true);
	});

	test("new sessions still appended normally", async () => {
		const root = makeRoot("backfill-new-append");

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "existing-session",
			sourceFormat: "db",
			transcript: "User: existing canonical\nAssistant: existing reply",
		});

		writeTranscriptArtifact({
			root,
			fileName: "2026-04-29T00-00-00Z--new-session0000000--transcript.md",
			sessionKey: "new-session",
			transcript: "User: new markdown prompt\nAssistant: new markdown reply",
		});

		await ensureCanonicalTranscriptHistory(root, "default");

		const lines = readJsonlLines(root);
		expect(
			lines.some((line) => line.session_key === "existing-session" && line.content.includes("existing reply")),
		).toBe(true);
		expect(
			lines.some((line) => line.session_key === "new-session" && line.content.includes("new markdown reply")),
		).toBe(true);
	});

	test("handles many live-only sessions without full-file parse (OOM guard)", async () => {
		const root = makeRoot("backfill-oom-guard");
		const memDir = join(root, "memory");
		for (let i = 0; i < 50; i++) {
			await writeCanonicalTranscriptSnapshot({
				basePath: root,
				agentId: "default",
				harness: "codex",
				sessionKey: `canonical-${i}`,
				sourceFormat: "normalized",
				transcript: `User: canonical prompt ${i} ${"x".repeat(200)}\nAssistant: canonical reply ${i} ${"y".repeat(200)}`,
			});
		}
		for (let i = 0; i < 20; i++) {
			await appendCanonicalTranscriptTurns({
				basePath: root,
				agentId: "default",
				harness: "codex",
				sessionKey: `live-${i}`,
				sessionId: `live-${i}`,
				sourceFormat: "live",
				turns: [
					{ role: "user", content: `live prompt ${i}` },
					{ role: "assistant", content: `live reply ${i}` },
				],
			});
		}
		mkdirSync(memDir, { recursive: true });
		for (let i = 0; i < 20; i++) {
			writeFileSync(
				join(memDir, `2026-04-29T00-00-00Z--oomguard${String(i).padStart(6, "0")}--transcript.md`),
				[
					"---",
					'kind: "transcript"',
					'agent_id: "default"',
					'harness: "codex"',
					`session_key: "live-${i}"`,
					`session_id: "live-${i}"`,
					`captured_at: "2026-04-29T00:00:${String(i).padStart(2, "0")}.000Z"`,
					"---",
					`User: full prompt ${i}`,
					`Assistant: full reply ${i}`,
					`User: follow-up ${i}`,
					`Assistant: follow-up reply ${i}`,
					"",
				].join("\n"),
				"utf8",
			);
		}

		await ensureCanonicalTranscriptHistory(root, "default");

		const jsonlPath = join(memDir, "codex", "transcripts", "transcript.jsonl");
		const content = readFileSync(jsonlPath, "utf8");
		for (let i = 0; i < 20; i++) {
			expect(content).not.toContain(`live prompt ${i}`);
			expect(content).toContain(`full prompt ${i}`);
			expect(content).toContain(`follow-up ${i}`);
		}
		for (let i = 0; i < 50; i++) {
			expect(content).toContain(`canonical prompt ${i}`);
		}
		expect(existsSync(join(memDir, ".canonical-transcript-backfill-v1.default"))).toBe(true);
	});
});

describe("readCanonicalTranscriptSessionKeys classification", () => {
	test("classifies canonical and live-only sessions separately", async () => {
		const root = makeRoot("classify-separate");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "partial live turn" }],
		});

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-2",
			sourceFormat: "db",
			transcript: "User: canonical prompt\nAssistant: canonical reply",
		});

		const { canonicalKeys, liveOnlyKeys } = await readCanonicalTranscriptSessionKeys({
			basePath: root,
			harness: "codex",
			agentId: "default",
		});

		expect(canonicalKeys.size).toBe(1);
		expect(liveOnlyKeys.size).toBe(1);
		for (const key of canonicalKeys) {
			expect(liveOnlyKeys.has(key)).toBe(false);
		}
	});

	test("promotes session to canonical when it has both live and non-live records", async () => {
		const root = makeRoot("classify-promote");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "live partial" }],
		});

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			transcript: "User: canonical final\nAssistant: canonical reply",
		});

		const { canonicalKeys, liveOnlyKeys } = await readCanonicalTranscriptSessionKeys({
			basePath: root,
			harness: "codex",
			agentId: "default",
		});

		expect(canonicalKeys.size).toBe(1);
		expect(liveOnlyKeys.size).toBe(0);
	});

	test("returns empty sets for nonexistent file", async () => {
		const root = makeRoot("classify-empty");
		const { canonicalKeys, liveOnlyKeys } = await readCanonicalTranscriptSessionKeys({
			basePath: root,
			harness: "codex",
			agentId: "default",
		});

		expect(canonicalKeys.size).toBe(0);
		expect(liveOnlyKeys.size).toBe(0);
	});

	test("reports only completed sessions written in the legacy line layout", async () => {
		const root = makeRoot("classify-legacy-shape");
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "live-session",
			sourceFormat: "live",
			turns: [{ role: "user", content: "partial live turn" }],
		});
		for (const [sessionKey, transcript] of [
			["shaped-session", "User: canonical prompt\nAssistant: canonical reply"],
			["rich-session", "User:  canonical   prompt\nAssistant: canonical\treply"],
			["multiline-session", "User: canonical prompt\nsecond line\nAssistant: canonical reply"],
		] as const) {
			await writeCanonicalTranscriptSnapshot({
				basePath: root,
				agentId: "default",
				harness: "codex",
				sessionKey,
				sourceFormat: "db",
				transcript,
			});
		}
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const legacyLines = (
			[
				["user", "canonical prompt"],
				["unknown", "second line"],
				["assistant", "canonical reply"],
			] as const
		).map(([role, content], index) =>
			JSON.stringify({
				schema: "signet.transcript.v1",
				captured_at: "2026-09-01T00:00:00.000Z",
				agent_id: "default",
				harness: "codex",
				session_key: "legacy-session",
				session_id: "legacy-session",
				project: null,
				seq: index + 1,
				role,
				content,
				source_format: "db",
				source_sha256: "legacy",
			}),
		);
		writeFileSync(jsonlPath, `${readFileSync(jsonlPath, "utf8")}${legacyLines.join("\n")}\n`);

		const { canonicalKeys, legacyLayoutKeys } = await readCanonicalTranscriptSessionKeys({
			basePath: root,
			harness: "codex",
			agentId: "default",
		});

		expect(canonicalKeys.size).toBe(4);
		expect([...legacyLayoutKeys]).toEqual([
			sessionSeqCacheKey({ agentId: "default", harness: "codex", sessionKey: "legacy-session", sourceFormat: "db" }),
		]);
	});
});

describe("legacy transcript reader", () => {
	test("reads a source the way the legacy writer split and collapsed it", () => {
		expect(
			legacyTranscriptTurns("User:  legacy   prompt\n  with  a second line\n\nAssistant: reply\twith  spaces  "),
		).toEqual([
			{ role: "user", content: "legacy prompt" },
			{ role: "unknown", content: "with a second line" },
			{ role: "assistant", content: "reply with spaces" },
		]);
	});

	test("reads an indented role label the way the legacy writer did", () => {
		expect(legacyTranscriptTurns("  User: hello\n\tAssistant: hi")).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		]);
	});

	test("recognizes the legacy layout only from a split continuation line", () => {
		const split = { role: "unknown", content: "second line" } as const;
		expect(isLegacyLayoutSession([{ role: "user", content: "legacy prompt" }, split])).toBe(true);
		expect(isLegacyLayoutSession([{ role: "user", content: "legacy prompt" }])).toBe(false);
		expect(isLegacyLayoutSession([split, { role: "user", content: "legacy prompt" }])).toBe(false);
		expect(isLegacyLayoutSession([{ role: "user", content: "legacy  prompt" }, split])).toBe(false);
		expect(isLegacyLayoutSession([{ role: "user", content: "legacy\nprompt" }, split])).toBe(false);
		expect(isLegacyLayoutSession([{ role: "user", content: " legacy prompt" }, split])).toBe(false);
		expect(isLegacyLayoutSession([])).toBe(false);
	});
});

describe("rewriteReplacingLiveOnlySessions", () => {
	test("replaces live-only session with fuller data and preserves canonical sessions", async () => {
		const root = makeRoot("rewrite-replace");
		const jsonlPath = canonicalTranscriptPath(root, "codex");

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-a",
			sourceFormat: "db",
			transcript: "User: A prompt\nAssistant: A reply",
		});
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-b",
			sourceFormat: "live",
			turns: [{ role: "user", content: "B partial" }],
		});
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-c",
			sourceFormat: "db",
			transcript: "User: C prompt\nAssistant: C reply",
		});

		const sessionBIdentity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-b",
			sourceFormat: "db" as const,
		};
		const replaced = await rewriteReplacingLiveOnlySessions(
			jsonlPath,
			new Map([
				[
					sessionSeqCacheKey(sessionBIdentity),
					{ identity: sessionBIdentity, transcript: "User: B canonical\nAssistant: B reply" },
				],
			]),
		);

		expect(replaced).toBe(1);
		const lines = readFileSync(jsonlPath, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map(
				(line) =>
					JSON.parse(line) as {
						readonly session_key: string | null;
						readonly source_format: string;
						readonly content: string;
					},
			);

		expect(lines.some((line) => line.session_key === "session-a" && line.content.includes("A prompt"))).toBe(true);
		expect(lines.some((line) => line.session_key === "session-c" && line.content.includes("C prompt"))).toBe(true);
		expect(lines.some((line) => line.session_key === "session-b" && line.source_format === "live")).toBe(false);
		expect(lines.some((line) => line.session_key === "session-b" && line.content.includes("B canonical"))).toBe(true);
		expect(lines.filter((line) => line.session_key === "session-b").every((line) => line.source_format === "db")).toBe(
			true,
		);
	});

	test("preserves chronological file order after replacement", async () => {
		const root = makeRoot("rewrite-order");
		const jsonlPath = canonicalTranscriptPath(root, "codex");

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-a",
			sourceFormat: "db",
			transcript: "User: A one",
		});
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-b",
			sourceFormat: "live",
			turns: [{ role: "user", content: "B only" }],
		});
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-c",
			sourceFormat: "db",
			transcript: "User: C one",
		});

		const sessionBIdentity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-b",
			sourceFormat: "db" as const,
		};
		await rewriteReplacingLiveOnlySessions(
			jsonlPath,
			new Map([
				[
					sessionSeqCacheKey(sessionBIdentity),
					{ identity: sessionBIdentity, transcript: "User: B canonical\nAssistant: B two" },
				],
			]),
		);

		const lines = readFileSync(jsonlPath, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { readonly session_key: string | null; readonly source_format: string });

		const firstA = lines.findIndex((line) => line.session_key === "session-a");
		const firstB = lines.findIndex((line) => line.session_key === "session-b");
		const firstC = lines.findIndex((line) => line.session_key === "session-c");
		expect(firstA).toBeGreaterThanOrEqual(0);
		expect(firstB).toBeGreaterThanOrEqual(0);
		expect(firstC).toBeGreaterThanOrEqual(0);
		expect(firstA).toBeLessThan(firstB);
		expect(firstB).toBeLessThan(firstC);
		expect(lines.filter((line) => line.session_key === "session-b").every((line) => line.source_format === "db")).toBe(
			true,
		);
	});

	test("overwrites stale rewrite-tmp file from interrupted previous rewrite", async () => {
		const root = makeRoot("rewrite-stale-tmp");
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "partial stale" }],
		});

		const tmpPath = `${jsonlPath}.rewrite-tmp`;
		writeFileSync(tmpPath, "stale interrupted rewrite", "utf8");

		const identity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db" as const,
		};
		const replaced = await rewriteReplacingLiveOnlySessions(
			jsonlPath,
			new Map([
				[sessionSeqCacheKey(identity), { identity, transcript: "User: complete one\nAssistant: complete two" }],
			]),
		);

		expect(replaced).toBe(1);
		const content = readFileSync(jsonlPath, "utf8");
		expect(content).not.toContain("stale interrupted rewrite");
		expect(content).toContain("complete one");
		expect(existsSync(tmpPath)).toBe(false);
	});

	test("returns 0 for empty replacements map", async () => {
		const root = makeRoot("rewrite-empty-map");
		const jsonlPath = canonicalTranscriptPath(root, "codex");
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-empty",
			sourceFormat: "live",
			turns: [{ role: "user", content: "keep me" }],
		});

		const before = readFileSync(jsonlPath, "utf8");
		const replaced = await rewriteReplacingLiveOnlySessions(jsonlPath, new Map());
		const after = readFileSync(jsonlPath, "utf8");

		expect(replaced).toBe(0);
		expect(after).toBe(before);
	});

	test("preserves non-live records for a replaced session key", async () => {
		const root = makeRoot("rewrite-preserve-nonlive");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "live turn one" }],
		});

		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			transcript: "User: canonical turn\nAssistant: canonical reply",
		});

		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const identity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db" as const,
		};
		const key = sessionSeqCacheKey(identity);
		const replacements = new Map([[key, { identity, transcript: "User: db replacement\nAssistant: db reply" }]]);

		await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);

		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain("canonical turn");
		expect(content).toContain("canonical reply");
		expect(content).not.toContain("db replacement");
	});

	test("healed session does not clobber seq cache with replacement turn count", async () => {
		const root = makeRoot("rewrite-healed-seq");
		await writeCanonicalTranscriptSnapshot({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			transcript: [
				"User: turn one",
				"Assistant: reply one",
				"User: turn two",
				"Assistant: reply two",
				"User: turn three",
			].join("\n"),
		});

		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const identity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db" as const,
		};
		const key = sessionSeqCacheKey(identity);
		const replacements = new Map([[key, { identity, transcript: "User: short\nAssistant: short reply" }]]);

		const count = await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);
		expect(count).toBe(1);
		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "live turn six" }],
		});

		const content = readFileSync(jsonlPath, "utf8");
		const records = content
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const liveTurn = records.find((r: Record<string, unknown>) => r.content === "live turn six");
		expect(liveTurn).toBeTruthy();
		expect(liveTurn.seq).toBe(6);
	});

	test("skips replacement when session has both live and non-live records (race guard)", async () => {
		const root = makeRoot("rewrite-race-guard");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "live partial" }],
		});

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "normalized",
			turns: [
				{ role: "user", content: "canonical full" },
				{ role: "assistant", content: "canonical reply" },
			],
		});

		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const identity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db" as const,
		};
		const key = sessionSeqCacheKey(identity);
		const replacements = new Map([[key, { identity, transcript: "User: db version\nAssistant: db reply" }]]);

		const count = await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);

		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain("live partial");
		expect(content).toContain("canonical full");
		expect(content).not.toContain("db version");
		expect(count).toBe(1);
	});

	test("preserves original lines when replacement transcript is empty", async () => {
		const root = makeRoot("rewrite-empty-transcript");

		await appendCanonicalTranscriptTurns({
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "live",
			turns: [{ role: "user", content: "preserve me" }],
		});

		const jsonlPath = canonicalTranscriptPath(root, "codex");
		const identity = {
			basePath: root,
			agentId: "default",
			harness: "codex",
			sessionKey: "session-1",
			sourceFormat: "db" as const,
		};
		const key = sessionSeqCacheKey(identity);
		const replacements = new Map([[key, { identity, transcript: "" }]]);

		const count = await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);

		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain("preserve me");
		expect(count).toBe(0);
	});
});

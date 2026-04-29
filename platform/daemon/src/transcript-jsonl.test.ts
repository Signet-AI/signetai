import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureCanonicalTranscriptHistory } from "./session-transcripts";
import {
	appendCanonicalTranscriptSnapshotIfMissing,
	appendCanonicalTranscriptTurns,
	canonicalTranscriptPath,
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

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("canonical transcript JSONL", () => {
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

	test("retries legacy markdown backfill after a transient read failure", async () => {
		const root = makeRoot("retry");
		const memoryDir = join(root, "memory");
		const artifact = join(memoryDir, "2026-04-26T00-00-00Z--aaaaaaaaaaaaaaaa--transcript.md");
		mkdirSync(dirname(artifact), { recursive: true });
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

		chmodSync(artifact, 0);
		await ensureCanonicalTranscriptHistory(root, "default");
		expect(existsSync(join(root, "memory", "codex", "transcripts", "transcript.jsonl"))).toBe(false);

		chmodSync(artifact, 0o600);
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
});

describe("backfill OOM regression (#587)", () => {
	test("skips backfill when persistent marker exists", async () => {
		const root = makeRoot("marker-skip");
		const memDir = join(root, "memory");
		mkdirSync(memDir, { recursive: true });

		// Create a markdown transcript artifact that would be backfilled
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

		// Write the persistent marker before calling ensureCanonicalTranscriptHistory
		const markerPath = join(memDir, ".canonical-transcript-backfill-v1.default");
		writeFileSync(markerPath, JSON.stringify({ completed_at: new Date().toISOString(), agent_id: "default" }), "utf8");

		// Backfill should be skipped entirely — no JSONL file created
		await ensureCanonicalTranscriptHistory(root, "default");
		const jsonlPath = join(memDir, "codex", "transcripts", "transcript.jsonl");
		expect(existsSync(jsonlPath)).toBe(false);
	});

	test("backfills missing sessions even when an existing JSONL is large", async () => {
		const root = makeRoot("populated-continue");
		const memDir = join(root, "memory");
		const transcriptsDir = join(memDir, "codex", "transcripts");
		mkdirSync(transcriptsDir, { recursive: true });

		// Simulate a large JSONL from a previous lifecycle
		const jsonlPath = join(transcriptsDir, "transcript.jsonl");
		const fakeRecord = JSON.stringify({
			session_key: "old-session",
			harness: "codex",
			turns: [{ role: "user", content: "x".repeat(500) }],
		});
		// Write >1MB of data
		const lines = Array.from({ length: 2500 }, () => fakeRecord).join("\n");
		writeFileSync(jsonlPath, lines, "utf8");
		expect(statSync(jsonlPath).size).toBeGreaterThan(1024 * 1024);

		// Create a markdown artifact that would be backfilled
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
		expect(lines.some((line) => line.session_key === "live-session" && line.content.includes("fuller migrated reply"))).toBe(true);
		expect(lines.some((line) => line.session_key === "live-session" && line.content.includes("partial live prompt"))).toBe(false);
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
		expect(lines.some((line) => line.session_key === "canonical-session" && line.content.includes("canonical source reply"))).toBe(
			true,
		);
		expect(lines.some((line) => line.session_key === "canonical-session" && line.content.includes("markdown should not replace canonical"))).toBe(
			false,
		);
		expect(lines.some((line) => line.session_key === "live-session" && line.source_format === "live")).toBe(false);
		expect(lines.some((line) => line.session_key === "live-session" && line.content.includes("markdown replacement reply"))).toBe(true);
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
		expect(lines.some((line) => line.session_key === "existing-session" && line.content.includes("existing reply"))).toBe(true);
		expect(lines.some((line) => line.session_key === "new-session" && line.content.includes("new markdown reply"))).toBe(true);
	});

	test("handles many live-only sessions without full-file parse (OOM guard)", async () => {
		const root = makeRoot("backfill-oom-guard");
		const memDir = join(root, "memory");

		// Pre-populate with canonical data (creates a non-trivial file)
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

		// Add 20 live-only sessions
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

		// Create markdown artifacts with fuller data for all 20 live-only sessions
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

		// All 20 live-only sessions replaced
		for (let i = 0; i < 20; i++) {
			expect(content).not.toContain(`live prompt ${i}`);
			expect(content).toContain(`full prompt ${i}`);
			expect(content).toContain(`follow-up ${i}`);
		}

		// All 50 canonical sessions untouched
		for (let i = 0; i < 50; i++) {
			expect(content).toContain(`canonical prompt ${i}`);
		}

		// Marker written
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
			.map((line) => JSON.parse(line) as { readonly session_key: string | null; readonly source_format: string; readonly content: string });

		expect(lines.some((line) => line.session_key === "session-a" && line.content.includes("A prompt"))).toBe(true);
		expect(lines.some((line) => line.session_key === "session-c" && line.content.includes("C prompt"))).toBe(true);
		expect(lines.some((line) => line.session_key === "session-b" && line.source_format === "live")).toBe(false);
		expect(lines.some((line) => line.session_key === "session-b" && line.content.includes("B canonical"))).toBe(true);
		expect(lines.filter((line) => line.session_key === "session-b").every((line) => line.source_format === "db")).toBe(true);
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
		expect(lines.filter((line) => line.session_key === "session-b").every((line) => line.source_format === "db")).toBe(true);
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
			new Map([[sessionSeqCacheKey(identity), { identity, transcript: "User: complete one\nAssistant: complete two" }]]),
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
		const replacements = new Map([
			[key, { identity, transcript: "User: db replacement\nAssistant: db reply" }],
		]);

		await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);

		const content = readFileSync(jsonlPath, "utf8");
		// Session was already healed (non-live records) — replacement skipped
		expect(content).toContain("canonical turn");
		expect(content).toContain("canonical reply");
		expect(content).not.toContain("db replacement");
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
		const replacements = new Map([
			[key, { identity, transcript: "" }],
		]);

		const count = await rewriteReplacingLiveOnlySessions(jsonlPath, replacements);

		const content = readFileSync(jsonlPath, "utf8");
		expect(content).toContain("preserve me");
		expect(count).toBe(0);
	});
});

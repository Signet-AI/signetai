import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { indexCanonicalTranscriptJsonl, writeTranscriptArtifact } from "./memory-lineage";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import {
	enqueueTranscriptCaptureJob,
	getTranscriptCaptureJobStatus,
	getTranscriptCaptureStatus,
	cleanupTranscriptCaptureStorage,
	runTranscriptCaptureOnce,
	startTranscriptCaptureWorker,
} from "./transcript-capture-worker";

let dir = "";
let prevSignetPath: string | undefined;

function manifestValue(path: string, key: string): string | null {
	const match = readFileSync(path, "utf8").match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	if (!match) return null;
	const raw = (match[1] ?? "").trim();
	return raw && raw !== "null" ? raw.replace(/^['"]|['"]$/g, "") : null;
}

describe("transcript capture worker", () => {
	beforeEach(() => {
		prevSignetPath = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-transcript-capture-worker-"));
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (prevSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = prevSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("coalesces source generations without storing transcript payloads", async () => {
		const sourcePath = join(dir, "session.jsonl");
		writeFileSync(sourcePath, "User: first\nAssistant: reply\n", "utf8");
		const input = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "source-session",
			sessionId: "source-session",
			project: "/repo",
			transcript: "inline snapshot should never win ".repeat(200_000),
			rawTranscript: "raw inline snapshot should never be stored ".repeat(200_000),
			transcriptPath: sourcePath,
			basePath: dir,
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;

		const first = await enqueueTranscriptCaptureJob(getDbAccessor(), input);
		if (!first) throw new Error("expected source capture job");
		const stored = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					"SELECT transcript, raw_transcript, source_identity, source_sha256 FROM transcript_capture_jobs WHERE id = ?",
				)
				.get(first),
		) as {
			transcript: string;
			raw_transcript: string | null;
			source_identity: string | null;
			source_sha256: string | null;
		};
		expect(stored.transcript).toBe("");
		expect(stored.raw_transcript).toBeNull();
		expect(stored.source_identity).toBeTruthy();
		expect(stored.source_sha256).toBeNull();

		expect(
			await enqueueTranscriptCaptureJob(getDbAccessor(), { ...input, capturedAt: "2026-06-20T10:01:00.000Z" }),
		).toBe(first);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs").get()),
		).toEqual({ count: 1 });

		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 1 });
		const canonical = readFileSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"), "utf8");
		expect(canonical).toContain("first");
		expect(canonical).not.toContain("inline snapshot should never win");

		writeFileSync(sourcePath, "User: first\nAssistant: reply\nUser: second\n", "utf8");
		const second = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...input,
			capturedAt: "2026-06-20T10:02:00.000Z",
		});
		expect(second).toBe(first);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs").get()),
		).toEqual({ count: 1 });
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(readFileSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"), "utf8")).toContain("second");
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT content FROM memory_artifacts WHERE source_kind = 'transcript' LIMIT 1").get(),
			),
		).toMatchObject({ content: expect.stringContaining("second") });

		writeFileSync(sourcePath, "User: first\nAssistant: reply\n", "utf8");
		const shorterGeneration = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...input,
			capturedAt: "2026-06-20T10:03:00.000Z",
		});
		expect(shorterGeneration).toBe(first);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(readFileSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"), "utf8")).toContain("second");
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT content FROM memory_artifacts WHERE source_kind = 'transcript' LIMIT 1").get(),
			),
		).toMatchObject({ content: expect.stringContaining("second") });
	});

	it("revalidates a completed source when bytes change without changing stat metadata", async () => {
		const sourcePath = join(dir, "same-stat.jsonl");
		const replacement = "User: first\nUser: x\n";
		const initial = `User: first${" ".repeat(replacement.length - "User: first".length - 1)}\n`;
		expect(Buffer.byteLength(initial)).toBe(Buffer.byteLength(replacement));
		writeFileSync(sourcePath, initial, "utf8");
		const initialStat = statSync(sourcePath);
		utimesSync(sourcePath, initialStat.atime, new Date(Math.trunc(initialStat.mtimeMs)));
		const input = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "same-stat-session",
			sessionId: "same-stat-session",
			project: "/repo",
			transcript: "",
			rawTranscript: "",
			transcriptPath: sourcePath,
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;

		const first = await enqueueTranscriptCaptureJob(getDbAccessor(), input);
		if (!first) throw new Error("expected initial source capture job");
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		const originalStat = statSync(sourcePath);
		expect(readFileSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"), "utf8")).not.toContain("User: x");

		writeFileSync(sourcePath, replacement, "utf8");
		utimesSync(sourcePath, originalStat.atime, originalStat.mtime);
		const rewrittenStat = statSync(sourcePath);
		expect(rewrittenStat.size).toBe(originalStat.size);
		expect(rewrittenStat.mtimeMs).toBe(Math.trunc(originalStat.mtimeMs));

		expect(
			await enqueueTranscriptCaptureJob(getDbAccessor(), { ...input, capturedAt: "2026-06-20T10:01:00.000Z" }),
		).toBe(first);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(readFileSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"), "utf8")).toContain(
			'"content":"x"',
		);
	});

	it("does not mutate completed session state for a divergent stale source", async () => {
		const sourcePath = join(dir, "stale-session.jsonl");
		const input = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "stale-session",
			sessionId: "stale-session",
			project: "/repo",
			transcript: "",
			rawTranscript: "",
			transcriptPath: sourcePath,
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		writeFileSync(sourcePath, "User: first\nUser: second\n", "utf8");
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), input);
		if (!id) throw new Error("expected initial source capture job");
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);

		writeFileSync(sourcePath, "User: stale\n", "utf8");
		expect(
			await enqueueTranscriptCaptureJob(getDbAccessor(), { ...input, capturedAt: "2026-06-20T10:01:00.000Z" }),
		).toBe(id);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);

		const stored = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT content FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
					.get("agent-a", "stale-session") as { content: string } | undefined,
		);
		expect(stored?.content).toContain("second");
		expect(stored?.content).not.toContain("stale");
		expect(readFileSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"), "utf8")).toContain(
			'"content":"second"',
		);
		expect(readdirSync(join(dir, ".daemon", "logs", "transcripts"))).toHaveLength(1);
	});

	it("clears recoverable legacy payloads without deleting the job", async () => {
		const sourcePath = join(dir, "legacy.jsonl");
		writeFileSync(sourcePath, "User: recoverable\n", "utf8");
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "legacy-session",
			sessionId: "legacy-session",
			project: null,
			transcript: "User: recoverable",
			rawTranscript: "raw duplicate",
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		});
		if (!id) throw new Error("expected legacy payload job");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE transcript_capture_jobs SET status = 'completed', transcript_path = ? WHERE id = ?").run(
				sourcePath,
				id,
			);
		});

		expect(await cleanupTranscriptCaptureStorage(getDbAccessor(), dir)).toMatchObject({ clearedRows: 1 });
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT transcript, raw_transcript FROM transcript_capture_jobs WHERE id = ?").get(id),
			),
		).toEqual({ transcript: "", raw_transcript: null });
	});

	it("writes canonical and per-session artifacts from a durable job", async () => {
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-1",
			sessionId: "snapshot-1",
			project: "/repo",
			transcript: "User: hello\nAssistant: hi",
			rawTranscript: '{"role":"user","content":"hello"}\n',

			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		});
		expect(id).toBeTruthy();
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);

		const status = await getTranscriptCaptureStatus(getDbAccessor(), "agent-a");
		expect(status.completed).toBe(1);
		expect(status.pending).toBe(0);

		const canonical = join(dir, "memory", "pi", "transcripts", "transcript.jsonl");
		expect(existsSync(canonical)).toBe(true);
		const manifestRows = getDbAccessor().withReadDb((db) =>
			db
				.prepare("SELECT source_path FROM memory_artifacts WHERE agent_id = ? AND source_kind = 'manifest'")
				.all("agent-a"),
		) as Array<{ source_path: string }>;
		expect(manifestRows).toHaveLength(1);
		const manifestPath = join(dir, manifestRows[0].source_path);
		const transcriptPath = manifestValue(manifestPath, "transcript_path");
		expect(transcriptPath).toBeTruthy();
		expect(transcriptPath).not.toBe("memory/pi/transcripts/transcript.jsonl");
		expect(existsSync(join(dir, transcriptPath ?? ""))).toBe(true);
		expect(manifestValue(manifestPath, "canonical_transcript_path")).toBe("memory/pi/transcripts/transcript.jsonl");
		expect(manifestValue(manifestPath, "summary_path")).toBeNull();
		expect(manifestValue(manifestPath, "summary_status")).toBe("not_requested");
	});

	it("keeps a bounded audit reference when normalized transcript has no conversation turns", async () => {
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-raw",
			sessionId: "snapshot-raw",
			project: "/repo",
			transcript: "",
			rawTranscript: '{"type":"tool_call","payload":"kept for audit"}\n',
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		});

		expect(id).toBeTruthy();
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect((await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).completed).toBe(1);
		const auditFiles = readdirSync(join(dir, ".daemon", "logs", "transcripts"));
		expect(auditFiles).toHaveLength(1);
		expect(auditFiles[0]).toEndWith(".json");
		const audit = JSON.parse(
			readFileSync(join(dir, ".daemon", "logs", "transcripts", auditFiles[0]), "utf8"),
		) as Record<string, unknown>;
		expect(audit.schema).toBe("signet.transcript-audit.v2");
		expect(String(audit.preview)).toContain("tool_call");
		expect(existsSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"))).toBe(false);
	});

	it("resets attempts when reviving a dead capture job", async () => {
		const input = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-retry",
			sessionId: "snapshot-retry",
			project: "/repo",
			transcript: "User: retry",
			rawTranscript: "User: retry",
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), input);
		expect(id).toBeTruthy();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE transcript_capture_jobs SET status = 'dead', attempts = max_attempts, error = 'boom' WHERE id = ?",
			).run(id);
		});

		expect(await enqueueTranscriptCaptureJob(getDbAccessor(), input)).toBe(id);
		const row = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT status, attempts, error FROM transcript_capture_jobs WHERE id = ?").get(id),
		) as { status: string; attempts: number; error: string | null } | undefined;
		expect(row).toEqual({ status: "pending", attempts: 0, error: null });
	});

	it("returns only the requesting agent's capture receipt", async () => {
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-receipt",
			sessionId: "snapshot-receipt",
			project: "/repo",
			transcript: "User: receipt",
			rawTranscript: "User: receipt",
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		});

		if (!id) throw new Error("expected capture receipt");
		expect(await getTranscriptCaptureJobStatus(getDbAccessor(), "agent-a", id)).toEqual({
			id,
			status: "pending",
			error: null,
		});
		expect(await getTranscriptCaptureJobStatus(getDbAccessor(), "agent-b", id ?? "")).toBeNull();
	});

	it("deduplicates stable session snapshots across delivery timestamps", async () => {
		const base = {
			agentId: "agent-a",
			harness: "claude-code",
			sessionKey: "session-stable",
			sessionId: "snapshot-stable",
			project: "/repo",
			transcript: "User: stable\nAssistant: snapshot",
			rawTranscript: '{"sessionId":"session-stable"}',

			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		const first = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			capturedAt: "2026-06-20T10:00:00.000Z",
		});
		const second = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			capturedAt: "2026-06-20T10:05:00.000Z",
		});

		expect(second).toBe(first);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs").get()),
		).toEqual({ count: 1 });
	});

	it("replaces a changed generation instead of appending a second session row", async () => {
		const base = {
			agentId: "agent-a",
			harness: "claude-code",
			sessionKey: "session-ordered",
			sessionId: "snapshot-ordered",
			project: "/repo",
			rawTranscript: null,
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		const first = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			transcript: "User: first generation",
			capturedAt: "2026-06-20T10:00:00.000Z",
		});
		const second = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			transcript: "User: second generation",
			capturedAt: "2026-06-20T10:01:00.000Z",
		});
		if (!first || !second) throw new Error("expected source generation jobs");
		expect(second).toBe(first);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT id, status, transcript FROM transcript_capture_jobs").all(),
			),
		).toEqual([{ id: first, status: "pending", transcript: "User: second generation" }]);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 1, pending: 0 });
	});

	it("coalesces concurrent admissions through the database transaction", async () => {
		const sourcePath = join(dir, "concurrent-admission.jsonl");
		writeFileSync(sourcePath, "User: one source\n", "utf8");
		const input = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "concurrent-admission",
			sessionId: "concurrent-admission",
			project: "/repo",
			transcript: "",
			rawTranscript: "",
			transcriptPath: sourcePath,
			basePath: dir,
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;

		const ids = await Promise.all(Array.from({ length: 4 }, () => enqueueTranscriptCaptureJob(getDbAccessor(), input)));
		expect(ids.every((id) => id === ids[0] && id !== null)).toBe(true);
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs").get(),
			),
		).toEqual({ count: 1 });
	});

	it("concurrent workers claim one snapshot once", async () => {
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-concurrent",
			sessionId: "snapshot-concurrent",
			project: "/repo",
			transcript: "User: one durable turn",
			rawTranscript: "one durable turn",
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		});
		if (!id) throw new Error("expected concurrent capture job");

		const results = await Promise.all([
			runTranscriptCaptureOnce(getDbAccessor(), dir),
			runTranscriptCaptureOnce(getDbAccessor(), dir),
		]);
		expect(results.sort()).toEqual([false, true]);
		expect(await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 1, pending: 0 });
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT attempts FROM transcript_capture_jobs WHERE id = ?").get(id),
			),
		).toEqual({ attempts: 1 });
	});

	it("recovery preserves durable outputs and provenance after a lease crashes before completion", async () => {
		const capture = {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-restart",
			sessionId: "snapshot-restart",
			project: "/repo",
			transcript: "User: survives restart",
			rawTranscript: "survives restart",
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		const id = await enqueueTranscriptCaptureJob(getDbAccessor(), capture);
		if (!id) throw new Error("expected restart capture job");
		await writeCanonicalTranscriptFromSnapshot({ basePath: dir, ...capture });
		const artifact = await writeTranscriptArtifact({ ...capture, startedAt: null, summaryStatus: "not_requested" });
		await indexCanonicalTranscriptJsonl({ ...capture, startedAt: null, manifestPath: artifact.manifestPath });
		const beforeRecovery = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT agent_id, source_kind, source_path, session_id, session_key
					 FROM memory_artifacts WHERE agent_id = ? ORDER BY source_kind, source_path`,
				)
				.all("agent-a"),
		);
		expect(beforeRecovery).not.toEqual([]);

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE transcript_capture_jobs SET status = 'processing', attempts = 1 WHERE id = ?").run(id);
		});

		const worker = await startTranscriptCaptureWorker(getDbAccessor(), dir);
		try {
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				const status = await getTranscriptCaptureJobStatus(getDbAccessor(), "agent-a", id);
				if (status?.status === "completed") break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			worker.stop();
		}

		expect(await getTranscriptCaptureJobStatus(getDbAccessor(), "agent-a", id)).toEqual({
			id,
			status: "completed",
			error: null,
		});
		expect(await getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 1, processing: 0 });
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						`SELECT agent_id, source_kind, source_path, session_id, session_key
						 FROM memory_artifacts WHERE agent_id = ? ORDER BY source_kind, source_path`,
					)
					.all("agent-a"),
			),
		).toEqual(beforeRecovery);
	});
});

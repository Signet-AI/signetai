import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { indexCanonicalTranscriptJsonl, writeTranscriptArtifact } from "./memory-lineage";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import {
	enqueueTranscriptCaptureJob,
	getTranscriptCaptureJobStatus,
	getTranscriptCaptureStatus,
	runTranscriptCaptureOnce,
	startTranscriptCaptureWorker,
} from "./transcript-capture-worker";

let dir = "";
let prevSignetPath: string | undefined;

function manifestValue(path: string, key: string): string | null {
	const match = readFileSync(path, "utf8").match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	if (!match) return null;
	const raw = (match[1] ?? "").trim();
	return raw && raw !== "null" ? raw.replace(/^['\"]|['\"]$/g, "") : null;
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

	it("writes canonical and per-session artifacts from a durable job", async () => {
		const id = enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "pi",
			sessionKey: "session-1",
			sessionId: "snapshot-1",
			project: "/repo",
			transcript: "User: hello\nAssistant: hi",
			rawTranscript: '{"role":"user","content":"hello"}\n',
			transcriptPath: "/tmp/session.jsonl",
			capturedAt: "2026-06-20T10:00:00.000Z",
			endedAt: "2026-06-20T10:00:00.000Z",
			summaryStatus: "not_requested",
		});
		expect(id).toBeTruthy();
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);

		const status = getTranscriptCaptureStatus(getDbAccessor(), "agent-a");
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

	it("keeps raw audit logs when normalized transcript has no conversation turns", async () => {
		const id = enqueueTranscriptCaptureJob(getDbAccessor(), {
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
		expect(getTranscriptCaptureStatus(getDbAccessor(), "agent-a").completed).toBe(1);
		const auditFiles = readdirSync(join(dir, ".daemon", "logs", "transcripts"));
		// #1163: the capture archives the rolling latest by renaming it to the
		// dated raw-transcript file, so the same content is never written twice.
		expect(auditFiles.some((name) => name.endsWith("--raw-transcript.log"))).toBe(true);
		expect(auditFiles.some((name) => name.endsWith("--latest.log"))).toBe(false);
		expect(existsSync(join(dir, "memory", "pi", "transcripts", "transcript.jsonl"))).toBe(false);
	});

	it("resets attempts when reviving a dead capture job", () => {
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
		const id = enqueueTranscriptCaptureJob(getDbAccessor(), input);
		expect(id).toBeTruthy();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE transcript_capture_jobs SET status = 'dead', attempts = max_attempts, error = 'boom' WHERE id = ?",
			).run(id);
		});

		expect(enqueueTranscriptCaptureJob(getDbAccessor(), input)).toBe(id);
		const row = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT status, attempts, error FROM transcript_capture_jobs WHERE id = ?").get(id),
		) as { status: string; attempts: number; error: string | null } | undefined;
		expect(row).toEqual({ status: "pending", attempts: 0, error: null });
	});

	it("returns only the requesting agent's capture receipt", () => {
		const id = enqueueTranscriptCaptureJob(getDbAccessor(), {
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

		expect(id).toBeTruthy();
		expect(getTranscriptCaptureJobStatus(getDbAccessor(), "agent-a", id ?? "")).toEqual({
			id,
			status: "pending",
			error: null,
		});
		expect(getTranscriptCaptureJobStatus(getDbAccessor(), "agent-b", id ?? "")).toBeNull();
	});

	it("deduplicates stable session snapshots across delivery timestamps", () => {
		const base = {
			agentId: "agent-a",
			harness: "claude-code",
			sessionKey: "session-stable",
			sessionId: "snapshot-stable",
			project: "/repo",
			transcript: "User: stable\nAssistant: snapshot",
			rawTranscript: '{"sessionId":"session-stable"}',
			transcriptPath: "/tmp/session-stable.jsonl",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		const first = enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			capturedAt: "2026-06-20T10:00:00.000Z",
		});
		const second = enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			capturedAt: "2026-06-20T10:05:00.000Z",
		});

		expect(second).toBe(first);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs").get()),
		).toEqual({ count: 1 });
	});

	it("leases same-session evidence by enqueue time, not capture time", async () => {
		const base = {
			agentId: "agent-a",
			harness: "claude-code",
			sessionKey: "session-ordered",
			project: "/repo",
			rawTranscript: "snapshot",
			endedAt: "2026-06-20T10:00:00.000Z",
		} as const;
		const newerCapture = enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			sessionId: "snapshot-ordered-newer",
			transcript: "User: later turn arrived first",
			capturedAt: "2026-06-20T10:01:00.000Z",
		});
		const olderCapture = enqueueTranscriptCaptureJob(getDbAccessor(), {
			...base,
			sessionId: "snapshot-ordered-older",
			transcript: "User: earlier turn arrived later",
			capturedAt: "2026-06-20T10:00:00.000Z",
		});
		if (!newerCapture || !olderCapture) throw new Error("expected ordered capture jobs");

		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE transcript_capture_jobs SET created_at = ? WHERE id = ?").run(
				"2026-06-20T10:00:00.000Z",
				newerCapture,
			);
			db.prepare("UPDATE transcript_capture_jobs SET created_at = ? WHERE id = ?").run(
				"2026-06-20T10:01:00.000Z",
				olderCapture,
			);
		});

		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT id, status, attempts FROM transcript_capture_jobs ORDER BY created_at").all(),
			),
		).toEqual([
			{ id: newerCapture, status: "completed", attempts: 1 },
			{ id: olderCapture, status: "pending", attempts: 0 },
		]);

		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 2, pending: 0 });
	});

	it("concurrent workers claim one snapshot once", async () => {
		const id = enqueueTranscriptCaptureJob(getDbAccessor(), {
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
		expect(getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 1, pending: 0 });
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
		const id = enqueueTranscriptCaptureJob(getDbAccessor(), capture);
		if (!id) throw new Error("expected restart capture job");

		// Model the real crash window after the canonical file, immutable artifact,
		// and indexed provenance have committed but before markDone updates the job.
		await writeCanonicalTranscriptFromSnapshot({ basePath: dir, ...capture });
		const artifact = await writeTranscriptArtifact({ ...capture, startedAt: null, summaryStatus: "not_requested" });
		indexCanonicalTranscriptJsonl({ ...capture, startedAt: null, manifestPath: artifact.manifestPath });
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

		const worker = startTranscriptCaptureWorker(getDbAccessor(), dir);
		try {
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				const status = getTranscriptCaptureJobStatus(getDbAccessor(), "agent-a", id);
				if (status?.status === "completed") break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		} finally {
			worker.stop();
		}

		expect(getTranscriptCaptureJobStatus(getDbAccessor(), "agent-a", id)).toEqual({
			id,
			status: "completed",
			error: null,
		});
		expect(getTranscriptCaptureStatus(getDbAccessor(), "agent-a")).toMatchObject({ completed: 1, processing: 0 });
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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	enqueueTranscriptCaptureJob,
	getTranscriptCaptureJobStatus,
	getTranscriptCaptureStatus,
	runTranscriptCaptureOnce,
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
			summaryStatus: "pending",
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
		expect(manifestValue(manifestPath, "summary_status")).toBe("pending");
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
});

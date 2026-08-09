import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { deriveSessionEndFallbackId } from "./session-end-recovery";
import { markSessionTranscriptCompleted, upsertSessionTranscript } from "./session-transcripts";
import { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } from "./transcript-capture-worker";
import { normalizeSessionTranscript } from "./transcript-normalization";
import { runTranscriptRecoveryScan } from "./transcript-recovery-worker";

let dir = "";
let claudeRoot = "";
let codexRoot = "";
let previousSignetPath: string | undefined;

function writeSettled(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	const settled = new Date(Date.now() - 120_000);
	utimesSync(path, settled, settled);
}

async function scan(nowMs = Date.now()) {
	return runTranscriptRecoveryScan(getDbAccessor(), dir, "agent-a", {
		roots: { claudeCode: claudeRoot, codex: codexRoot },
		nowMs,
	});
}

describe("transcript recovery worker", () => {
	beforeEach(() => {
		previousSignetPath = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-transcript-recovery-"));
		claudeRoot = join(dir, "native", "claude", "projects");
		codexRoot = join(dir, "native", "codex", "sessions");
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
		rmSync(dir, { recursive: true, force: true });
	});

	it("recovers Claude Code and Codex logs through the canonical capture pipeline", async () => {
		const claudePath = join(claudeRoot, "-repo", "claude-session.jsonl");
		writeSettled(
			claudePath,
			[
				JSON.stringify({
					sessionId: "claude-session",
					timestamp: "2026-07-20T10:00:00.000Z",
					cwd: "/repo/claude",
					message: { role: "user", content: "recover claude" },
				}),
				JSON.stringify({
					sessionId: "claude-session",
					timestamp: "2026-07-20T10:01:00.000Z",
					cwd: "/repo/claude",
					message: { role: "assistant", content: "claude recovered" },
				}),
			].join("\n"),
		);
		const codexPath = join(
			codexRoot,
			"2026",
			"07",
			"20",
			"rollout-2026-07-20T10-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
		);
		writeSettled(
			codexPath,
			[
				JSON.stringify({
					timestamp: "2026-07-20T10:00:00.000Z",
					type: "session_meta",
					payload: {
						id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
						timestamp: "2026-07-20T10:00:00.000Z",
						cwd: "/repo/codex",
					},
				}),
				JSON.stringify({
					type: "event_msg",
					payload: { type: "user_message", message: "recover codex" },
				}),
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "codex recovered" },
				}),
			].join("\n"),
		);

		const first = await scan();
		expect(first.enqueued).toBe(2);
		expect(first.discovered).toBe(2);
		const jobs = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					`SELECT harness, session_key, project, transcript_path
					 FROM transcript_capture_jobs
					 ORDER BY harness`,
				)
				.all(),
		) as Array<Record<string, unknown>>;
		expect(jobs).toEqual([
			{
				harness: "claude-code",
				session_key: "claude-session",
				project: "/repo/claude",
				transcript_path: claudePath,
			},
			{
				harness: "codex",
				session_key: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				project: "/repo/codex",
				transcript_path: codexPath,
			},
		]);
		const claudeRaw = readFileSync(claudePath, "utf8");
		const codexRaw = readFileSync(codexPath, "utf8");
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(true);
		expect(await runTranscriptCaptureOnce(getDbAccessor(), dir)).toBe(false);
		expect(existsSync(join(dir, "memory", "claude-code", "transcripts", "transcript.jsonl"))).toBe(true);
		expect(existsSync(join(dir, "memory", "codex", "transcripts", "transcript.jsonl"))).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						`SELECT COUNT(*) AS count
						 FROM memory_artifacts
						 WHERE agent_id = ? AND source_kind = 'transcript'`,
					)
					.get("agent-a"),
			),
		).toEqual({ count: 4 });
		expect(readFileSync(claudePath, "utf8")).toBe(claudeRaw);
		expect(readFileSync(codexPath, "utf8")).toBe(codexRaw);

		const second = await scan();
		expect(second.enqueued).toBe(0);
		expect(second.skippedUnchanged).toBe(2);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM transcript_recovery_files").get()),
		).toEqual({ count: 2 });
	});

	it("deduplicates the same snapshot when hook and recovery timestamps differ", async () => {
		const path = join(claudeRoot, "-repo", "same-session.jsonl");
		const raw = [
			JSON.stringify({
				sessionId: "same-session",
				timestamp: "2026-07-20T10:00:00.000Z",
				cwd: "/repo",
				message: { role: "user", content: "same snapshot" },
			}),
			JSON.stringify({
				sessionId: "same-session",
				message: { role: "assistant", content: "same response" },
			}),
		].join("\n");
		writeSettled(path, raw);
		const transcript = normalizeSessionTranscript("claude-code", raw);
		const sessionId = deriveSessionEndFallbackId("same-session", path, transcript);
		const hookJob = enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "claude-code",
			sessionKey: "same-session",
			sessionId,
			project: "/repo",
			transcript,
			rawTranscript: raw,
			transcriptPath: path,
			capturedAt: "2026-07-20T12:00:00.000Z",
			endedAt: "2026-07-20T12:00:00.000Z",
		});
		const retryJob = enqueueTranscriptCaptureJob(getDbAccessor(), {
			agentId: "agent-a",
			harness: "claude-code",
			sessionKey: "same-session",
			sessionId,
			project: "/repo",
			transcript,
			rawTranscript: raw,
			transcriptPath: path,
			capturedAt: "2026-07-20T12:05:00.000Z",
			endedAt: "2026-07-20T12:05:00.000Z",
		});
		expect(retryJob).toBe(hookJob);

		const result = await scan();
		expect(result.enqueued).toBe(0);
		expect(result.deduplicated).toBe(1);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM transcript_capture_jobs").get()),
		).toEqual({ count: 1 });
	});

	it("does not replace a completed canonical transcript with a legacy snapshot", async () => {
		const path = join(claudeRoot, "-repo", "completed-session.jsonl");
		writeSettled(
			path,
			JSON.stringify({
				sessionId: "completed-session",
				message: { role: "user", content: "legacy partial snapshot" },
			}),
		);
		upsertSessionTranscript(
			"completed-session",
			"canonical complete transcript",
			"claude-code",
			"/repo",
			"agent-a",
			"2099-01-01T00:00:00.000Z",
		);
		expect(markSessionTranscriptCompleted("completed-session", "agent-a", "2099-01-01T00:00:00.000Z")).toBe(true);

		const result = await scan();
		expect(result.enqueued).toBe(0);
		expect(result.deduplicated).toBe(1);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT content, completed_at FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
					.get("agent-a", "completed-session"),
			),
		).toEqual({ content: "canonical complete transcript", completed_at: "2099-01-01T00:00:00.000Z" });
	});

	it("preserves an incomplete canonical transcript when recovery is partial", async () => {
		const path = join(claudeRoot, "-repo", "partial-session.jsonl");
		writeSettled(
			path,
			JSON.stringify({
				sessionId: "partial-session",
				message: { role: "user", content: "legacy partial snapshot" },
			}),
		);
		upsertSessionTranscript(
			"partial-session",
			"canonical transcript that must survive",
			"claude-code",
			"/repo",
			"agent-a",
			"2099-01-01T00:00:00.000Z",
		);

		const result = await scan();
		expect(result.enqueued).toBe(1);
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content, completed_at FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
					.get("agent-a", "partial-session") as { content: string; completed_at: string | null } | null,
		);
		expect(row).not.toBeNull();
		if (!row) throw new Error("expected retained transcript");
		expect(row.content).toContain("canonical transcript that must survive");
		expect(row.content).toContain("legacy partial snapshot");
		expect(row.completed_at).not.toBeNull();
	});

	it("keeps recovery fingerprints and capture jobs agent-scoped", async () => {
		const path = join(claudeRoot, "-repo", "shared-native-session.jsonl");
		writeSettled(
			path,
			JSON.stringify({
				sessionId: "shared-native-session",
				timestamp: "2026-07-20T10:00:00.000Z",
				cwd: "/repo",
				message: { role: "user", content: "agent-scoped recovery" },
			}),
		);

		expect((await scan()).enqueued).toBe(1);
		expect(
			(
				await runTranscriptRecoveryScan(getDbAccessor(), dir, "agent-b", {
					roots: { claudeCode: claudeRoot, codex: codexRoot },
				})
			).enqueued,
		).toBe(1);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						`SELECT agent_id, COUNT(*) AS count
						 FROM transcript_capture_jobs
						 GROUP BY agent_id
						 ORDER BY agent_id`,
					)
					.all(),
			),
		).toEqual([
			{ agent_id: "agent-a", count: 1 },
			{ agent_id: "agent-b", count: 1 },
		]);
	});

	it("does not read active or oversized logs", async () => {
		const recentPath = join(claudeRoot, "-repo", "recent.jsonl");
		mkdirSync(dirname(recentPath), { recursive: true });
		writeFileSync(
			recentPath,
			JSON.stringify({ sessionId: "recent", message: { role: "user", content: "still active" } }),
		);
		const largePath = join(codexRoot, "rollout-oversized.jsonl");
		writeSettled(
			largePath,
			JSON.stringify({
				type: "session_meta",
				payload: { id: "oversized", cwd: "/repo" },
			}).padEnd(2_000, "x"),
		);

		const result = await runTranscriptRecoveryScan(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			maxBytes: 1_000,
		});
		expect(result.skippedRecent).toBe(1);
		expect(result.skippedOversized).toBe(1);
		expect(result.enqueued).toBe(0);
	});

	it("fingerprints settled empty logs so they do not starve later batches", async () => {
		const path = join(claudeRoot, "-repo", "empty.jsonl");
		writeSettled(path, "");

		const first = await scan();
		expect(first.skippedInvalid).toBe(1);
		const second = await scan();
		expect(second.skippedUnchanged).toBe(1);
		expect(second.examined).toBe(0);
	});
});

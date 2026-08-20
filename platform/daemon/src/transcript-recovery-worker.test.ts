import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { DbOwnerDiedError } from "./db-owner-client";
import { deriveSessionEndFallbackId } from "./session-end-recovery";
import { markSessionTranscriptCompleted, upsertSessionTranscript } from "./session-transcripts";
import { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } from "./transcript-capture-worker";
import { normalizeSessionTranscript } from "./transcript-normalization";
import { runTranscriptRecoveryScan, startTranscriptRecoveryWorker } from "./transcript-recovery-worker";

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
		const hookJob = await enqueueTranscriptCaptureJob(getDbAccessor(), {
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
		const retryJob = await enqueueTranscriptCaptureJob(getDbAccessor(), {
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
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content, completed_at FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
					.get("agent-a", "completed-session") as { content: string; completed_at: string | null } | null,
		);
		expect(row).toEqual({ content: "canonical complete transcript", completed_at: "2099-01-01T00:00:00.000Z" });
	});

	it("merges later settled growth into a completed recovery snapshot", async () => {
		const path = join(claudeRoot, "-repo", "growing-session.jsonl");
		const firstLine = JSON.stringify({
			sessionId: "growing-session",
			message: { role: "user", content: "first settled line" },
		});
		const secondLine = JSON.stringify({ message: { role: "assistant", content: "later settled line" } });
		writeSettled(path, firstLine);

		expect((await scan()).enqueued).toBe(1);
		writeSettled(path, `${firstLine}\n${secondLine}`);

		const result = await scan();
		expect(result.enqueued).toBe(1);
		expect(result.deduplicated).toBe(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT content FROM session_transcripts WHERE agent_id = ? AND session_key = ?")
						.get("agent-a", "growing-session") as { content: string },
			),
		).toEqual({ content: "User: first settled line\nAssistant: later settled line" });
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

	it("resumes a bounded scan from its durable frontier", async () => {
		const firstPath = join(claudeRoot, "-repo", "a-frontier.jsonl");
		const secondPath = join(claudeRoot, "-repo", "b-frontier.jsonl");
		const makeLog = (sessionId: string, content: string) =>
			[
				JSON.stringify({
					sessionId,
					timestamp: "2026-07-20T10:00:00.000Z",
					cwd: "/repo",
					message: { role: "user", content },
				}),
				JSON.stringify({
					sessionId,
					timestamp: "2026-07-20T10:01:00.000Z",
					cwd: "/repo",
					message: { role: "assistant", content: `${content} response` },
				}),
			].join("\\n");
		writeSettled(firstPath, makeLog("frontier-a", "frontier a"));
		writeSettled(secondPath, makeLog("frontier-b", "frontier b"));

		const bounded = () =>
			runTranscriptRecoveryScan(getDbAccessor(), dir, "agent-a", {
				roots: { claudeCode: claudeRoot, codex: codexRoot },
				maxFiles: 1,
			});
		const first = await bounded();
		expect(first.examined).toBe(1);
		expect(first.enqueued).toBe(1);
		const second = await bounded();
		expect(second.examined).toBe(1);
		expect(second.enqueued).toBe(1);

		const jobs = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT transcript_path FROM transcript_capture_jobs ORDER BY transcript_path").all(),
		) as Array<{ transcript_path: string }>;
		expect(jobs.map((job) => job.transcript_path)).toEqual([firstPath, secondPath]);
	});

	it("resumes after cancellation keeps the persisted frontier", async () => {
		const firstPath = join(claudeRoot, "-repo", "a-aborted.jsonl");
		const secondPath = join(claudeRoot, "-repo", "b-aborted.jsonl");
		const makeLog = (sessionId: string) =>
			JSON.stringify({
				sessionId,
				timestamp: "2026-07-20T10:00:00.000Z",
				cwd: "/repo",
				message: { role: "user", content: sessionId },
			});
		writeSettled(firstPath, makeLog("aborted-a"));
		writeSettled(secondPath, makeLog("aborted-b"));

		const cancellation = new AbortController();
		const realAccessor = getDbAccessor();
		let frontierSaves = 0;
		const interruptingAccessor = {
			...realAccessor,
			withWriteTxAsync: (
				fn: Parameters<typeof realAccessor.withWriteTxAsync>[0],
				options?: Parameters<typeof realAccessor.withWriteTxAsync>[1],
			) =>
				realAccessor.withWriteTxAsync(fn, options).then((value) => {
					if (options?.operation === "transcript-recovery.save-frontier" && ++frontierSaves === 1)
						cancellation.abort(new Error("cancel recovery after first cursor"));
					return value;
				}),
		} as import("./db-accessor").DbAccessor;
		await expect(
			runTranscriptRecoveryScan(interruptingAccessor, dir, "agent-a", {
				roots: { claudeCode: claudeRoot, codex: codexRoot },
				signal: cancellation.signal,
			}),
		).rejects.toThrow("cancel recovery after first cursor");

		const persisted = await realAccessor.withReadDbAsync((db) =>
			db
				.prepare("SELECT cursor_path FROM transcript_recovery_frontiers WHERE agent_id = ? AND harness = ?")
				.get("agent-a", "claude-code"),
		);
		expect(persisted).toEqual({ cursor_path: firstPath });
		const resumed = await scan();
		expect(resumed.enqueued).toBe(1);
		const jobs = realAccessor.withReadDb((db) =>
			db.prepare("SELECT transcript_path FROM transcript_capture_jobs ORDER BY transcript_path").all(),
		) as Array<{ transcript_path: string }>;
		expect(jobs.map((job) => job.transcript_path)).toEqual([firstPath, secondPath]);
	});

	it("propagates DB-owner death instead of converting it into recovery success", async () => {
		const ownerDiedAccessor = {
			withReadDbAsync: async () => {
				throw new DbOwnerDiedError();
			},
		} as unknown as import("./db-accessor").DbAccessor;
		await expect(
			runTranscriptRecoveryScan(ownerDiedAccessor, dir, "agent-a", {
				roots: { claudeCode: claudeRoot, codex: codexRoot },
				maxDiscoveredFiles: 1,
			}),
		).rejects.toBeInstanceOf(DbOwnerDiedError);
		const responsive = await scan();
		expect(responsive.enqueued).toBe(0);
	});
	it("cancels an in-flight scan without scheduling another pass", async () => {
		const handle = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
		});
		await handle.stop();
		expect(handle.running).toBe(false);
	});

	it("cancels a scan waiting for DB admission", async () => {
		let admittedResolve!: () => void;
		const admitted = new Promise<void>((resolve) => {
			admittedResolve = resolve;
		});
		const queuedAccessor = {
			withReadDbAsync(_fn: unknown, options?: { readonly signal?: AbortSignal }): Promise<never> {
				admittedResolve();
				return new Promise((_, reject) => {
					options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
				});
			},
		} as unknown as import("./db-accessor").DbAccessor;
		const handle = startTranscriptRecoveryWorker(queuedAccessor, dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
		});
		await admitted;
		await handle.stop();
		expect(handle.running).toBe(false);
	});
});

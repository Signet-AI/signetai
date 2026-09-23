import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { DbOwnerDiedError } from "./db-owner-client";
import { deriveSessionEndFallbackId } from "./session-end-recovery";
import { logger } from "./logger";
import { markSessionTranscriptCompleted, upsertSessionTranscript } from "./session-transcripts";
import { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } from "./transcript-capture-worker";
import { normalizeSessionTranscript } from "./transcript-normalization";
import {
	runTranscriptRecoveryScan,
	parseTranscriptRecoveryResult,
	startTranscriptRecoveryWorker,
} from "./transcript-recovery-worker";

let dir = "";
let claudeRoot = "";
let codexRoot = "";
let previousSignetPath: string | undefined;
let previousRecoveryHoldFile: string | undefined;

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
	it("parses a buffered child result after the child has closed", () => {
		const result = {
			discovered: 1,
			examined: 1,
			enqueued: 1,
			deduplicated: 0,
			skippedRecent: 0,
			skippedOversized: 0,
			skippedUnchanged: 0,
			skippedInvalid: 0,
		};
		expect(parseTranscriptRecoveryResult(`logger output\n${JSON.stringify({ type: "result", result })}\n`)).toEqual(
			result,
		);
	});

	beforeEach(() => {
		previousSignetPath = process.env.SIGNET_PATH;
		previousRecoveryHoldFile = process.env.SIGNET_TRANSCRIPT_RECOVERY_TEST_HOLD_FILE;
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
		if (previousRecoveryHoldFile === undefined)
			Reflect.deleteProperty(process.env, "SIGNET_TRANSCRIPT_RECOVERY_TEST_HOLD_FILE");
		else process.env.SIGNET_TRANSCRIPT_RECOVERY_TEST_HOLD_FILE = previousRecoveryHoldFile;
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

	it("bounds fingerprint preload to discovered files despite large history", async () => {
		const path = join(claudeRoot, "-repo", "bounded-history.jsonl");
		writeSettled(path, JSON.stringify({ sessionId: "bounded-history", message: { role: "user", content: "bounded" } }));
		expect((await scan()).enqueued).toBe(1);
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO transcript_recovery_files (
					agent_id, source_path, harness, size_bytes, mtime_ms, content_sha256, session_id, last_scanned_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (let index = 0; index < 5_000; index++) {
				insert.run(
					"agent-a",
					`/historical/${index}.jsonl`,
					"claude-code",
					1,
					1,
					`sha-${index}`,
					`session-${index}`,
					"2026-01-01",
				);
			}
		});
		const result = await scan();
		expect(result.skippedUnchanged).toBe(1);
		expect(result.examined).toBe(0);
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
			execution: "child",
		});
		await handle.stop();
		expect(handle.running).toBe(false);
	});

	it("escalates to SIGKILL for a SIGTERM-resistant recovery target", async () => {
		const childPath = join(dir, "sigterm-resistant-child.js");
		const pidPath = join(dir, "sigterm-resistant-child.pid");
		writeFileSync(
			childPath,
			`require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`,
		);
		const handle = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
			childPath,
		});
		for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt++) await Bun.sleep(5);
		expect(existsSync(pidPath)).toBe(true);
		const targetPid = Number(readFileSync(pidPath, "utf8"));
		expect(Number.isInteger(targetPid)).toBe(true);
		await handle.stop();
		expect(handle.running).toBe(false);
		let targetAlive = true;
		for (let attempt = 0; attempt < 100 && targetAlive; attempt++) {
			try {
				process.kill(targetPid, 0);
			} catch {
				targetAlive = false;
			}
			if (targetAlive) await Bun.sleep(5);
		}
		expect(targetAlive).toBe(false);
	}, 10_000);

	it("kills the recovery target when its PID handshake is delayed", async () => {
		const childPath = join(dir, "delayed-pid-child.js");
		const supervisorPath = join(dir, "delayed-pid-supervisor.js");
		const pidPath = join(dir, "delayed-pid-child.pid");
		const productionSupervisorPath = join(dirname(fileURLToPath(import.meta.url)), "transcript-recovery-supervisor.ts");
		writeFileSync(
			childPath,
			`require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);`,
		);
		writeFileSync(
			supervisorPath,
			`const realSupervisorPath = ${JSON.stringify(productionSupervisorPath)}; const originalWrite = process.stdout.write.bind(process.stdout); let delayedStarted = true; process.stdout.write = (chunk) => { if (delayedStarted && String(chunk).includes('"type":"started"')) { delayedStarted = false; setTimeout(() => originalWrite(chunk), 10_000); return true; } return originalWrite(chunk); }; require(realSupervisorPath);`,
		);
		const handle = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
			childPath,
			supervisorPath,
		});
		let targetPid = 0;
		for (let attempt = 0; attempt < 100 && targetPid === 0; attempt++) {
			if (existsSync(pidPath)) targetPid = Number(readFileSync(pidPath, "utf8"));
			if (targetPid === 0) await Bun.sleep(5);
		}
		expect(Number.isInteger(targetPid)).toBe(true);
		expect(targetPid).toBeGreaterThan(0);
		try {
			await handle.stop();
			let targetAlive = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				targetAlive = true;
				try {
					process.kill(targetPid, 0);
				} catch {
					targetAlive = false;
					break;
				}
				await Bun.sleep(5);
			}
			expect(targetAlive).toBe(false);
		} finally {
			try {
				process.kill(targetPid, "SIGKILL");
			} catch {
				// The target should already be gone; keep cleanup idempotent.
			}
		}
	}, 20_000);

	it("accepts a result written immediately before the recovery child exits", async () => {
		const childPath = join(dir, "immediate-exit-child.js");
		const result = {
			discovered: 1,
			examined: 1,
			enqueued: 1,
			deduplicated: 0,
			skippedRecent: 0,
			skippedOversized: 0,
			skippedUnchanged: 0,
			skippedInvalid: 0,
		};
		writeFileSync(
			childPath,
			`process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "result", result })}\n`)}); process.exit(0);`,
		);
		const infoMessages: string[] = [];
		const warnMessages: string[] = [];
		const originalInfo = logger.info;
		const originalWarn = logger.warn;
		logger.info = ((category, message) => {
			infoMessages.push(`${category}:${message}`);
		}) as typeof logger.info;
		logger.warn = ((category, message) => {
			warnMessages.push(`${category}:${message}`);
		}) as typeof logger.warn;

		const handle = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
			childPath,
		});
		try {
			for (let attempt = 0; attempt < 200; attempt++) {
				if (infoMessages.includes("transcripts:Transcript recovery scan complete")) break;
				await Bun.sleep(5);
			}
			expect(infoMessages).toContain("transcripts:Transcript recovery scan complete");
			expect(warnMessages).toEqual([]);
		} finally {
			await handle.stop();
			logger.info = originalInfo;
			logger.warn = originalWarn;
		}
	});

	it("does not reschedule after a successful child scan", async () => {
		const childPath = join(dir, "counted-child.js");
		const counterPath = join(dir, "child-runs.txt");
		const result = {
			discovered: 0,
			examined: 0,
			enqueued: 0,
			deduplicated: 0,
			skippedRecent: 0,
			skippedOversized: 0,
			skippedUnchanged: 0,
			skippedInvalid: 0,
		};
		writeFileSync(
			childPath,
			`require("node:fs").appendFileSync(${JSON.stringify(counterPath)}, "x"); process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "result", result })}\\n`)}); process.exit(0);`,
		);
		const handle = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 10,
			childPath,
		});
		await Bun.sleep(100);
		await handle.stop();
		expect(readFileSync(counterPath, "utf8")).toBe("x");
	});
	it("treats a clean exit without a protocol payload as a terminal success", async () => {
		const childPath = join(dir, "empty-success-child.js");
		writeFileSync(childPath, "process.exit(0);");
		const warnings: string[] = [];
		const originalWarn = logger.warn;
		logger.warn = ((category, message) => {
			warnings.push(`${category}:${message}`);
		}) as typeof logger.warn;
		const handle = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 10,
			childPath,
		});
		try {
			await Bun.sleep(100);
			expect(warnings).toEqual([]);
		} finally {
			await handle.stop();
			logger.warn = originalWarn;
		}
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
			execution: "in-process",
		});
		await admitted;
		await handle.stop();
		expect(handle.running).toBe(false);
	});

	it("does not clear a frontier when discovery is capped", async () => {
		const firstPath = join(claudeRoot, "-repo", "a-capped.jsonl");
		const secondPath = join(claudeRoot, "-repo", "b-capped.jsonl");
		const makeLog = (sessionId: string) => JSON.stringify({ sessionId, message: { role: "user", content: sessionId } });
		writeSettled(firstPath, makeLog("capped-a"));
		writeSettled(secondPath, makeLog("capped-b"));

		const result = await runTranscriptRecoveryScan(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			maxDiscoveredFiles: 1,
			maxFiles: 10,
		});
		expect(result.discovered).toBe(1);
		const frontier = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT cursor_path FROM transcript_recovery_frontiers WHERE agent_id = ? AND harness = ?")
					.get("agent-a", "claude-code") as { cursor_path?: string } | null,
		);
		expect(frontier?.cursor_path === firstPath || frontier?.cursor_path === secondPath).toBe(true);
	});

	it("keeps the parent responsive when the recovery child dies and resumes its durable frontier", async () => {
		const firstPath = join(claudeRoot, "-repo", "a-child-death.jsonl");
		const secondPath = join(claudeRoot, "-repo", "b-child-death.jsonl");
		const makeLog = (sessionId: string) => JSON.stringify({ sessionId, message: { role: "user", content: sessionId } });
		writeSettled(firstPath, makeLog("child-death-a"));
		writeSettled(secondPath, makeLog("child-death-b"));
		await runTranscriptRecoveryScan(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			maxFiles: 1,
		});

		const holdFile = join(dir, "hold-recovery-child");
		writeFileSync(holdFile, "hold");
		process.env.SIGNET_TRANSCRIPT_RECOVERY_TEST_HOLD_FILE = holdFile;
		const killed = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
		});
		let childPid: number | null = null;
		for (let attempt = 0; attempt < 100 && childPid === null; attempt++) {
			childPid = killed.childPid;
			if (childPid === null) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(childPid).not.toBeNull();
		if (childPid !== null) process.kill(childPid, "SIGKILL");
		await killed.stop();

		rmSync(holdFile, { force: true });
		const resumed = startTranscriptRecoveryWorker(getDbAccessor(), dir, "agent-a", {
			roots: { claudeCode: claudeRoot, codex: codexRoot },
			intervalMs: 60_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		await resumed.stop();
		const jobs = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT transcript_path FROM transcript_capture_jobs ORDER BY transcript_path").all(),
		) as Array<{ transcript_path: string }>;
		expect(jobs.map((job) => job.transcript_path)).toEqual([firstPath, secondPath]);
	});

	it("closes the recovery database when its daemon parent is killed", async () => {
		const databasePath = join(dir, "recovery-lock.db");
		const childPath = join(dir, "locking-recovery-child.ts");
		const harnessPath = join(dir, "recovery-parent-harness.ts");
		const childPidPath = join(dir, "locking-child.pid");
		const supervisorPidPath = join(dir, "recovery-supervisor.pid");
		writeFileSync(
			childPath,
			[
				'import { Database } from "bun:sqlite";',
				'import { writeFileSync } from "node:fs";',
				`const db = new Database(${JSON.stringify(databasePath)});`,
				'db.exec("CREATE TABLE IF NOT EXISTS lifecycle_lock (value INTEGER)");',
				'db.exec("BEGIN IMMEDIATE");',
				'db.prepare("INSERT INTO lifecycle_lock (value) VALUES (1)").run();',
				`writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
				"setInterval(() => {}, 1_000);",
			].join("\n"),
		);
		const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), "transcript-recovery-supervisor.ts");
		writeFileSync(
			harnessPath,
			[
				'import { spawn } from "node:child_process";',
				`const supervisor = spawn(process.execPath, [${JSON.stringify(supervisorPath)}], {`,
				`env: { ...process.env, SIGNET_TRANSCRIPT_RECOVERY_CHILD_PATH: ${JSON.stringify(childPath)} },`,
				'stdio: ["pipe", "ignore", "ignore"],',
				"});",
				`require("node:fs").writeFileSync(${JSON.stringify(supervisorPidPath)}, String(supervisor.pid));`,
				"setInterval(() => {}, 1_000);",
			].join("\n"),
		);
		const parent = spawn(process.execPath, [harnessPath], { stdio: "ignore" });
		try {
			for (let attempt = 0; attempt < 200 && !existsSync(childPidPath); attempt++) await Bun.sleep(5);
			expect(existsSync(childPidPath)).toBe(true);
			parent.kill("SIGKILL");
			let childAlive = true;
			for (let attempt = 0; attempt < 200 && childAlive; attempt++) {
				try {
					process.kill(Number(readFileSync(childPidPath, "utf8")), 0);
				} catch {
					childAlive = false;
				}
				if (childAlive) await Bun.sleep(5);
			}
			expect(childAlive).toBe(false);
			let supervisorAlive = true;
			try {
				process.kill(Number(readFileSync(supervisorPidPath, "utf8")), 0);
			} catch {
				supervisorAlive = false;
			}
			expect(supervisorAlive).toBe(false);
			const database = new Database(databasePath);
			try {
				database.exec("PRAGMA busy_timeout = 1000");
				database.exec("BEGIN IMMEDIATE");
				database.exec("ROLLBACK");
			} finally {
				database.close();
			}
		} finally {
			parent.kill("SIGKILL");
		}
	}, 15_000);
});

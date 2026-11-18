import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
import type { TranscriptDeleteResult } from "./session-transcript-lifecycle";
import { canonicalTranscriptPath, withTranscriptFileLock } from "./transcript-jsonl";

test("capture admission does not put canonical file I/O in the serial owner queue", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-capture-admission-"));
	mkdirSync(join(root, "memory"));
	const owner = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
	try {
		await owner.start();
		await owner.initialize(root);
		await withTranscriptFileLock(canonicalTranscriptPath(root, "budget"), async () => {
			const result = await owner.submit(
				{
					kind: "session_transcript_capture",
					input: {
						kind: "turns",
						input: {
							basePath: root,
							agentId: "a",
							sessionKey: "unrelated",
							harness: "budget",
							sourceFormat: "live",
							capturedAt: new Date().toISOString(),
							turns: [{ role: "user", content: "new" }],
						},
					},
				},
				{ operation: "test.capture-admission", lane: "write", deadlineMs: 150 },
			).result;
			expect(result).toMatchObject({ status: "admitted" });
			expect(
				await owner.submit(
					{ kind: "query", statement: { sql: "SELECT 1 AS ready", result: "get", readonly: true } },
					{ operation: "test.after-admission", lane: "read", deadlineMs: 150 },
				).result,
			).toEqual({ ready: 1 });
		});
	} finally {
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);

test("owner capture refuses a missing workspace instead of using its bound root", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-capture-workspace-"));
	mkdirSync(join(root, "memory"));
	const owner = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
	try {
		await owner.start();
		await owner.initialize(root);
		const input = {
			basePath: root,
			agentId: "a",
			sessionKey: "missing-workspace",
			harness: "budget",
			sourceFormat: "live" as const,
			turns: [{ role: "user" as const, content: "new" }],
		};
		await owner.submit(
			{ kind: "session_transcript_capture", input: { kind: "turns", input } },
			{ operation: "test.bind-workspace", lane: "write", deadlineMs: 1000 },
		).result;
		Reflect.deleteProperty(input, "basePath");
		await expect(
			owner.submit(
				{ kind: "session_transcript_capture", input: { kind: "turns", input } },
				{ operation: "test.capture-workspace", lane: "write", deadlineMs: 1000 },
			).result,
		).rejects.toThrow("explicit workspace");
	} finally {
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);

test("queued transcript deletion uses the remaining owner deadline and resumes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-delete-budget-"));
	mkdirSync(join(root, "memory"));
	const owner = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
	let release = (): void => {};
	let held: Promise<void> | undefined;
	let capture: Promise<unknown> | undefined;
	try {
		await owner.start();
		await owner.initialize(root);
		await owner.submit(
			{
				kind: "session_transcript_write",
				input: {
					agentId: "agent-a",
					sessionKey: "budget-delete",
					harness: "budget",
					project: "project-a",
					transcript: "User: private budget evidence",
				},
			},
			{ operation: "test.seed", lane: "write", deadlineMs: 5000 },
		).result;
		let acquired = (): void => {};
		const ready = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		held = withTranscriptFileLock(canonicalTranscriptPath(root, "budget"), async () => {
			acquired();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		await ready;
		const input = { basePath: root, agentId: "agent-a", sessionKey: "budget-delete", hard: false, changedBy: "test" };
		const blocker = owner.submit(
			{ kind: "session_transcript_delete", input },
			{ operation: "test.blocker", lane: "write", deadlineMs: 5000 },
		);
		capture = blocker.result.catch((error: unknown) => error);
		const until = Date.now() + 2000;
		while (owner.health().activeJobId !== blocker.job.id && Date.now() < until)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(owner.health().activeJobId).toBe(blocker.job.id);
		const result = await owner.submit<TranscriptDeleteResult>(
			{ kind: "session_transcript_delete", input },
			{ operation: "test.queued-delete", lane: "write", deadlineMs: 450 },
		).result;
		expect(result).toMatchObject({ status: "pending", generation: 1 });
		release();
		await held;
		expect(await capture).toMatchObject({
			status: "pending",
			pendingReason: expect.stringContaining("transcript lock"),
		});
		const resumed = await owner.submit<TranscriptDeleteResult>(
			{ kind: "session_transcript_delete", input },
			{ operation: "test.resume-delete", lane: "write", deadlineMs: 5000 },
		).result;
		expect(resumed).toMatchObject({ status: "complete", generation: 1, counts: { transcripts: 1 } });
	} finally {
		release();
		await held;
		await capture;
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);

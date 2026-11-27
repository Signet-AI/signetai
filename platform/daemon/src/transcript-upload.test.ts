import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor, prepareTypedStatement } from "./db-accessor";
import * as runtime from "./db-owner-runtime";
import { dbOwnerAgentRemove, dbOwnerCommitTranscriptUpload, getDbOwnerForAccessor } from "./db-owner-runtime";
import { deleteSessionTranscript } from "./session-transcript-lifecycle";
import {
	getStoredSessionTranscriptInfoAsync,
	readTranscriptUploadStateInDb,
	upsertSessionTranscriptAsync,
} from "./session-transcripts";
import { MAX_TRANSCRIPT_UPLOAD_BYTES } from "@signet/core/transcript-upload";
import { getTranscriptCaptureStatus, runTranscriptCaptureOnce } from "./transcript-capture-worker";
import * as safeFs from "./transcript-import-safe-fs";
import {
	type TranscriptUploadEnd,
	type TranscriptUploadRead,
	type TranscriptUploadRequest,
	drainTranscriptUploadPurges,
	endTranscriptUpload,
	readTranscriptUploadContent,
	stopTranscriptUploadPurges,
	uploadTranscriptRange,
} from "./transcript-upload";
import { TranscriptUploadAdmission, withTranscriptUploadAgentLock } from "./transcript-upload-agent-lock";
import {
	readTranscriptUploadPrefix,
	transcriptUploadAgentDirectory,
	transcriptUploadAgentRelativePath,
	transcriptUploadEpochDirectory,
	transcriptUploadFilePath,
	transcriptUploadSessionDirectory,
} from "./transcript-upload-paths";

let dir = "";
const previousSignetPath = process.env.SIGNET_PATH;

function sha(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("transcript upload ranges", () => {
	afterEach(async () => {
		await stopTranscriptUploadPurges();
		await closeDbAccessor();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
		if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousSignetPath;
	});

	function init(): void {
		dir = mkdtempSync(join(tmpdir(), "signet-transcript-upload-file-"));
		process.env.SIGNET_PATH = dir;
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	}

	function request(
		body: string,
		overrides: Partial<Omit<TranscriptUploadRequest, "admission">> = {},
	): TranscriptUploadRequest {
		const bytes = Buffer.from(body);
		const input = {
			basePath: dir,
			agentId: "noam",
			sessionKey: "sess-1",
			sessionId: "sess-1",
			harness: "codex",
			project: "/repo",
			projectScoped: false,
			generation: 0,
			offset: 0,
			checksum: sha(bytes),
			body: bytes,
			capturedAt: "2026-11-26T10:00:00.000Z",
			...overrides,
		};
		return { admission: TranscriptUploadAdmission.admit(input.agentId), ...input };
	}

	async function uploadPurges(): Promise<string[]> {
		return (
			await getDbAccessor().withReadDbAsync((db) =>
				prepareTypedStatement<{ path: string }>(
					db,
					"SELECT path FROM session_transcript_upload_purges WHERE drained_at IS NULL",
				).all(),
			)
		).map((row) => row.path);
	}

	function file(generation = 0): string {
		return transcriptUploadFilePath(dir, "noam", 0, "sess-1", generation);
	}

	function end(): TranscriptUploadEnd {
		return {
			basePath: dir,
			agentId: "noam",
			sessionKey: "sess-1",
			endedAt: "2026-11-26T11:00:00.000Z",
		};
	}

	function read(maxBytes = 1024): TranscriptUploadRead {
		return { basePath: dir, agentId: "noam", sessionKey: "sess-1", maxBytes };
	}

	async function captureJobs(): Promise<Array<{ id: string; status: string; ended_at: string | null }>> {
		return await getDbAccessor().withReadDbAsync((db) =>
			prepareTypedStatement<{ id: string; status: string; ended_at: string | null }>(
				db,
				"SELECT id, status, ended_at FROM transcript_capture_jobs WHERE agent_id = ?",
			).all("noam"),
		);
	}

	it("appends each range at the committed offset and hashes the committed tail", async () => {
		init();
		const first = await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		expect(first).toMatchObject({ status: "committed", state: { committedOffset: 8 } });
		const second = await uploadTranscriptRange(getDbAccessor(), request('{"b":2}\n', { offset: 8 }));
		expect(second).toEqual({
			status: "committed",
			state: {
				harness: "codex",
				project: "/repo",
				generation: 0,
				committedOffset: 16,
				tailSha256: sha('{"a":1}\n{"b":2}\n'),
			},
			jobId: expect.any(String),
		});
		expect(readFileSync(file(), "utf8")).toBe('{"a":1}\n{"b":2}\n');
	});

	it("rejects an empty or corrupted body before touching the file", async () => {
		init();
		const accessor = getDbAccessor();
		expect(await uploadTranscriptRange(accessor, request(""))).toEqual({ status: "invalid", reason: "empty" });
		expect(await uploadTranscriptRange(accessor, request('{"a":1}\n', { checksum: sha("other") }))).toEqual({
			status: "invalid",
			reason: "checksum",
		});
		expect(existsSync(file())).toBe(false);
	});

	it("leaves the committed bytes alone when the offset is behind", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		const stale = await uploadTranscriptRange(getDbAccessor(), request('{"z":9}\n'));
		expect(stale).toMatchObject({ status: "offset_mismatch", state: { committedOffset: 8 } });
		expect(readFileSync(file(), "utf8")).toBe('{"a":1}\n');
	});

	it("drops uncommitted bytes before writing the next range", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		appendFileSync(file(), '{"partial"');
		expect((await readTranscriptUploadPrefix(dir, file(), 8)).toString("utf8")).toBe('{"a":1}\n');
		await uploadTranscriptRange(getDbAccessor(), request('{"b":2}\n', { offset: 8 }));
		expect(readFileSync(file(), "utf8")).toBe('{"a":1}\n{"b":2}\n');
	});

	it("removes the bytes of a range that the commit rejects", async () => {
		init();
		await upsertSessionTranscriptAsync("sess-1", "User: hello", "codex", "/other", "noam");
		expect(await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'))).toEqual({
			status: "project_mismatch",
		});
		expect(existsSync(file())).toBe(false);
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n', { project: "/other" }));
		expect(await uploadTranscriptRange(getDbAccessor(), request('{"b":2}\n', { offset: 8 }))).toEqual({
			status: "project_mismatch",
		});
		expect(readFileSync(file(), "utf8")).toBe('{"a":1}\n');
	});

	it("refuses a range when the stored transcript belongs to another harness", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		await upsertSessionTranscriptAsync("sess-1", "User: hello", "pi", "/repo", "noam");
		expect(await uploadTranscriptRange(accessor, request('{"b":2}\n', { offset: 8 }))).toEqual({
			status: "harness_mismatch",
		});
		expect(readFileSync(file(), "utf8")).toBe('{"a":1}\n');
	});

	it("keeps the stored project when a projectless range continues the session", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		expect(await uploadTranscriptRange(accessor, request('{"b":2}\n', { offset: 8, project: null }))).toMatchObject({
			status: "committed",
			state: { project: "/repo" },
		});
		const job = await accessor.withReadDbAsync((db) =>
			prepareTypedStatement<{ project: string | null }>(
				db,
				"SELECT project FROM transcript_capture_jobs WHERE agent_id = ? AND session_key = ?",
			).get("noam", "sess-1"),
		);
		expect(job?.project).toBe("/repo");
	});

	it("refuses every same-session range queued before a purge", async () => {
		init();
		const accessor = getDbAccessor();
		const uploads: Promise<unknown>[] = [];
		await withTranscriptUploadAgentLock("noam", "exclusive", async () => {
			uploads.push(uploadTranscriptRange(accessor, request('{"a":1}\n')));
			uploads.push(uploadTranscriptRange(accessor, request('{"b":2}\n')));
			await Bun.sleep(20);
		});
		expect(await Promise.all(uploads)).toEqual([{ status: "purge_pending" }, { status: "purge_pending" }]);
		expect(existsSync(file())).toBe(false);
		expect(await accessor.withReadDbAsync((db) => readTranscriptUploadStateInDb(db, "noam", "sess-1"))).toBeNull();
		expect((await getTranscriptCaptureStatus(accessor, "noam")).pending).toBe(0);
	});

	it("removes the first range when the directory sync fails before the commit", async () => {
		init();
		const open = safeFs.openContainedTranscriptFile;
		const failing = spyOn(safeFs, "openContainedTranscriptFile").mockImplementation(
			async (root, path, flags, mode, beforeOpen) => {
				if ((flags & constants.O_DIRECTORY) !== 0) throw new Error("sync failed");
				return await open(root, path, flags, mode, beforeOpen);
			},
		);
		try {
			await expect(uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'))).rejects.toThrow("sync failed");
		} finally {
			failing.mockRestore();
		}
		expect(existsSync(file())).toBe(false);
	});

	it("creates no file for a continuation whose file is missing", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		rmSync(file());
		await expect(uploadTranscriptRange(accessor, request('{"b":2}\n', { offset: 8 }))).rejects.toThrow();
		expect(existsSync(file())).toBe(false);
	});

	it("removes upload files of a deleted session that has no upload row", async () => {
		init();
		await upsertSessionTranscriptAsync("sess-1", "User: hello", "codex", "/repo", "noam");
		mkdirSync(transcriptUploadSessionDirectory(dir, "noam", 0, "sess-1"), { recursive: true });
		writeFileSync(file(), '{"a":1}\n');
		let result = await deleteSessionTranscript({
			agentId: "noam",
			sessionKey: "sess-1",
			hard: false,
			changedBy: "test",
		});
		for (let i = 0; result.status === "pending" && i < 20; i++)
			result = await deleteSessionTranscript({ agentId: "noam", sessionKey: "sess-1", hard: false, changedBy: "test" });
		expect(result.status).toBe("complete");
		expect(existsSync(transcriptUploadSessionDirectory(dir, "noam", 0, "sess-1"))).toBe(false);
	});

	it("writes a new generation to its own file and keeps the old bytes", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		const reset = await uploadTranscriptRange(getDbAccessor(), request('{"x":1}\n', { generation: 1 }));
		expect(reset).toMatchObject({ status: "committed", state: { generation: 1, committedOffset: 8 } });
		expect(readFileSync(file(0), "utf8")).toBe('{"a":1}\n');
		expect(readFileSync(file(1), "utf8")).toBe('{"x":1}\n');
	});

	it("captures only the committed prefix of an upload file", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(
			accessor,
			request('{"role":"user","content":"hello upload"}\n', { harness: "pi", sessionKey: "sess-1" }),
		);
		appendFileSync(file(), '{"role":"user","content":"uncommitted words"}\n');
		expect(await runTranscriptCaptureOnce(accessor, dir)).toBe(true);
		expect((await getTranscriptCaptureStatus(accessor, "noam")).completed).toBe(1);
		const stored = await getStoredSessionTranscriptInfoAsync("sess-1", "noam", accessor);
		expect(stored?.content).toContain("hello upload");
		expect(stored?.content).not.toContain("uncommitted words");
	});

	it("removes the upload state, every generation file, and the capture job when the session is deleted", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		await uploadTranscriptRange(accessor, request('{"x":1}\n', { generation: 1 }));
		let result = await deleteSessionTranscript({
			agentId: "noam",
			sessionKey: "sess-1",
			hard: false,
			changedBy: "test",
		});
		for (let i = 0; result.status === "pending" && i < 20; i++)
			result = await deleteSessionTranscript({ agentId: "noam", sessionKey: "sess-1", hard: false, changedBy: "test" });
		expect(result.status).toBe("complete");
		expect(existsSync(transcriptUploadSessionDirectory(dir, "noam", 0, "sess-1"))).toBe(false);
		expect(await accessor.withReadDbAsync((db) => readTranscriptUploadStateInDb(db, "noam", "sess-1"))).toBeNull();
		expect((await getTranscriptCaptureStatus(accessor, "noam")).pending).toBe(0);
	});

	it("removes captured upload files when the session is deleted", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"role":"user","content":"hello upload"}\n', { harness: "pi" }));
		expect(await runTranscriptCaptureOnce(accessor, dir)).toBe(true);
		let result = await deleteSessionTranscript({
			agentId: "noam",
			sessionKey: "sess-1",
			hard: false,
			changedBy: "test",
		});
		for (let i = 0; result.status === "pending" && i < 20; i++)
			result = await deleteSessionTranscript({ agentId: "noam", sessionKey: "sess-1", hard: false, changedBy: "test" });
		expect(result.status).toBe("complete");
		expect(existsSync(transcriptUploadSessionDirectory(dir, "noam", 0, "sess-1"))).toBe(false);
	});

	it("keeps a recreated agent's upload apart from a pending purge", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"old":1}\n'));
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		expect(
			await uploadTranscriptRange(getDbAccessor(), request('{"new":1}\n', { sessionKey: "sess-2" })),
		).toMatchObject({ status: "committed" });
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(existsSync(transcriptUploadEpochDirectory(dir, "noam", 0))).toBe(false);
		expect(readFileSync(transcriptUploadFilePath(dir, "noam", 1, "sess-2", 0), "utf8")).toBe('{"new":1}\n');
	});

	it("refuses a commit that read the scope before a purge of its agent", async () => {
		init();
		const accessor = getDbAccessor();
		await accessor.withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		const result = await dbOwnerCommitTranscriptUpload(
			await getDbOwnerForAccessor(accessor),
			{
				agentId: "noam",
				sessionKey: "sess-1",
				sessionId: "sess-1",
				harness: "codex",
				project: "/repo",
				projectScoped: false,
				purgeEpoch: 0,
				generation: 0,
				expectedOffset: 0,
				tailSha256: sha('{"a":1}\n'),
				source: { path: file(), sizeBytes: 8, mtimeMs: 1 },
				endsRecord: true,
				capturedAt: "2026-11-26T10:00:00.000Z",
			},
			{ operation: "test.transcript-upload.commit" },
		);
		expect(result).toEqual({ status: "purge_pending" });
		expect(await accessor.withReadDbAsync((db) => readTranscriptUploadStateInDb(db, "noam", "sess-1"))).toBeNull();
		expect((await getTranscriptCaptureStatus(accessor, "noam")).pending).toBe(0);
		expect(await uploadPurges()).toEqual([]);
		expect(await uploadTranscriptRange(accessor, request('{"a":1}\n'))).toMatchObject({ status: "committed" });
		expect(existsSync(transcriptUploadFilePath(dir, "noam", 1, "sess-1", 0))).toBe(true);
	});

	it("purges the bytes of an upload in flight whose commit outcome stays unknown", async () => {
		init();
		const accessor = getDbAccessor();
		await accessor.withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO agents (id, name, read_policy, created_at, updated_at) VALUES ('noam', 'noam', 'isolated', 'now', 'now')",
			).run();
		});
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		const read = runtime.dbOwnerReadTranscriptUploadScope;
		let reads = 0;
		const scopes = spyOn(runtime, "dbOwnerReadTranscriptUploadScope").mockImplementation(
			async (owner, input, options) => {
				reads += 1;
				if (reads === 2) throw new Error("owner down");
				return await read(owner, input, options);
			},
		);
		let purge: Promise<unknown> = Promise.resolve();
		let purgedDuringUpload = true;
		const commits = spyOn(runtime, "dbOwnerCommitTranscriptUpload").mockImplementationOnce(async () => {
			purge = dbOwnerAgentRemove(
				{ agentId: "noam", mode: "purge", changedBy: "test", changedAt: "2026-11-26T10:00:00.000Z" },
				{ operation: "test.agent.purge" },
			);
			await Bun.sleep(100);
			purgedDuringUpload = (await uploadPurges()).length > 0;
			throw new Error("owner down");
		});
		try {
			await expect(
				uploadTranscriptRange(accessor, request('{"stale":1}\n', { sessionKey: "sess-3", sessionId: "sess-3" })),
			).rejects.toThrow("owner down");
		} finally {
			scopes.mockRestore();
			commits.mockRestore();
		}
		expect(purgedDuringUpload).toBe(false);
		expect(existsSync(transcriptUploadFilePath(dir, "noam", 0, "sess-3", 0))).toBe(true);
		await purge;
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(existsSync(transcriptUploadEpochDirectory(dir, "noam", 0))).toBe(false);
		expect(
			await uploadTranscriptRange(accessor, request('{"new":1}\n', { sessionKey: "sess-2", sessionId: "sess-2" })),
		).toMatchObject({ status: "committed" });
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(readFileSync(transcriptUploadFilePath(dir, "noam", 1, "sess-2", 0), "utf8")).toBe('{"new":1}\n');
	});

	it("removes the bytes of a range whose commit fails while the daemon keeps running", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"keep":1}\n', { sessionKey: "sess-2", sessionId: "sess-2" }));
		const failing = spyOn(runtime, "dbOwnerCommitTranscriptUpload").mockRejectedValueOnce(new Error("owner down"));
		try {
			await expect(uploadTranscriptRange(accessor, request('{"lost":1}\n'))).rejects.toThrow("owner down");
		} finally {
			failing.mockRestore();
		}
		expect(existsSync(file())).toBe(false);
		expect(readFileSync(transcriptUploadFilePath(dir, "noam", 0, "sess-2", 0), "utf8")).toBe('{"keep":1}\n');
	});

	it("keeps the bytes of a range that committed before the owner reply was lost", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		const commit = runtime.dbOwnerCommitTranscriptUpload;
		const lost = spyOn(runtime, "dbOwnerCommitTranscriptUpload").mockImplementationOnce(
			async (owner, input, options) => {
				await commit(owner, input, options);
				throw new Error("owner reply lost");
			},
		);
		try {
			await expect(uploadTranscriptRange(accessor, request('{"b":2}\n', { offset: 8 }))).rejects.toThrow(
				"owner reply lost",
			);
		} finally {
			lost.mockRestore();
		}
		expect(readFileSync(file(), "utf8")).toBe('{"a":1}\n{"b":2}\n');
		expect(await uploadTranscriptRange(accessor, request('{"c":3}\n', { offset: 16 }))).toMatchObject({
			status: "committed",
		});
	});

	it("stops at its deadline when another request arrives during a pass and runs that request next", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		const drain = runtime.dbOwnerDrainTranscriptUploadPurges;
		let passes = 0;
		const spy = spyOn(runtime, "dbOwnerDrainTranscriptUploadPurges").mockImplementation(
			async (owner, input, options) => {
				passes += 1;
				if (passes === 1) void drainTranscriptUploadPurges(dir);
				return await drain(owner, input, options);
			},
		);
		try {
			expect(await drainTranscriptUploadPurges(dir, { deadlineMs: 0 })).toEqual({ status: "pending" });
			expect(passes).toBe(1);
			for (let i = 0; i < 100 && passes < 2; i++) await Bun.sleep(100);
		} finally {
			spy.mockRestore();
		}
		expect(passes).toBe(2);
		expect(existsSync(transcriptUploadEpochDirectory(dir, "noam", 0))).toBe(false);
	});

	it("retries a failed drain pass and reports the failure to a request that joined it", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		let joined: Promise<unknown> = Promise.resolve();
		const failing = spyOn(runtime, "dbOwnerDrainTranscriptUploadPurges").mockImplementationOnce(async () => {
			joined = drainTranscriptUploadPurges(dir);
			throw new Error("owner down");
		});
		try {
			expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "failed", error: "owner down" });
			expect(await joined).toEqual({ status: "failed", error: "owner down" });
			for (let i = 0; i < 100 && (await uploadPurges()).length > 0; i++) await Bun.sleep(100);
		} finally {
			failing.mockRestore();
		}
		expect(await uploadPurges()).toEqual([]);
		expect(existsSync(transcriptUploadEpochDirectory(dir, "noam", 0))).toBe(false);
	});

	it("removes more files than the old pass cap in one drain request", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		for (let generation = 1; generation <= 16_500; generation++) writeFileSync(file(generation), "x\n");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(existsSync(transcriptUploadAgentDirectory(dir, "noam"))).toBe(false);
	}, 120_000);

	it("continues a drain that reached its deadline", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		for (let generation = 1; generation <= 600; generation++) writeFileSync(file(generation), "x\n");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		expect(await drainTranscriptUploadPurges(dir, { deadlineMs: 0 })).toEqual({ status: "pending" });
		for (let i = 0; i < 100 && (await uploadPurges()).length > 0; i++) await Bun.sleep(100);
		expect(await uploadPurges()).toEqual([]);
		expect(existsSync(transcriptUploadAgentDirectory(dir, "noam"))).toBe(false);
	});

	it("finishes a purge in the background after the caller stops waiting", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		for (let generation = 1; generation <= 600; generation++) writeFileSync(file(generation), "x\n");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		expect(await drainTranscriptUploadPurges(dir, { waitMs: 0 })).toEqual({ status: "pending" });
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(existsSync(transcriptUploadAgentDirectory(dir, "noam"))).toBe(false);
		expect(await uploadPurges()).toEqual([]);
	});

	it("keeps draining while each pass removes part of a large tree", async () => {
		init();
		await uploadTranscriptRange(getDbAccessor(), request('{"a":1}\n'));
		for (let generation = 1; generation <= 600; generation++) writeFileSync(file(generation), "x\n");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("INSERT INTO session_transcript_upload_purges (path, epoch, requested_at) VALUES (?, 1, 'now')").run(
				transcriptUploadAgentRelativePath("noam"),
			);
		});
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(existsSync(transcriptUploadAgentDirectory(dir, "noam"))).toBe(false);
	});

	it("records a durable purge intent with the agent purge and removes the agent's upload files on drain", async () => {
		init();
		const accessor = getDbAccessor();
		await accessor.withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO agents (id, name, read_policy, created_at, updated_at) VALUES ('noam', 'noam', 'isolated', 'now', 'now')",
			).run();
		});
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		await uploadTranscriptRange(accessor, request('{"b":1}\n', { sessionKey: "sess-2", sessionId: "sess-2" }));
		await uploadTranscriptRange(accessor, request('{"c":1}\n', { agentId: "other" }));
		const removed = await dbOwnerAgentRemove(
			{ agentId: "noam", mode: "purge", changedBy: "test", changedAt: "2026-11-26T10:00:00.000Z" },
			{ operation: "test.agent.purge" },
		);
		expect(removed.status).toBe("removed");
		expect(await uploadPurges()).toEqual([transcriptUploadAgentRelativePath("noam")]);
		expect(existsSync(transcriptUploadAgentDirectory(dir, "noam"))).toBe(true);
		expect(await drainTranscriptUploadPurges(dir)).toEqual({ status: "removed" });
		expect(existsSync(transcriptUploadAgentDirectory(dir, "noam"))).toBe(false);
		expect(existsSync(transcriptUploadFilePath(dir, "other", 0, "sess-1", 0))).toBe(true);
		expect(await uploadPurges()).toEqual([]);
	});

	it("keeps each agent's upload in its own file", () => {
		init();
		expect(transcriptUploadFilePath(dir, "noam", 0, "sess-1", 0)).not.toBe(
			transcriptUploadFilePath(dir, "other", 0, "sess-1", 0),
		);
		expect(transcriptUploadFilePath(dir, "noam", 0, "sess-1", 0)).not.toBe(
			transcriptUploadFilePath(dir, "noam", 1, "sess-1", 0),
		);
	});

	it("commits a range that ends inside a record without a capture job", async () => {
		init();
		const accessor = getDbAccessor();
		const result = await uploadTranscriptRange(accessor, request('{"a":1'));
		expect(result).toEqual({
			status: "committed",
			state: { harness: "codex", project: "/repo", generation: 0, committedOffset: 6, tailSha256: sha('{"a":1') },
			jobId: null,
		});
		expect(readFileSync(file(), "utf8")).toBe('{"a":1');
		expect((await getTranscriptCaptureStatus(accessor, "noam")).pending).toBe(0);
	});

	it("captures a record larger than one range once its last range ends the line", async () => {
		init();
		const accessor = getDbAccessor();
		const record = '{"role":"user","content":"start-' + "x".repeat(MAX_TRANSCRIPT_UPLOAD_BYTES) + '-end"}\n';
		const firstRange = record.slice(0, MAX_TRANSCRIPT_UPLOAD_BYTES);
		const secondRange = record.slice(MAX_TRANSCRIPT_UPLOAD_BYTES);
		const firstResult = await uploadTranscriptRange(accessor, request(firstRange, { harness: "pi", offset: 0 }));
		expect(firstResult).toMatchObject({
			status: "committed",
			jobId: null,
			state: { committedOffset: MAX_TRANSCRIPT_UPLOAD_BYTES },
		});
		const secondResult = await uploadTranscriptRange(
			accessor,
			request(secondRange, { harness: "pi", offset: MAX_TRANSCRIPT_UPLOAD_BYTES }),
		);
		expect(secondResult).toMatchObject({
			status: "committed",
			jobId: expect.any(String),
			state: { committedOffset: Buffer.byteLength(record) },
		});
		expect(await runTranscriptCaptureOnce(accessor, dir)).toBe(true);
		const stored = await getStoredSessionTranscriptInfoAsync("sess-1", "noam", accessor);
		expect(stored?.content).toContain("start-" + "x".repeat(MAX_TRANSCRIPT_UPLOAD_BYTES) + "-end");
	});

	it("keeps the capture job at the last complete record when a range ends inside a record", async () => {
		init();
		const accessor = getDbAccessor();
		const first = '{"role":"user","content":"complete words"}\n';
		const second = '{"role":"user","content":"partial words';
		const firstResult = await uploadTranscriptRange(accessor, request(first, { harness: "pi" }));
		expect(firstResult).toMatchObject({ status: "committed", jobId: expect.any(String) });
		const secondResult = await uploadTranscriptRange(
			accessor,
			request(second, { harness: "pi", offset: Buffer.byteLength(first) }),
		);
		expect(secondResult).toMatchObject({ status: "committed", jobId: null });
		expect(await runTranscriptCaptureOnce(accessor, dir)).toBe(true);
		const stored = await getStoredSessionTranscriptInfoAsync("sess-1", "noam", accessor);
		expect(stored?.content).toContain("complete words");
		expect(stored?.content).not.toContain("partial words");
	});

	it("attaches the session end to the upload capture job", async () => {
		init();
		const accessor = getDbAccessor();
		const uploaded = await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		if (uploaded.status !== "committed" || uploaded.jobId === null) throw new Error("upload job not queued");
		const jobId = uploaded.jobId;
		const ended = await endTranscriptUpload(accessor, end());
		expect(ended).toEqual({ status: "ended", jobId });
		expect(await captureJobs()).toEqual([{ id: jobId, status: "pending", ended_at: "2026-11-26T11:00:00.000Z" }]);
	});

	it("queues a completed upload job again with the session end", async () => {
		init();
		const accessor = getDbAccessor();
		const uploaded = await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		if (uploaded.status !== "committed" || uploaded.jobId === null) throw new Error("upload job not queued");
		const jobId = uploaded.jobId;
		expect(await runTranscriptCaptureOnce(accessor, dir)).toBe(true);
		const ended = await endTranscriptUpload(accessor, end());
		expect(ended).toEqual({ status: "ended", jobId });
		expect(await captureJobs()).toEqual([{ id: jobId, status: "pending", ended_at: "2026-11-26T11:00:00.000Z" }]);
	});

	it("ends an upload with no complete record without a capture job", async () => {
		init();
		const accessor = getDbAccessor();
		const uploaded = await uploadTranscriptRange(accessor, request('{"a":1'));
		expect(uploaded).toMatchObject({ status: "committed", jobId: null });
		const ended = await endTranscriptUpload(accessor, end());
		expect(ended).toEqual({ status: "ended", jobId: null });
		expect(await captureJobs()).toEqual([]);
	});

	it("leaves a session without an upload unchanged at its end", async () => {
		init();
		const accessor = getDbAccessor();
		const ended = await endTranscriptUpload(accessor, end());
		expect(ended).toEqual({ status: "none" });
		expect(await captureJobs()).toEqual([]);
	});

	it("reads the committed lines of an upload", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n'));
		await uploadTranscriptRange(accessor, request('{"b":2}\n', { offset: 8 }));
		expect(await readTranscriptUploadContent(accessor, read())).toBe('{"a":1}\n{"b":2}\n');
	});

	it("reads an upload up to its last complete line", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n{"b"'));
		expect(await readTranscriptUploadContent(accessor, read())).toBe('{"a":1}\n');
	});

	it("reads nothing for a session without an upload", async () => {
		init();
		const accessor = getDbAccessor();
		expect(await readTranscriptUploadContent(accessor, read())).toBe(null);
	});

	it("reads nothing from an upload with no complete line", async () => {
		init();
		const accessor = getDbAccessor();
		expect(await uploadTranscriptRange(accessor, request('{"a":1'))).toMatchObject({ status: "committed" });
		expect(await readTranscriptUploadContent(accessor, read())).toBe(null);
	});

	it("reads nothing from an upload larger than the limit", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"a":1}\n{"b":2}\n'));
		expect(await readTranscriptUploadContent(accessor, read(15))).toBe(null);
		expect(await readTranscriptUploadContent(accessor, read(16))).toBe('{"a":1}\n{"b":2}\n');
	});

	it("reads the latest generation of an upload", async () => {
		init();
		const accessor = getDbAccessor();
		await uploadTranscriptRange(accessor, request('{"old":1}\n'));
		await uploadTranscriptRange(accessor, request('{"new":1}\n', { generation: 1 }));
		expect(await readTranscriptUploadContent(accessor, read())).toBe('{"new":1}\n');
	});
});

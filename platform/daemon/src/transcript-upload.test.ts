import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor, prepareTypedStatement } from "./db-accessor";
import { dbOwnerAgentRemove } from "./db-owner-runtime";
import { deleteSessionTranscript } from "./session-transcript-lifecycle";
import {
	getStoredSessionTranscriptInfoAsync,
	readTranscriptUploadStateInDb,
	upsertSessionTranscriptAsync,
} from "./session-transcripts";
import { getTranscriptCaptureStatus, runTranscriptCaptureOnce } from "./transcript-capture-worker";
import { type TranscriptUploadRequest, drainTranscriptUploadPurges, uploadTranscriptRange } from "./transcript-upload";
import {
	readTranscriptUploadPrefix,
	transcriptUploadAgentDirectory,
	transcriptUploadAgentRelativePath,
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

	function request(body: string, overrides: Partial<TranscriptUploadRequest> = {}): TranscriptUploadRequest {
		const bytes = Buffer.from(body);
		return {
			basePath: dir,
			agentId: "noam",
			sessionKey: "sess-1",
			sessionId: "sess-1",
			harness: "codex",
			project: "/repo",
			generation: 0,
			offset: 0,
			checksum: sha(bytes),
			body: bytes,
			capturedAt: "2026-11-26T10:00:00.000Z",
			...overrides,
		};
	}

	async function uploadPurges(): Promise<string[]> {
		return (
			await getDbAccessor().withReadDbAsync((db) =>
				prepareTypedStatement<{ path: string }>(db, "SELECT path FROM session_transcript_upload_purges").all(),
			)
		).map((row) => row.path);
	}

	function file(generation = 0): string {
		return transcriptUploadFilePath(dir, "noam", "sess-1", generation);
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

	it("rejects an empty, unterminated, or corrupted body before touching the file", async () => {
		init();
		const accessor = getDbAccessor();
		expect(await uploadTranscriptRange(accessor, request(""))).toEqual({ status: "invalid", reason: "empty" });
		expect(await uploadTranscriptRange(accessor, request('{"a":1}'))).toEqual({
			status: "invalid",
			reason: "newline",
		});
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
		expect(existsSync(transcriptUploadSessionDirectory(dir, "noam", "sess-1"))).toBe(false);
		expect(await accessor.withReadDbAsync((db) => readTranscriptUploadStateInDb(db, "noam", "sess-1"))).toBeNull();
		expect((await getTranscriptCaptureStatus(accessor, "noam")).pending).toBe(0);
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
		expect(existsSync(transcriptUploadFilePath(dir, "other", "sess-1", 0))).toBe(true);
		expect(await uploadPurges()).toEqual([]);
	});

	it("keeps each agent's upload in its own file", () => {
		init();
		expect(transcriptUploadFilePath(dir, "noam", "sess-1", 0)).not.toBe(
			transcriptUploadFilePath(dir, "other", "sess-1", 0),
		);
	});
});

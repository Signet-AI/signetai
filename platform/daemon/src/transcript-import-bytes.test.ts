import { constants, mkdtempSync } from "node:fs";
import { openContainedTranscriptFile, resolveManagedTranscriptPath } from "./transcript-import-safe-fs";
import { loadSourcesConfig } from "@signet/core";
import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rm, mkdir, writeFile, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up as ledger } from "../../core/src/migrations/146-source-transcript-import";
import { up as controls } from "../../core/src/migrations/149-transcript-import-state-machine";
import { up as bytesMigration } from "../../core/src/migrations/151-transcript-import-bytes";
import { createDbOwnerClient, type DbOwnerClient } from "./db-owner-client";
import { createDbOwnerMaintenance, registerDbOwnerMaintenance } from "./db-owner-maintenance";
import { dbOwnerQuery, dbOwnerTransaction, dbOwnerTranscriptBulkCommit } from "./db-owner-runtime";
import { prepareTranscriptRetry, createJob, createOwnerTranscriptImportStore } from "./transcript-import-store";
import { startTranscriptImportWorker } from "./transcript-import-worker";
import {
	appendTranscriptChunk,
	beginTranscriptUpload,
	readTranscriptBytes,
	sealTranscriptUpload,
	transcriptUpload,
	TRANSCRIPT_CHUNK_BYTES,
	TRANSCRIPT_READ_BYTES,
	uploadTranscriptStream,
	purgeTranscriptBytes,
	cleanupCancelledTranscriptImport,
} from "./transcript-import-bytes";
import { migrateTranscriptImports } from "./transcript-import-migration";
import { buildCompletedTranscriptCommit, canonicalTranscriptLine } from "./transcript-import-commit";
import { Hono } from "hono";
import { registerTranscriptImportRoutes } from "./routes/transcript-import-routes";

let oldPath: string | undefined, oldAgent: string | undefined;
let root: string;
let owner: DbOwnerClient;
const scope = { agentId: "a", jobId: "job", fileId: "file", generation: 0 };
const checksum = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "unexpected success";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
const options = { operation: "test.import", lane: "write" } as const;
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "signet-import-bytes-"));
	oldPath = process.env.SIGNET_PATH;
	oldAgent = process.env.SIGNET_AGENT_ID;
	process.env.SIGNET_PATH = root;
	process.env.SIGNET_AGENT_ID = "a";
	const path = join(root, "test.db");
	const db = new Database(path);
	db.exec(
		"CREATE TABLE session_transcripts (session_key TEXT, agent_id TEXT, content TEXT, harness TEXT, project TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, content_hash TEXT, PRIMARY KEY(agent_id,session_key))",
	);
	ledger(db);
	controls(db);
	bytesMigration(db);
	bytesMigration(db);
	db.exec("ALTER TABLE source_import_record_attempts ADD COLUMN source_id TEXT");
	db.close(true);
	owner = createDbOwnerClient({ dbPath: path });
	await owner.start();
	registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath: path, owner }));
	await createJob({ jobId: scope.jobId, agentId: scope.agentId, files: [{ id: scope.fileId, name: "test.jsonl" }] });
});
afterEach(async () => {
	if (oldPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = oldPath;
	if (oldAgent === undefined) delete process.env.SIGNET_AGENT_ID;
	else process.env.SIGNET_AGENT_ID = oldAgent;
	registerDbOwnerMaintenance(null);
	await owner?.close();
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(root, { recursive: true, force: true });
			break;
		} catch (error) {
			if (attempt === 5 || !(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
});

test("owner persists chunks across restart, rejects cross-agent access and seals exact bytes", async () => {
	expect(await dbOwnerQuery({ sql: "PRAGMA synchronous", result: "get", readonly: false }, options)).toEqual({
		synchronous: 2,
	});
	const first = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES, 65);
	const last = Buffer.from("\r\nmalformed\n");
	await beginTranscriptUpload(scope, first.length + last.length);
	await appendTranscriptChunk(scope, 0, first, checksum(first));
	expect(
		await failure(appendTranscriptChunk({ ...scope, agentId: "b" }, first.length, last, checksum(last))),
	).toContain("not found");
	await owner.close();
	owner = createDbOwnerClient({ dbPath: join(root, "test.db") });
	await owner.start();
	registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath: join(root, "test.db"), owner }));
	expect((await transcriptUpload(scope)).upload_offset).toBe(first.length);
	expect(await appendTranscriptChunk(scope, 0, first, checksum(first))).toBe(first.length);
	expect(
		await failure(
			appendTranscriptChunk(scope, 0, Buffer.alloc(first.length, 66), checksum(Buffer.alloc(first.length, 66))),
		),
	).toContain("replay");
	await appendTranscriptChunk(scope, first.length, last, checksum(last));
	const sealed = await sealTranscriptUpload(scope);
	expect(sealed.content_hash).toBe(checksum(Buffer.concat([first, last])));
	expect(await readTranscriptBytes(scope, first.length)).toEqual(last);
	expect(await failure(appendTranscriptChunk(scope, 0, first, checksum(first)))).toContain("not writable");
	expect(await failure(readTranscriptBytes({ ...scope, agentId: "b" }, 0))).toContain("unavailable");
}, 20_000);

test("concurrent identical first PATCHes declare once and replay without conflicts", async () => {
	const app = new Hono();
	registerTranscriptImportRoutes(app);
	const bytes = Buffer.alloc(1024 * 1024, 73);
	const send = (body: Buffer) =>
		app.request("/api/sources/imports/job/files/file?agentId=a", {
			method: "PATCH",
			headers: {
				"upload-length": String(bytes.length),
				"upload-offset": "0",
				"upload-generation": "0",
				"upload-checksum": checksum(body),
			},
			body,
		});
	const responses = await Promise.all(Array.from({ length: 4 }, () => send(bytes)));
	expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
	for (const response of responses) expect(await response.json()).toEqual({ offset: bytes.length, generation: 0 });
	expect((await send(Buffer.alloc(bytes.length, 74))).status).toBe(409);
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT count(*) AS n FROM source_import_chunks", result: "get", readonly: true },
			options,
		),
	).toEqual({ n: 16 });
}, 20_000);

test("sealing batches chunk reads across the owner boundary while preserving exact hashes", async () => {
	const bytes = Buffer.alloc(1024 * 1024, 71);
	const count = 64;
	await beginTranscriptUpload(scope, bytes.length * count);
	const expected = createHash("sha256");
	for (let part = 0; part < count; part++) {
		expected.update(bytes);
		await appendTranscriptChunk(scope, part * bytes.length, bytes, checksum(bytes));
	}
	const calls = spyOn(owner, "submit");
	try {
		const sealed = await sealTranscriptUpload(scope);
		expect(sealed.content_hash).toBe(expected.digest("hex"));
		// Bounded batch reads, two metadata reads, one sealing transaction.
		expect(calls.mock.calls.length).toBe(Math.ceil((bytes.length * count) / TRANSCRIPT_READ_BYTES) + 3);
	} finally {
		calls.mockRestore();
	}
	expect(await readTranscriptBytes(scope, 17, TRANSCRIPT_READ_BYTES)).toEqual(
		bytes.subarray(17, 17 + TRANSCRIPT_READ_BYTES),
	);
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_chunks SET checksum = 'corrupt' WHERE byte_offset = ?",
				params: [TRANSCRIPT_CHUNK_BYTES],
				result: "run",
			},
		],
		options,
	);
	expect(await failure(readTranscriptBytes(scope, 0, TRANSCRIPT_READ_BYTES))).toContain("checksum mismatch");
}, 60_000);

test("owner rolls back evidence when ledger write fails and preserves imported outcome on replay", async () => {
	await dbOwnerTransaction(
		[
			{ sql: "UPDATE source_import_jobs SET state = 'running', lease_token = 'lease' WHERE id = 'job'", result: "run" },
			{
				sql: "INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status) VALUES ('r','job','file','s','a',1,1,0,1,'hash','pending')",
				result: "run",
			},
			{
				sql: "CREATE TRIGGER fail_attempt BEFORE INSERT ON source_import_record_attempts BEGIN SELECT RAISE(ABORT, 'test ledger failure'); END",
				result: "run",
			},
		],
		options,
	);
	const commit = buildCompletedTranscriptCommit(
		{
			source: "signet",
			id: "one",
			harness: "h",
			agent_id: "a",
			session_key: "session",
			project: null,
			timestamp: "2024-01-01T00:00:00Z",
			message_count: 1,
			messages: [{ role: "user", content: "original" }],
		},
		{ agentId: "a", sourceId: "s", sourceRecordId: "r" },
	);
	const input = {
		agentId: "a",
		jobId: "job",
		generation: 0,
		leaseToken: "lease",
		sourceId: "s",
		harness: "h",
		commits: [commit],
	};
	expect(await failure(dbOwnerTranscriptBulkCommit(input, options))).toContain("test ledger failure");
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT count(*) AS n FROM session_transcripts", result: "get", readonly: true },
			options,
		),
	).toEqual({ n: 0 });
	await dbOwnerTransaction([{ sql: "DROP TRIGGER fail_attempt", result: "run" }], options);
	expect(await dbOwnerTranscriptBulkCommit(input, options)).toMatchObject([{ outcome: "imported" }]);
	expect(await dbOwnerTranscriptBulkCommit(input, options)).toMatchObject([{ outcome: "imported" }]);
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT count(*) AS n FROM source_import_record_attempts", result: "get", readonly: true },
			options,
		),
	).toEqual({ n: 1 });
}, 20_000);

test("HTTP chunk upload, finalize and raw export work on the host platform", async () => {
	const previousAgent = process.env.SIGNET_AGENT_ID;
	const previousPath = process.env.SIGNET_PATH;
	process.env.SIGNET_AGENT_ID = "a";
	process.env.SIGNET_PATH = root;
	try {
		const app = new Hono();
		registerTranscriptImportRoutes(app);
		const content = Buffer.from("malformed but retained\r\n");
		const url = "/api/sources/imports/job/files/file";
		const uploaded = await app.request(url, {
			method: "PATCH",
			headers: { "upload-length": String(content.length), "upload-offset": "0", "upload-checksum": checksum(content) },
			body: content,
		});
		expect(uploaded.status).toBe(200);
		const finalized = await app.request(`${url}/finalize`, { method: "POST" });
		expect(finalized.status).toBe(201);
		const exported = await app.request(`${url}/content`);
		expect(exported.status).toBe(200);
		expect(Buffer.from(await exported.arrayBuffer())).toEqual(content);
		const denied = await app.request(`${url}/content?agentId=b`);
		expect(denied.status).toBe(403);
	} finally {
		if (previousAgent === undefined) delete process.env.SIGNET_AGENT_ID;
		else process.env.SIGNET_AGENT_ID = previousAgent;
		if (previousPath === undefined) delete process.env.SIGNET_PATH;
		else process.env.SIGNET_PATH = previousPath;
	}
}, 20_000);

test("worker imports mixed harnesses and malformed evidence without filesystem copies", async () => {
	const record = (id: number) =>
		JSON.stringify({
			source: "signet",
			id: String(id),
			harness: id % 2 ? "claude" : "codex",
			agent_id: "foreign",
			session_key: String(id),
			project: null,
			timestamp: "2024-01-01T00:00:00Z",
			message_count: 1,
			messages: [{ role: "tool", content: "  original\\n" }],
		});
	const content = Buffer.from(`${Array.from({ length: 60 }, (_, i) => record(i)).join("\n")}\nmalformed\n`);
	await beginTranscriptUpload(scope, content.length);
	await appendTranscriptChunk(scope, 0, content, checksum(content));
	await sealTranscriptUpload(scope);
	await dbOwnerTransaction(
		[
			{ sql: "UPDATE source_import_files SET state = 'ready', source_id = 's' WHERE id = 'file'", result: "run" },
			{
				sql: "UPDATE source_import_jobs SET state = 'queued', error = 'import worker stopped' WHERE id = 'job'",
				result: "run",
			},
		],
		options,
	);
	const worker = startTranscriptImportWorker({ store: createOwnerTranscriptImportStore(), agentId: "a", pollMs: 10 });
	try {
		const deadline = Date.now() + 10_000;
		let state: unknown;
		while (Date.now() < deadline) {
			state = await dbOwnerQuery<{ state: string; error: string | null }>(
				{
					sql: "SELECT state,total,imported,rejected,pending,error FROM source_import_jobs WHERE id = 'job'",
					result: "get",
					readonly: true,
				},
				options,
			);
			if (
				typeof state === "object" &&
				state !== null &&
				"state" in state &&
				state.state === "completed_with_rejections"
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(state).toEqual({
			state: "completed_with_rejections",
			total: 61,
			imported: 60,
			rejected: 1,
			pending: 0,
			error: null,
		});
		expect(
			await dbOwnerQuery(
				{
					sql: "SELECT count(*) AS n FROM session_transcripts WHERE agent_id = 'a' AND source_id = 's'",
					result: "get",
					readonly: true,
				},
				options,
			),
		).toEqual({ n: 60 });
	} finally {
		await worker.stop();
	}
}, 20_000);

test("pause and cancel fence stale commits; cancellation resumes bounded cleanup", async () => {
	const store = createOwnerTranscriptImportStore();
	const run = (operation: "control" | "finalize", payload: Record<string, unknown>) =>
		store.run({ kind: "source_import", operation, jobId: "job", agentId: "a", payload });
	const content = Buffer.alloc(2 * TRANSCRIPT_CHUNK_BYTES, 65);
	await beginTranscriptUpload(scope, content.length + 1);
	await appendTranscriptChunk(scope, 0, content, checksum(content));
	await dbOwnerTransaction(
		[{ sql: "UPDATE source_import_jobs SET state = 'running', lease_token = 'lease' WHERE id = 'job'", result: "run" }],
		options,
	);
	await run("control", { control: "pause" });
	expect(await failure(run("finalize", { generation: 0, leaseToken: "lease" }))).toContain("precondition");
	expect(
		await dbOwnerQuery(
			{
				sql: "SELECT state,generation,lease_token FROM source_import_jobs WHERE id = 'job'",
				result: "get",
				readonly: true,
			},
			options,
		),
	).toEqual({ state: "paused", generation: 1, lease_token: null });
	await run("control", { control: "cancel" });
	await purgeTranscriptBytes(scope, () => false);
	expect(await failure(readTranscriptBytes(scope, 0))).toContain("unavailable");
	await cleanupCancelledTranscriptImport("a", "job");
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT cleanup_state FROM source_import_jobs WHERE id = 'job'", result: "get", readonly: true },
			options,
		),
	).toEqual({ cleanup_state: "complete" });
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT count(*) AS n FROM source_import_chunks", result: "get", readonly: true },
			options,
		),
	).toEqual({ n: 0 });
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT reserved_bytes FROM source_import_capacity", result: "get", readonly: true },
			options,
		),
	).toEqual({ reserved_bytes: 0 });
}, 20_000);

test("finalize refuses pending records and rejection audit retains its source", async () => {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_jobs SET state = 'running', lease_token = 'lease', total = 1, pending = 1 WHERE id = 'job'",
				result: "run",
			},
			{ sql: "UPDATE source_import_files SET state = 'completed' WHERE id = 'file'", result: "run" },
			{
				sql: "INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status) VALUES ('r','job','file','s','a',1,1,0,1,'hash','pending')",
				result: "run",
			},
		],
		options,
	);
	const store = createOwnerTranscriptImportStore();
	const operation = { kind: "source_import", jobId: "job", agentId: "a" } as const;
	expect(
		await failure(store.run({ ...operation, operation: "finalize", payload: { generation: 0, leaseToken: "lease" } })),
	).toContain("precondition");
	await store.run({
		...operation,
		operation: "reject",
		payload: { recordId: "r", sourceId: "s", generation: 0, leaseToken: "lease", code: "malformed" },
	});
	await dbOwnerTransaction([{ sql: "DELETE FROM source_import_records WHERE id = 'r'", result: "run" }], options);
	expect(
		await dbOwnerQuery(
			{
				sql: "SELECT source_id,outcome FROM source_import_record_attempts WHERE record_id = 'r'",
				result: "get",
				readonly: true,
			},
			options,
		),
	).toEqual({ source_id: "s", outcome: "rejected" });
}, 20_000);

function http(): Hono {
	const app = new Hono();
	registerTranscriptImportRoutes(app);
	return app;
}

test("HTTP validates bounded manifests and preserves duplicate mode on Windows", async () => {
	const app = http();
	for (const files of [
		[],
		Array.from({ length: 26 }, () => ({ name: "x" })),
		[{ name: "" }],
		[{ name: "x".repeat(1025) }],
	]) {
		expect(
			(
				await app.request("/api/sources/imports", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ files }),
				})
			).status,
		).toBe(400);
	}
	const response = await app.request("/api/sources/imports", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ files: [{ name: "x" }], duplicateMode: "reimport" }),
	});
	expect(response.status).toBe(201);
	expect(await response.json()).toMatchObject({ duplicateMode: "reimport", state: "staging" });
}, 20_000);

test("concurrent chunks cannot replace bytes; interrupted reset is retryable", async () => {
	const content = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES, 65);
	await beginTranscriptUpload(scope, content.length + 1);
	const results = await Promise.allSettled([
		appendTranscriptChunk(scope, 0, content, checksum(content)),
		appendTranscriptChunk(scope, 0, content, checksum(content)),
	]);
	expect(results.some((result) => result.status === "fulfilled")).toBe(true);
	expect((await transcriptUpload(scope)).upload_offset).toBe(content.length);
	await purgeTranscriptBytes(scope, () => false);
	const reset = await http().request("/api/sources/imports/job/files/file/reset", { method: "POST" });
	expect(reset.status).toBe(200);
	expect(await reset.json()).toMatchObject({ upload_generation: 1, upload_offset: 0, storage_state: "uploading" });
	expect(await failure(appendTranscriptChunk(scope, 0, content, checksum(content)))).toContain("not writable");
}, 20_000);

test("a reset upload exports its current generation without a special read header", async () => {
	const app = http();
	expect((await app.request("/api/sources/imports/job/files/file/reset", { method: "POST" })).status).toBe(200);
	const content = Buffer.from("new generation\n"),
		resetScope = { ...scope, generation: 1 };
	await beginTranscriptUpload(resetScope, content.length);
	await appendTranscriptChunk(resetScope, 0, content, checksum(content));
	expect(
		(
			await app.request("/api/sources/imports/job/files/file/finalize", {
				method: "POST",
				headers: { "upload-generation": "1" },
			})
		).status,
	).toBe(201);
	const exported = await app.request("/api/sources/imports/job/files/file/content");
	expect(await exported.text()).toBe(content.toString());
}, 20_000);

test("failed streamed upload retains its durable prefix and cancel prevents finalization", async () => {
	const content = Buffer.alloc(1024 ** 2, 65);
	async function* broken() {
		yield content;
		throw new Error("transport interrupted");
	}
	expect(await failure(uploadTranscriptStream(scope, content.length + 1, broken()))).toContain("transport interrupted");
	expect((await transcriptUpload(scope)).upload_offset).toBe(content.length);
	const cancelled = await http().request("/api/sources/imports/job/cancel", { method: "POST" });
	expect(cancelled.status).toBe(200);
	expect((await http().request("/api/sources/imports/job/files/file/finalize", { method: "POST" })).status).toBe(409);
}, 20_000);

test("retry prepares only recoverable rejections and never reopens cancelled jobs", async () => {
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_jobs SET state = 'completed_with_rejections', rejected = 2,total = 2 WHERE id = 'job'",
				result: "run",
			},
			{
				sql: "UPDATE source_import_files SET state = 'completed',storage_state = 'sealed' WHERE id = 'file'",
				result: "run",
			},
			...["temporary", "malformed"].map((code, i) => ({
				sql: "INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,rejection_code) VALUES (?,'job','file','s','a',?,?,?,1,'hash','rejected',?)",
				params: [String(i), i + 1, i + 1, i, code],
				result: "run" as const,
			})),
		],
		options,
	);
	const app = http();
	await app.request("/api/sources/imports/job/retry", { method: "POST" });
	expect(await prepareTranscriptRetry("job", "a", 1)).toBe(true);
	expect(
		await dbOwnerQuery(
			{ sql: "SELECT pending,rejected FROM source_import_jobs WHERE id = 'job'", result: "get", readonly: true },
			options,
		),
	).toEqual({ pending: 1, rejected: 1 });
	await app.request("/api/sources/imports/job/cancel", { method: "POST" });
	const retry = await app.request("/api/sources/imports/job/retry", { method: "POST" });
	expect(await retry.json()).toMatchObject({ changed: false });
}, 20_000);

test("export preserves array messages, filters scope and streams records larger than the IPC limit", async () => {
	const messages = [
		{ role: "tool", content: `  exact\n${"x".repeat(1100 * 1024)}` },
		{ role: "unknown", content: "" },
	];
	// Fill the row in bounded owner writes, as live transcript capture does.
	await dbOwnerTransaction(
		[
			{
				sql: "INSERT INTO session_transcripts (session_key,agent_id,content,harness,created_at) VALUES ('export','a','','h','2026-01-01')",
				result: "run",
			},
		],
		options,
	);
	const content = JSON.stringify(messages);
	for (let offset = 0; offset < content.length; offset += 64 * 1024)
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE session_transcripts SET content = content || ? WHERE session_key = 'export' AND agent_id = 'a'",
					params: [content.slice(offset, offset + 64 * 1024)],
					result: "run",
				},
			],
			options,
		);
	const exported = await http().request("/api/sources/imports/export/transcripts?limit=1&json=true");
	expect(exported.status).toBe(200);
	expect(await exported.json()).toMatchObject([{ agent_id: "a", message_count: 2, messages }]);
	expect((await http().request("/api/sources/imports/export/transcripts?agentId=b")).status).toBe(403);
}, 20_000);

test("upload offsets remain exact beyond 4 GiB without allocating a giant fixture", async () => {
	const offset = 5 * 1024 ** 3,
		length = 12 * 1024 ** 3;
	await dbOwnerTransaction(
		[
			{
				sql: "UPDATE source_import_files SET upload_size = ?, upload_offset = ? WHERE id = 'file'",
				params: [length, offset],
				result: "run",
			},
		],
		options,
	);
	const chunk = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES, 97);
	expect(await appendTranscriptChunk(scope, offset, chunk, checksum(chunk))).toBe(offset + chunk.length);
	expect(await readTranscriptBytes(scope, offset)).toEqual(chunk);
}, 20_000);

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"legacy migration verifies bytes, retires canonical files, and repairs counters idempotently",
	async () => {
		const record = {
			source: "signet",
			id: "legacy",
			harness: "h",
			agent_id: "a",
			session_key: "old",
			project: null,
			timestamp: "2024-01-01T00:00:00Z",
			message_count: 1,
			messages: [{ role: "tool", content: "  exact\n" }],
		} as const;
		const content = Buffer.from(`${JSON.stringify(record)}\n`);
		const managed = "imports/transcripts/legacy/source.jsonl";
		await mkdir(join(root, "imports/transcripts/legacy"), { recursive: true });
		await mkdir(join(root, "transcripts"), { recursive: true });
		await writeFile(join(root, managed), content);
		const commit = buildCompletedTranscriptCommit(record, {
			agentId: "a",
			sourceId: "s",
			sourceRecordId: "r",
			sourcePath: managed,
		});
		const canonical = join(
			root,
			"transcripts",
			`${createHash("sha256").update("a\0h").digest("hex").slice(0, 24)}.jsonl`,
		);
		await writeFile(canonical, canonicalTranscriptLine(commit));
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_files SET source_id = 's',storage_state = 'legacy',state = 'completed',managed_path = ?,content_hash = ?,size_bytes = ?,checkpoint_byte_offset = ?,checkpoint_ordinal = 1,record_count = 1 WHERE id = 'file'",
					params: [managed, checksum(content), content.length, content.length],
					result: "run",
				},
				{
					sql: "UPDATE source_import_jobs SET state = 'completed',total = 99,imported = 0 WHERE id = 'job'",
					result: "run",
				},
				{
					sql: "INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status) VALUES ('r','job','file','s','a',1,1,0,?,?,'imported')",
					params: [content.length, checksum(content.subarray(0, -1))],
					result: "run",
				},
				{ sql: "INSERT INTO source_import_migrations (agent_id) VALUES ('a')", result: "run" },
			],
			options,
		);
		await migrateTranscriptImports(root, "a", () => true);
		await migrateTranscriptImports(root, "a", () => true);
		expect(await readTranscriptBytes(scope, 0)).toEqual(content);
		expect(await failure(access(join(root, managed)))).toContain("ENOENT");
		expect(await failure(access(canonical))).toContain("ENOENT");
		expect(
			await dbOwnerQuery(
				{ sql: "SELECT total,imported FROM source_import_jobs WHERE id = 'job'", result: "get", readonly: true },
				options,
			),
		).toEqual({ total: 1, imported: 1 });
	},
	20_000,
);

test("cancellation reconciles a Source registered before a failed ledger update", async () => {
	const content = Buffer.from("retained evidence\n");
	await beginTranscriptUpload(scope, content.length);
	await appendTranscriptChunk(scope, 0, content, checksum(content));
	await dbOwnerTransaction(
		[
			{
				sql: "CREATE TRIGGER fail_source_binding BEFORE UPDATE OF source_id ON source_import_files BEGIN SELECT RAISE(ABORT,'binding interrupted'); END",
				result: "run",
			},
		],
		options,
	);
	const app = http();
	expect((await app.request("/api/sources/imports/job/files/file/finalize", { method: "POST" })).status).toBe(409);
	const source = loadSourcesConfig(root).sources[0];
	expect(source).toBeDefined();
	await dbOwnerTransaction([{ sql: "DROP TRIGGER fail_source_binding", result: "run" }], options);
	await app.request("/api/sources/imports/job/cancel", { method: "POST" });
	expect(
		await dbOwnerQuery(
			{
				sql: "SELECT source_id,storage_state,state FROM source_import_files WHERE id = 'file'",
				result: "get",
				readonly: true,
			},
			options,
		),
	).toEqual({ source_id: source?.id, storage_state: "sealed", state: "ready" });
	expect(await readTranscriptBytes(scope, 0)).toEqual(content);
}, 20_000);

test("cancellation reclaims sealed evidence that never registered a Source", async () => {
	const content = Buffer.from("unregistered\n");
	await beginTranscriptUpload(scope, content.length);
	await appendTranscriptChunk(scope, 0, content, checksum(content));
	await sealTranscriptUpload(scope);
	await http().request("/api/sources/imports/job/cancel", { method: "POST" });
	expect((await transcriptUpload(scope)).storage_state).toBe("purged");
	expect(loadSourcesConfig(root).sources).toHaveLength(0);
}, 20_000);

test("legacy paths cannot escape the managed transcript subtree", () => {
	expect(() => resolveManagedTranscriptPath(root, "../outside.jsonl")).toThrow("escapes workspace");
	expect(() => resolveManagedTranscriptPath(root, "memory/memories.db")).toThrow("escapes workspace");
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"legacy migration refuses symlinks instead of copying external evidence",
	async () => {
		const external = join(root, "external.jsonl"),
			link = join(root, "imports/transcripts/source.jsonl");
		await mkdir(join(root, "imports/transcripts"), { recursive: true });
		await writeFile(external, "private");
		await symlink(external, link);
		expect(await failure(openContainedTranscriptFile(root, link, constants.O_RDONLY))).toContain("symlink");
		await access(external);
	},
);

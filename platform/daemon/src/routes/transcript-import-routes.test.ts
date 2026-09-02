import { expect, it, beforeEach, afterEach } from "bun:test";
import { loadSourcesConfig } from "@signet/core";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { registerTranscriptImportRoutes } from "./transcript-import-routes";

let dir = "";
let oldPath: string | undefined;
let oldWorkspace: string | undefined;
let oldAgent: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-transcript-routes-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	oldPath = process.env.SIGNET_PATH;
	oldWorkspace = process.env.SIGNET_WORKSPACE;
	oldAgent = process.env.SIGNET_AGENT_ID;
	process.env.SIGNET_PATH = dir;
	process.env.SIGNET_AGENT_ID = "transcript-test-agent";
	closeDbAccessor();
	initDbAccessor(join(dir, "memory", "memories.db"));
});

afterEach(() => {
	closeDbAccessor();
	if (oldPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = oldPath;
	if (oldWorkspace === undefined) Reflect.deleteProperty(process.env, "SIGNET_WORKSPACE");
	else process.env.SIGNET_WORKSPACE = oldWorkspace;
	if (oldAgent === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
	else process.env.SIGNET_AGENT_ID = oldAgent;
	rmSync(dir, { recursive: true, force: true });
});

function app(platform: string = process.platform): Hono {
	const instance = new Hono();
	registerTranscriptImportRoutes(instance, platform);
	return instance;
}

it("returns a structured platform error before creating an unsupported import", async () => {
	const response = await app("win32").request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ files: [{ name: "conversation.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	expect(response.status).toBe(501);
	expect(await response.json()).toEqual({
		error: "durable transcript imports are unavailable on win32; supported platforms: linux, darwin",
		code: "transcript_import_unsupported_platform",
		platform: "win32",
		supportedPlatforms: ["linux", "darwin"],
	});
	const jobs = await getDbAccessor().withReadDbAsync(
		(db) => db.prepare("SELECT COUNT(*) AS count FROM source_import_jobs").get() as { count: number },
	);
	expect(jobs).toEqual({ count: 0 });
});

it("serializes concurrent uploads for one reserved file without leaving a reservation orphan", async () => {
	const created = await app().request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ files: [{ name: "conversation.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	expect(created.status).toBe(201);
	const job = (await created.json()) as { jobId: string; files: Array<{ id: string }> };
	const fileId = job.files[0]?.id as string;
	const payload =
		'{"source":"signet","id":"one","harness":"h","agent_id":"embedded","session_key":"one","timestamp":"2024-01-01T00:00:00Z","message_count":1,"messages":[{"role":"user","content":"hello"}]}\n';
	const slow = new ReadableStream<Uint8Array>({
		async start(controller) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
	const first = app().request(`/api/sources/imports/${job.jobId}/files/${fileId}`, {
		method: "PUT",
		body: slow,
	} as RequestInit);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const second = await app().request(`/api/sources/imports/${job.jobId}/files/${fileId}`, {
		method: "PUT",
		body: payload,
	} as RequestInit);
	const firstResponse = await first;
	expect([201, 409]).toContain(firstResponse.status);
	expect([201, 409]).toContain(second.status);
	expect(new Set([firstResponse.status, second.status])).toEqual(new Set([201, 409]));
	const rows = await getDbAccessor().withReadDbAsync(
		(db) =>
			db.prepare("SELECT source_id, managed_path, state FROM source_import_files WHERE id = ?").all(fileId) as Array<{
				source_id: string;
				managed_path: string;
				state: string;
			}>,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ state: "ready" });
	expect(rows[0]?.source_id).not.toStartWith("reserved:");
	expect(rows[0]?.managed_path).toContain(`imports/transcripts/`);
	expect(rows[0]?.managed_path).toContain(fileId);
});

it("does not finalize an upload after cancellation and removes its staged source", async () => {
	const created = await app().request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ files: [{ name: "cancelled-upload.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	expect(created.status).toBe(201);
	const job = (await created.json()) as { jobId: string; files: Array<{ id: string }> };
	const fileId = job.files[0]?.id as string;
	const payload =
		'{"source":"signet","id":"cancelled-upload","harness":"h","agent_id":"embedded","session_key":"cancelled-upload","timestamp":"2024-01-01T00:00:00Z","message_count":1,"messages":[{"role":"user","content":"hello"}]}\n';
	const slow = new ReadableStream<Uint8Array>({
		async start(controller) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			controller.enqueue(new TextEncoder().encode(payload));
			controller.close();
		},
	});
	const upload = app().request(`/api/sources/imports/${job.jobId}/files/${fileId}`, {
		method: "PUT",
		body: slow,
	} as RequestInit);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const cancelled = await app().request(`/api/sources/imports/${job.jobId}/cancel`, { method: "POST" });
	const uploaded = await upload;
	expect(cancelled.status).toBe(200);
	expect(uploaded.status).toBe(409);
	const state = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT state, generation FROM source_import_jobs WHERE id = ?").get(job.jobId),
	);
	const file = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT source_id, state FROM source_import_files WHERE id = ?").get(fileId),
	);
	expect(state).toEqual({ state: "cancelled", generation: 1 });
	expect(file).toEqual({ source_id: `reserved:${job.jobId}:${fileId}`, state: "staging" });
	expect(
		await Bun.file(
			join(dir, "imports", "transcripts", `import-${job.jobId}-${fileId}-${job.jobId}-${fileId}`, "source.jsonl"),
		).exists(),
	).toBe(false);
	expect(loadSourcesConfig(dir).sources).toEqual([]);
});

it("rejects malformed manifests, enforces the 25-file limit, and persists duplicate mode", async () => {
	for (const body of [
		null,
		{ schemaId: null, files: [{ name: "conversation.jsonl" }] },
		{ duplicateMode: null, files: [{ name: "conversation.jsonl" }] },
		{ files: Array.from({ length: 26 }, (_, index) => ({ name: `${index}.jsonl` })) },
	]) {
		const response = await app().request("/api/sources/imports", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		});
		expect(response.status).toBe(400);
	}
	const created = await app().request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ duplicateMode: "reimport", files: [{ name: "conversation.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	expect(created.status).toBe(201);
	const job = (await created.json()) as { jobId: string; duplicateMode: string };
	expect(job.duplicateMode).toBe("reimport");
	const stored = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT duplicate_mode FROM source_import_jobs WHERE id = ?").get(job.jobId),
	);
	expect(stored).toEqual({ duplicate_mode: "reimport" });
});

it("retry increments generation and returns recoverable rejected records to pending", async () => {
	const created = await app().request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ files: [{ name: "conversation.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	const job = (await created.json()) as { jobId: string; files: Array<{ id: string }> };
	const fileId = job.files[0]?.id as string;
	await getDbAccessor().withWriteTxAsync((db) => {
		db.prepare("UPDATE source_import_jobs SET state = 'running', lease_token = 'old-lease' WHERE id = ?").run(
			job.jobId,
		);
		db.prepare("UPDATE source_import_files SET state = 'completed' WHERE id = ?").run(fileId);
		db.prepare(
			"INSERT INTO source_import_records (id, job_id, file_id, source_id, agent_id, ordinal, line_number, byte_offset, byte_length, raw_hash, status, rejection_code) VALUES ('retry-record', ?, ?, 'source', 'transcript-test-agent', 1, 1, 0, 1, 'hash', 'rejected', 'provider_error')",
		).run(job.jobId, fileId);
	});
	const response = await app().request(`/api/sources/imports/${job.jobId}/retry`, { method: "POST" });
	expect(response.status).toBe(200);
	const row = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT generation, lease_token, control_request FROM source_import_jobs WHERE id = ?").get(job.jobId),
	);
	const record = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT status, rejection_code FROM source_import_records WHERE id = 'retry-record'").get(),
	);
	expect(row).toEqual({ generation: 1, lease_token: null, control_request: null });
	expect(record).toEqual({ status: "pending", rejection_code: null });
});

it("does not reset rejected records when retry is rejected for a cancelled job", async () => {
	const created = await app().request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ files: [{ name: "cancelled.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	expect(created.status).toBe(201);
	const job = (await created.json()) as { jobId: string; files: Array<{ id: string }> };
	const fileId = job.files[0]?.id as string;
	await getDbAccessor().withWriteTxAsync((db) => {
		db.prepare("UPDATE source_import_jobs SET state = 'cancelled', generation = 1 WHERE id = ? AND agent_id = ?").run(
			job.jobId,
			"transcript-test-agent",
		);
		db.prepare("UPDATE source_import_files SET state = 'completed' WHERE id = ? AND job_id = ?").run(fileId, job.jobId);
		db.prepare(
			"INSERT INTO source_import_records (id, job_id, file_id, source_id, agent_id, ordinal, line_number, byte_offset, byte_length, raw_hash, status, rejection_code) VALUES ('cancelled-retry-record', ?, ?, 'source', 'transcript-test-agent', 1, 1, 0, 1, 'hash', 'rejected', 'provider_error')",
		).run(job.jobId, fileId);
	});

	const response = await app().request(`/api/sources/imports/${job.jobId}/retry`, { method: "POST" });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ changed: false });
	const state = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT state, generation FROM source_import_jobs WHERE id = ?").get(job.jobId),
	);
	const record = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT status, rejection_code FROM source_import_records WHERE id = 'cancelled-retry-record'").get(),
	);
	expect(state).toEqual({ state: "cancelled", generation: 1 });
	expect(record).toEqual({ status: "rejected", rejection_code: "provider_error" });
});

it("keeps a multi-file import retryable after one upload body fails", async () => {
	const created = await app().request("/api/sources/imports", {
		method: "POST",
		body: JSON.stringify({ files: [{ name: "first.jsonl" }, { name: "second.jsonl" }] }),
		headers: { "content-type": "application/json" },
	});
	expect(created.status).toBe(201);
	const job = (await created.json()) as { jobId: string; files: Array<{ id: string }> };
	const firstFileId = job.files[0]?.id as string;
	const secondFileId = job.files[1]?.id as string;
	const failedBody = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("simulated upload failure"));
		},
	});
	const failedUpload = await app().request(`/api/sources/imports/${job.jobId}/files/${firstFileId}`, {
		method: "PUT",
		body: failedBody,
	} as RequestInit);
	expect(failedUpload.status).toBe(500);

	const payload = (id: string) =>
		`${JSON.stringify({
			source: "signet",
			id,
			harness: "h",
			agent_id: "embedded",
			session_key: id,
			timestamp: "2024-01-01T00:00:00Z",
			message_count: 1,
			messages: [{ role: "user", content: id }],
		})}\n`;
	const secondUpload = await app().request(`/api/sources/imports/${job.jobId}/files/${secondFileId}`, {
		method: "PUT",
		body: payload("second"),
	} as RequestInit);
	expect(secondUpload.status).toBe(201);
	const stillStaging = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT state FROM source_import_jobs WHERE id = ?").get(job.jobId),
	);
	expect(stillStaging).toEqual({ state: "staging" });

	const firstRetry = await app().request(`/api/sources/imports/${job.jobId}/files/${firstFileId}`, {
		method: "PUT",
		body: payload("first"),
	} as RequestInit);
	expect(firstRetry.status).toBe(201);
	const started = await app().request(`/api/sources/imports/${job.jobId}/start`, { method: "POST" });
	expect(started.status).toBe(200);
});

it("uses SIGNET_WORKSPACE as the canonical import root when SIGNET_PATH is absent", async () => {
	const previousPath = process.env.SIGNET_PATH;
	Reflect.deleteProperty(process.env, "SIGNET_PATH");
	process.env.SIGNET_WORKSPACE = dir;
	try {
		const created = await app().request("/api/sources/imports", {
			method: "POST",
			body: JSON.stringify({ files: [{ name: "workspace.jsonl" }] }),
			headers: { "content-type": "application/json" },
		});
		expect(created.status).toBe(201);
		const job = (await created.json()) as { jobId: string; files: Array<{ id: string }> };
		const fileId = job.files[0]?.id as string;
		const payload = `${JSON.stringify({
			source: "signet",
			id: "workspace",
			harness: "h",
			agent_id: "embedded",
			session_key: "workspace",
			timestamp: "2024-01-01T00:00:00Z",
			message_count: 1,
			messages: [{ role: "user", content: "workspace" }],
		})}\n`;
		const uploaded = await app().request(`/api/sources/imports/${job.jobId}/files/${fileId}`, {
			method: "PUT",
			body: payload,
		} as RequestInit);
		expect(uploaded.status).toBe(201);
		const body = (await uploaded.json()) as { managedPath: string };
		expect(body.managedPath).toContain("imports/transcripts/");
		expect(await Bun.file(join(dir, body.managedPath)).exists()).toBe(true);
	} finally {
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
	}
});

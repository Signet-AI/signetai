import { controlImport, createJob, createOwnerTranscriptImportStore } from "../transcript-import-store";
import { DbOwnerError } from "../db-owner-client";
import { randomUUID } from "node:crypto";
import { addImportedSource, resolveDefaultBasePath, buildExportTranscriptRecord } from "@signet/core";
import { Hono, type Context } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { authConfig } from "./state";
import { requirePermission } from "../auth";
import { dbOwnerQuery, dbOwnerTransaction } from "../db-owner-runtime";
import { withTranscriptImportOperationLock } from "../transcript-import-operation-lock";
import {
	cleanupCancelledTranscriptImport,
	bindTranscriptSource,
	appendTranscriptChunk,
	beginTranscriptUpload,
	purgeTranscriptBytes,
	readTranscriptBytes,
	sealTranscriptUpload,
	transcriptUpload,
	uploadTranscriptStream,
	TRANSCRIPT_UPLOAD_BYTES,
	TRANSCRIPT_FILE_BYTES,
	type TranscriptUploadScope,
} from "../transcript-import-bytes";

const MAX_FILES_PER_IMPORT = 25;
const IMPORT_DUPLICATE_MODES = ["skip", "replace", "reimport"] as const;
type ImportDuplicateMode = (typeof IMPORT_DUPLICATE_MODES)[number];
const TRANSCRIPT_IMPORT_OPERATION_KEY = "transcript-import";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDuplicateMode(value: unknown): value is ImportDuplicateMode {
	return typeof value === "string" && (IMPORT_DUPLICATE_MODES as readonly string[]).includes(value);
}
function agent(c: Context): string | null {
	const resolved = resolveDaemonAgentId();
	const requested = c.req.query("agentId") ?? c.req.query("agent_id");
	return requested === undefined || requested === resolved ? resolved : null;
}
function bodyStream(request: Request): AsyncIterable<Uint8Array> {
	// Bun's server Request clone does not preserve the streamed upload body here:
	// the clone's reader reaches EOF even though the original body is non-empty.
	// Consume the one-shot server stream directly; staging remains byte-streamed.
	const body = request.body;
	if (body === null) return (async function* (): AsyncGenerator<Uint8Array> {})();
	return (async function* (): AsyncGenerator<Uint8Array> {
		const reader = body.getReader();
		if (reader === undefined) throw new Error("request body is required");
		let total = 0;
		try {
			while (true) {
				const item = await reader.read();
				if (item.done) return;
				total += item.value.byteLength;
				if (total > TRANSCRIPT_FILE_BYTES) throw new Error("file exceeds limit");
				yield item.value;
			}
		} finally {
			reader.releaseLock();
		}
	})();
}
async function boundedBody(request: Request, limit: number): Promise<Buffer> {
	const parts: Uint8Array[] = [];
	let length = 0;
	for await (const part of bodyStream(request)) {
		length += part.length;
		if (length > limit) throw new RangeError("import request exceeds its byte limit");
		parts.push(part);
	}
	return Buffer.concat(parts);
}

function permission(name: "modify" | "recall" | "admin") {
	return requirePermission(name, authConfig);
}

export function registerTranscriptImportRoutes(parent: Hono): void {
	const app = new Hono();
	app.onError((error, c) => {
		const code = error instanceof DbOwnerError ? String(error.code) : "transcript_import_conflict";
		const status =
			code === "SQLITE_FULL"
				? 507
				: error instanceof DbOwnerError && code.startsWith("DB_OWNER_")
					? 503
					: error instanceof RangeError
						? 413
						: 409;
		return c.json({ error: error.message, code }, status);
	});
	let transfers = 0;
	app.use("/api/sources/imports/:jobId/files/*", async (c, next) => {
		if (transfers >= 4)
			return c.json({ error: "transcript transfer capacity reached", code: "transcript_import_busy" }, 429);
		transfers++;
		try {
			await next();
		} finally {
			transfers--;
		}
	});
	const store = createOwnerTranscriptImportStore();
	app.use("/api/sources/imports/*", async (c, next) => {
		if (agent(c) === null) return c.json({ error: "agent scope denied" }, 403);
		await next();
	});
	app.use("/api/sources/imports", permission("modify"));
	app.use("/api/sources/imports/*", permission("modify"));
	app.post("/api/sources/imports", async (c) => {
		const agentId = agent(c);
		if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
		let body: unknown;
		try {
			body = JSON.parse((await boundedBody(c.req.raw, 64 * 1024)).toString("utf8"));
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!isRecord(body)) return c.json({ error: "JSON body must be an object" }, 400);
		const schemaId = body.schemaId === undefined ? "signet-export" : body.schemaId;
		if (schemaId !== "signet-export") return c.json({ error: "unsupported schema" }, 400);
		if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > MAX_FILES_PER_IMPORT)
			return c.json({ error: `files must contain between 1 and ${MAX_FILES_PER_IMPORT} entries` }, 400);
		const duplicateMode = body.duplicateMode === undefined ? "skip" : body.duplicateMode;
		if (!isDuplicateMode(duplicateMode)) return c.json({ error: "invalid duplicateMode" }, 400);
		const requestedFiles: Array<{ readonly id: string; readonly name: string }> = [];
		for (const file of body.files) {
			if (!isRecord(file) || typeof file.name !== "string" || file.name.trim().length === 0 || file.name.length > 1024)
				return c.json({ error: "each file must have a nonempty name" }, 400);
			requestedFiles.push({ id: randomUUID(), name: file.name.trim() });
		}
		const jobId = randomUUID();
		await createJob({ jobId, agentId, schemaId, duplicateMode, files: requestedFiles });
		return c.json({ id: jobId, jobId, agentId, state: "staging", duplicateMode, files: requestedFiles }, 201);
	});
	app.get("/api/sources/imports", async (c) => {
		const agentId = agent(c);
		if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
		const rows = await dbOwnerQuery(
			{
				sql: "SELECT * FROM source_import_jobs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100",
				params: [agentId],
				result: "all",
				readonly: true,
			},
			{ operation: "sources.import.list", lane: "read" },
		);
		return c.json({ imports: rows });
	});

	app.get("/api/sources/imports/export/transcripts", async (c) => {
		const agentId = agent(c);
		if (!agentId || c.req.queries("agentId")?.some((id) => id !== agentId))
			return c.json({ error: "agent scope denied" }, 403);
		const limit = Number(c.req.query("limit") ?? Number.MAX_SAFE_INTEGER),
			skip = Number(c.req.query("offset") ?? 0);
		const harnesses = c.req.queries("harness") ?? [];
		if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(skip) || skip < 0 || harnesses.length > 25)
			return c.json({ error: "invalid export bounds" }, 400);
		const since = c.req.query("since"),
			until = c.req.query("until");
		const where = ["agent_id = ?"];
		const params: Array<string | number> = [agentId];
		if (harnesses.length) {
			where.push(`harness IN (${harnesses.map(() => "?").join(",")})`);
			params.push(...harnesses);
		}
		if (since) {
			where.push("created_at >= ?");
			params.push(since);
		}
		if (until) {
			where.push("created_at <= ?");
			params.push(/^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T23:59:59.999Z` : until);
		}
		const json = c.req.query("json") === "true",
			messagesOnly = c.req.query("messagesOnly") === "true";
		let cursor: [string, string] | undefined,
			visited = 0,
			emitted = 0,
			opened = false;
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						c.req.raw.signal.throwIfAborted();
						if (json && !opened) {
							opened = true;
							controller.enqueue(encoder.encode("["));
							return;
						}
						if (emitted >= limit) {
							if (json) controller.enqueue(encoder.encode("]\n"));
							controller.close();
							return;
						}
						const row = await dbOwnerQuery<
							Omit<Parameters<typeof buildExportTranscriptRecord>[0], "content"> & { bytes: number }
						>(
							{
								sql: `SELECT session_key,length(CAST(content AS BLOB)) AS bytes,harness,project,agent_id,created_at FROM session_transcripts WHERE ${where.join(" AND ")} ${cursor ? "AND (created_at,session_key) > (?,?)" : ""} ORDER BY created_at,session_key LIMIT 1`,
								params: [...params, ...(cursor ?? [])],
								result: "get",
								readonly: true,
							},
							{ operation: "sources.import.export", lane: "read" },
						);
						if (!row) {
							if (json) controller.enqueue(encoder.encode("]\n"));
							controller.close();
							return;
						}
						cursor = [row.created_at, row.session_key];
						if (visited++ < skip) {
							controller.enqueue(new Uint8Array());
							return;
						}
						if (row.bytes > 16 * 1024 ** 2) throw new Error("Transcript exceeds the 16 MiB export record limit");
						const parts: Buffer[] = [];
						for (let offset = 0; offset < row.bytes; offset += 64 * 1024) {
							c.req.raw.signal.throwIfAborted();
							const part = await dbOwnerQuery<{ content: string }>(
								{
									sql: "SELECT hex(substr(CAST(content AS BLOB),?,65536)) AS content FROM session_transcripts WHERE agent_id = ? AND session_key = ? AND created_at = ? AND length(CAST(content AS BLOB)) = ?",
									params: [offset + 1, agentId, row.session_key, row.created_at, row.bytes],
									result: "get",
									readonly: true,
								},
								{ operation: "sources.import.export.content", lane: "read" },
							);
							if (!part) throw new Error("Transcript changed during export; retry the export");
							parts.push(Buffer.from(part.content, "hex"));
						}
						const record = buildExportTranscriptRecord({ ...row, content: Buffer.concat(parts).toString("utf8") });
						const messages = messagesOnly
							? record.messages.filter((message) => message.role === "user" || message.role === "assistant")
							: record.messages;
						controller.enqueue(
							encoder.encode(
								`${json && emitted ? "," : ""}${JSON.stringify({ ...record, messages, message_count: messages.length })}${json ? "" : "\n"}`,
							),
						);
						emitted++;
					} catch (error) {
						controller.error(error);
					}
				},
			}),
			{ headers: { "content-type": json ? "application/json" : "application/x-ndjson" } },
		);
	});
	app.get("/api/sources/imports/:jobId", async (c) => {
		const agentId = agent(c);
		if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
		const jobId = c.req.param("jobId");
		const job = await dbOwnerQuery(
			{
				sql: "SELECT * FROM source_import_jobs WHERE id = ? AND agent_id = ?",
				params: [jobId, agentId],
				result: "get",
				readonly: true,
			},
			{ operation: "sources.import.status", lane: "read" },
		);
		if (job == null) return c.json({ error: "import not found" }, 404);
		const files = await dbOwnerQuery(
			{
				sql: "SELECT * FROM source_import_files WHERE job_id = ? AND agent_id = ? ORDER BY ordinal",
				params: [jobId, agentId],
				result: "all",
				readonly: true,
			},
			{ operation: "sources.import.files", lane: "read" },
		);
		return c.json({ job, files });
	});
	const scope = (c: Context): TranscriptUploadScope => {
		const agentId = agent(c);
		if (agentId === null) throw new Error("agent scope denied");
		const generation = Number(c.req.header("upload-generation") ?? "0");
		if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid upload generation");
		const jobId = c.req.param("jobId"),
			fileId = c.req.param("fileId");
		if (!jobId || !fileId) throw new Error("upload scope required");
		return { agentId, jobId, fileId, generation, signal: c.req.raw.signal };
	};
	const finalize = async (c: Context): Promise<Response> => {
		const upload = scope(c);
		await sealTranscriptUpload(upload);
		return withTranscriptImportOperationLock(TRANSCRIPT_IMPORT_OPERATION_KEY, async () => {
			const file = await dbOwnerQuery<{
				name: string;
				content_hash: string;
				size_bytes: number;
				state: string;
				source_id: string;
				duplicate_mode: ImportDuplicateMode;
			}>(
				{
					sql: "SELECT f.name,f.content_hash,f.size_bytes,f.state,f.source_id,j.duplicate_mode FROM source_import_files f JOIN source_import_jobs j ON j.id = f.job_id AND j.agent_id = f.agent_id WHERE f.id = ? AND f.job_id = ? AND f.agent_id = ? AND f.upload_generation = ? AND f.storage_state = 'sealed' AND j.state = 'staging'",
					params: [upload.fileId, upload.jobId, upload.agentId, upload.generation],
					result: "get",
					readonly: true,
				},
				{ operation: "sources.import.finalize.file", lane: "read" },
			);
			if (!file) return c.json({ error: "import is no longer staging" }, 409);
			const added = addImportedSource(
				{
					fileName: file.name,
					contentHash: file.content_hash,
					format: "jsonl",
					agentId: upload.agentId,
					duplicateMode: file.duplicate_mode,
					importKey: `${upload.jobId}:${upload.fileId}:${upload.generation}`,
				},
				resolveDefaultBasePath(),
			);
			if (!added.ok) return c.json({ error: added.error }, 400);
			await bindTranscriptSource(upload, added.source.id);
			return c.json(
				{
					fileId: upload.fileId,
					sourceId: added.source.id,
					sizeBytes: file.size_bytes,
					contentHash: file.content_hash,
				},
				201,
			);
		});
	};

	app.put("/api/sources/imports/:jobId/files/:fileId", async (c) => {
		const declared = c.req.header("upload-length") ?? c.req.header("content-length");
		if (declared === undefined) return c.json({ error: "upload-length is required" }, 411);
		await uploadTranscriptStream(scope(c), Number(declared), bodyStream(c.req.raw));
		return finalize(c);
	});
	app.patch("/api/sources/imports/:jobId/files/:fileId", async (c) => {
		const upload = scope(c);
		const length = c.req.header("upload-length"),
			offset = c.req.header("upload-offset"),
			checksum = c.req.header("upload-checksum");
		if (length === undefined || offset === undefined || !checksum)
			return c.json({ error: "upload-length, upload-offset and upload-checksum are required" }, 400);
		await beginTranscriptUpload(upload, Number(length));
		const bytes = await boundedBody(c.req.raw, TRANSCRIPT_UPLOAD_BYTES);
		const nextOffset = await appendTranscriptChunk(upload, Number(offset), bytes, checksum);
		return c.json({ offset: nextOffset, generation: upload.generation });
	});
	app.post("/api/sources/imports/:jobId/files/:fileId/finalize", finalize);
	app.post("/api/sources/imports/:jobId/files/:fileId/reset", async (c) =>
		withTranscriptImportOperationLock(TRANSCRIPT_IMPORT_OPERATION_KEY, async () => {
			const upload = scope(c);
			const file = await transcriptUpload(upload);
			if (
				!(
					(file.storage_state === "uploading" && file.upload_generation === upload.generation) ||
					(["purging", "purged"].includes(file.storage_state) && file.upload_generation === upload.generation + 1)
				)
			)
				return c.json({ error: "only an incomplete upload can be reset" }, 409);
			await purgeTranscriptBytes(upload);
			await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET storage_state = 'uploading', upload_offset = 0, upload_size = NULL, upload_digest = '', content_hash = NULL, size_bytes = 0 WHERE id = ? AND job_id = ? AND agent_id = ? AND storage_state = 'purged' AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'staging')",
						params: [upload.fileId, upload.jobId, upload.agentId, upload.jobId, upload.agentId],
						result: "run",
						requireChanges: true,
					},
				],
				{ operation: "sources.import.upload.reset", lane: "write" },
			);
			return c.json(await transcriptUpload(upload));
		}),
	);
	app.get("/api/sources/imports/:jobId/files/:fileId/content", async (c) => {
		const upload = scope(c);
		const file = await transcriptUpload(upload);
		if (file.storage_state !== "sealed") return c.json({ error: "source is not sealed" }, 409);
		const readScope = { ...upload, generation: file.upload_generation };
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					if (offset === file.upload_size) {
						controller.close();
						return;
					}
					const bytes = await readTranscriptBytes(readScope, offset);
					offset += bytes.length;
					controller.enqueue(bytes);
				} catch (error) {
					controller.error(error);
				}
			},
		});
		return new Response(stream, {
			headers: { "content-type": "application/x-ndjson", "content-length": String(file.upload_size) },
		});
	});
	for (const control of ["start", "pause", "resume", "retry", "cancel"] as const) {
		app.post(`/api/sources/imports/:jobId/${control}`, async (c) => {
			const agentId = agent(c);
			if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
			const jobId = c.req.param("jobId");
			const run = async (): Promise<Response> => {
				const changed = await controlImport(store, { jobId, agentId, control });
				if (control === "cancel")
					await cleanupCancelledTranscriptImport(agentId, jobId, () => !c.req.raw.signal.aborted);
				return c.json({ jobId, control, changed });
			};
			return control === "cancel"
				? await withTranscriptImportOperationLock(TRANSCRIPT_IMPORT_OPERATION_KEY, run)
				: await run();
		});
	}
	for (const suffix of ["rejections", "reconciliation"] as const) {
		app.get(`/api/sources/imports/:jobId/${suffix}`, async (c) => {
			const agentId = agent(c);
			if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
			const jobId = c.req.param("jobId");
			const rows = await dbOwnerQuery<Array<Record<string, unknown>>>(
				{
					sql:
						suffix === "rejections"
							? "SELECT * FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'rejected' AND id > ? ORDER BY id LIMIT 100"
							: "SELECT total,imported,duplicate,rejected,pending FROM source_import_jobs WHERE id = ? AND agent_id = ?",
					params: [jobId, agentId, ...(suffix === "rejections" ? [c.req.query("cursor") ?? ""] : [])],
					result: "all",
					readonly: true,
				},
				{ operation: `sources.import.${suffix}`, lane: "read" },
			);
			return c.json({
				jobId,
				[suffix]:
					suffix === "reconciliation"
						? Object.entries(rows[0] ?? {})
								.filter(([status]) => status !== "total")
								.map(([status, count]) => ({ status, count }))
						: rows,
				nextCursor: suffix === "rejections" && rows.length === 100 ? rows[99]?.id : null,
			});
		});
	}
	parent.route("/", app);
}

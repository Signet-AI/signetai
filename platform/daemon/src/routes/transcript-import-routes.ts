import { randomUUID } from "node:crypto";
import { addImportedSource } from "@signet/core";
import type { Context, Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { authConfig } from "./state";
import { requirePermission } from "../auth";
import { dbOwnerQuery, dbOwnerTransaction } from "../db-owner-runtime";
import { stageTranscriptStream } from "../transcript-import-staging";
import type { StagedTranscriptFile } from "../transcript-import-staging";

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const now = (): string => new Date().toISOString();
const uploadInFlight = new Map<string, Promise<void>>();
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
	if (body === null) throw new Error("request body is required");
	return (async function* (): AsyncGenerator<Uint8Array> {
		const reader = body.getReader();
		if (reader === undefined) throw new Error("request body is required");
		let total = 0;
		try {
			while (true) {
				const item = await reader.read();
				if (item.done) return;
				total += item.value.byteLength;
				if (total > MAX_FILE_BYTES) throw new Error("file exceeds limit");
				yield item.value;
			}
		} finally {
			reader.releaseLock();
		}
	})();
}
function permission(name: "modify" | "recall" | "admin") {
	return requirePermission(name, authConfig);
}

export function registerTranscriptImportRoutes(app: Hono): void {
	app.use("/api/sources/imports", permission("modify"));
	app.use("/api/sources/imports/*", permission("modify"));
	app.post("/api/sources/imports", async (c) => {
		const agentId = agent(c);
		if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
		const input = (await c.req.json().catch(() => ({}))) as { schemaId?: string; files?: readonly { name?: string }[] };
		if (input.schemaId !== undefined && input.schemaId !== "signet-export")
			return c.json({ error: "unsupported schema" }, 400);
		const jobId = randomUUID();
		const requestedFiles = (input.files ?? []).map((file) => ({
			id: randomUUID(),
			name: file.name?.trim() || "source.jsonl",
		}));
		const statements = [
			{
				sql: "INSERT INTO source_import_jobs (id,kind,agent_id,schema_id,adapter_version,state,generation,created_at,updated_at) VALUES (?,?,?,?,1,'staging',0,?,?)",
				params: [jobId, "import", agentId, "signet-export", now(), now()],
				result: "run" as const,
			},
			...requestedFiles.map((file, ordinal) => ({
				sql: "INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state) VALUES (?,?,?,?,?,?,?,'staging')",
				params: [
					file.id,
					jobId,
					`reserved:${jobId}:${file.id}`,
					agentId,
					ordinal,
					file.name,
					`imports/transcripts/${jobId}/${file.id}/source.jsonl`,
				],
				result: "run" as const,
			})),
		];
		await dbOwnerTransaction(statements, { operation: "sources.import.create", lane: "write" });
		return c.json({ id: jobId, jobId, agentId, state: "staging", files: requestedFiles }, 201);
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
	app.put("/api/sources/imports/:jobId/files/:fileId", async (c) => {
		const agentId = agent(c);
		if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
		const jobId = c.req.param("jobId"),
			fileId = c.req.param("fileId");
		const job = await dbOwnerQuery<{ id: string }>(
			{
				sql: "SELECT id FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'staging'",
				params: [jobId, agentId],
				result: "get",
				readonly: true,
			},
			{ operation: "sources.import.upload.scope", lane: "read" },
		);
		if (job == null) return c.json({ error: "import not found or not staging" }, 404);
		const file = await dbOwnerQuery<{ id: string; name: string; ordinal: number; state: string }>(
			{
				sql: "SELECT id,name,ordinal,state FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ? AND state = 'staging'",
				params: [fileId, jobId, agentId],
				result: "get",
				readonly: true,
			},
			{ operation: "sources.import.upload.file", lane: "read" },
		);
		if (file == null) return c.json({ error: "file not found or already uploaded" }, 404);
		const previous = uploadInFlight.get(fileId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		uploadInFlight.set(fileId, gate);
		await previous;
		try {
			const stillStaging = await dbOwnerQuery<{ id: string }>(
				{
					sql: "SELECT id FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ? AND state = 'staging'",
					params: [fileId, jobId, agentId],
					result: "get",
					readonly: true,
				},
				{ operation: "sources.import.upload.claim", lane: "read" },
			);
			if (stillStaging == null) return c.json({ error: "file not found or already uploaded" }, 409);
			const sourceId = `import:${jobId}:${fileId}`;
			let staged: StagedTranscriptFile;
			try {
				staged = await stageTranscriptStream(
					process.env.SIGNET_PATH ?? `${process.env.HOME}/.agents`,
					`${sourceId.replaceAll(":", "-")}-${jobId}-${fileId}`,
					bodyStream(c.req.raw),
				);
			} catch (error) {
				return c.json({ error: error instanceof Error ? error.message : "upload failed" }, 413);
			}
			const added = addImportedSource(
				{ fileName: "source.jsonl", contentHash: staged.contentHash, format: "jsonl", agentId },
				process.env.SIGNET_PATH,
			);
			if (!added.ok) return c.json({ error: added.error }, 400);
			await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_files SET source_id = ?, name = ?, managed_path = ?, size_bytes = ?, content_hash = ?, state = 'ready', updated_at = ? WHERE id = ? AND job_id = ? AND agent_id = ? AND state = 'staging'",
						params: [
							added.source.id,
							c.req.header("x-file-name") ?? file.name,
							staged.managedPath,
							staged.sizeBytes,
							staged.contentHash,
							now(),
							fileId,
							jobId,
							agentId,
						],
						result: "run" as const,
						requireChanges: true,
					},
					{
						sql: "UPDATE source_import_jobs SET updated_at = ? WHERE id = ? AND agent_id = ?",
						params: [now(), jobId, agentId],
						result: "run" as const,
						requireChanges: true,
					},
				],
				{ operation: "sources.import.upload", lane: "write" },
			);
			return c.json(
				{
					fileId,
					sourceId: added.source.id,
					managedPath: staged.managedPath,
					sizeBytes: staged.sizeBytes,
					contentHash: staged.contentHash,
				},
				201,
			);
		} finally {
			release();
			if (uploadInFlight.get(fileId) === gate) uploadInFlight.delete(fileId);
		}
	});
	for (const control of ["start", "pause", "resume", "retry", "cancel"] as const) {
		app.post(`/api/sources/imports/:jobId/${control}`, async (c) => {
			const agentId = agent(c);
			if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
			const jobId = c.req.param("jobId");
			const transition = control === "start" ? "queued" : control;
			const result = await dbOwnerTransaction(
				[
					{
						sql: "UPDATE source_import_jobs SET state = CASE WHEN ? = 'queued' THEN 'queued' ELSE state END, control_request = CASE WHEN ? = 'queued' THEN NULL WHEN ? = 'retry' THEN NULL ELSE ? END, generation = CASE WHEN ? = 'retry' THEN generation + 1 ELSE generation END, lease_token = CASE WHEN ? = 'retry' THEN NULL ELSE lease_token END, lease_expires_at = CASE WHEN ? = 'retry' THEN NULL ELSE lease_expires_at END, updated_at = ? WHERE id = ? AND agent_id = ? AND state NOT IN ('completed','completed_with_rejections','cancelled')",
						params: [
							transition,
							transition,
							transition,
							transition,
							transition,
							transition,
							transition,
							now(),
							jobId,
							agentId,
						],
						result: "run" as const,
					},
					...(control === "retry"
						? [
								{
									sql: "UPDATE source_import_records SET status = 'pending', rejection_code = NULL, updated_at = datetime('now') WHERE job_id = ? AND agent_id = ? AND status = 'rejected' AND rejection_code NOT IN ('schema_invalid','malformed')",
									params: [jobId, agentId],
									result: "run" as const,
								},
							]
						: []),
				],
				{ operation: `sources.import.${control}`, lane: "write" },
			);
			const first = result[0] as { readonly changes?: number } | undefined;
			return c.json({ jobId, control, changed: (first?.changes ?? 0) > 0 });
		});
	}
	for (const suffix of ["rejections", "reconciliation"] as const) {
		app.get(`/api/sources/imports/:jobId/${suffix}`, async (c) => {
			const agentId = agent(c);
			if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
			const jobId = c.req.param("jobId");
			const rows = await dbOwnerQuery(
				{
					sql:
						suffix === "rejections"
							? "SELECT * FROM source_import_records WHERE job_id = ? AND agent_id = ? AND status = 'rejected' ORDER BY ordinal"
							: "SELECT status, COUNT(*) AS count FROM source_import_records WHERE job_id = ? AND agent_id = ? GROUP BY status",
					params: [jobId, agentId],
					result: "all",
					readonly: true,
				},
				{ operation: `sources.import.${suffix}`, lane: "read" },
			);
			return c.json({ jobId, [suffix]: rows });
		});
	}
}

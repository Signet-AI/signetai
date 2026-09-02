import { randomUUID } from "node:crypto";
import { addImportedSource, removeSourceIfGeneration, resolveDefaultBasePath } from "@signet/core";
import type { Context, Hono, Next } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { authConfig } from "./state";
import { requirePermission } from "../auth";
import { dbOwnerQuery, dbOwnerTransaction } from "../db-owner-runtime";
import {
	removeStagedTranscriptFile,
	stageTranscriptStream,
	type StagedTranscriptFile,
} from "../transcript-import-staging";
import { withTranscriptImportOperationLock } from "../transcript-import-operation-lock";
import { getTranscriptImportPlatformError, TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS } from "../transcript-import-safe-fs";

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_FILES_PER_IMPORT = 25;
const IMPORT_DUPLICATE_MODES = ["skip", "replace", "reimport"] as const;
type ImportDuplicateMode = (typeof IMPORT_DUPLICATE_MODES)[number];
const now = (): string => new Date().toISOString();
const uploadInFlight = new Map<string, Promise<void>>();
const TRANSCRIPT_IMPORT_OPERATION_KEY = "transcript-import";
const uploadedSources = new Map<
	string,
	{ readonly sourceId: string; readonly generation?: string; readonly created: boolean }
>();

function uploadSourceKey(agentId: string, jobId: string, fileId: string): string {
	return `${agentId}:${jobId}:${fileId}`;
}

function stagedSourceId(jobId: string, fileId: string): string {
	const reservedSourceId = `import:${jobId}:${fileId}`;
	return `${reservedSourceId.replaceAll(":", "-")}-${jobId}-${fileId}`;
}

function stagedManagedPath(jobId: string, fileId: string): string {
	return `imports/transcripts/${stagedSourceId(jobId, fileId)}/source.jsonl`;
}

async function removeStagedPath(root: string, managedPath: string): Promise<void> {
	await removeStagedTranscriptFile(root, managedPath);
}

async function rollbackCreatedSource(
	source: { readonly sourceId: string; readonly generation?: string; readonly created: boolean },
	root: string,
	jobId: string,
	agentId: string,
): Promise<void> {
	if (!source.created) return;
	const references = await dbOwnerQuery<{ count: number }>(
		{
			sql: "SELECT COUNT(*) AS count FROM source_import_files WHERE agent_id = ? AND source_id = ? AND job_id != ? AND state != 'failed'",
			params: [agentId, source.sourceId, jobId],
			result: "get",
			readonly: true,
		},
		{ operation: "sources.import.rollback.references", lane: "read" },
	);
	if ((references?.count ?? 0) > 0) return;
	const removed = removeSourceIfGeneration(source.sourceId, source.generation, root);
	if (!removed.ok) throw new Error(removed.error);
}

async function cleanupCancelledImport(jobId: string, agentId: string): Promise<void> {
	const job = await dbOwnerQuery<{ state: string }>(
		{
			sql: "SELECT state FROM source_import_jobs WHERE id = ? AND agent_id = ?",
			params: [jobId, agentId],
			result: "get",
			readonly: true,
		},
		{ operation: "sources.import.cancelled.status", lane: "read" },
	);
	if (job?.state !== "cancelled") return;
	const files = await dbOwnerQuery<Array<{ id: string; source_id: string; managed_path: string }>>(
		{
			sql: "SELECT id, source_id, managed_path FROM source_import_files WHERE job_id = ? AND agent_id = ?",
			params: [jobId, agentId],
			result: "all",
			readonly: true,
		},
		{ operation: "sources.import.cancelled.files", lane: "read" },
	);
	const root = resolveDefaultBasePath();
	const managedPaths = new Set<string>();
	const sourceKeys = new Set<string>();
	for (const file of files) {
		managedPaths.add(file.managed_path);
		if (!uploadInFlight.has(uploadSourceKey(agentId, jobId, file.id)))
			managedPaths.add(stagedManagedPath(jobId, file.id));
		sourceKeys.add(file.source_id);
	}
	for (const managedPath of managedPaths) await removeStagedPath(root, managedPath);
	for (const file of files) {
		const key = uploadSourceKey(agentId, jobId, file.id);
		const source = uploadedSources.get(key);
		if (source !== undefined && sourceKeys.has(file.source_id)) {
			await rollbackCreatedSource(source, root, jobId, agentId);
		}
		uploadedSources.delete(key);
	}
}

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

async function markUploadFailed(jobId: string, fileId: string, agentId: string, message: string): Promise<void> {
	try {
		await dbOwnerTransaction(
			[
				{
					sql: "UPDATE source_import_files SET state = 'staging', error = ?, updated_at = ? WHERE id = ? AND job_id = ? AND agent_id = ? AND state = 'staging'",
					params: [message, now(), fileId, jobId, agentId],
					result: "run" as const,
				},
				{
					sql: "UPDATE source_import_jobs SET state = 'staging', error = ?, updated_at = ? WHERE id = ? AND agent_id = ? AND state = 'staging'",
					params: [message, now(), jobId, agentId],
					result: "run" as const,
				},
			],
			{ operation: "sources.import.upload.failed", lane: "write" },
		);
	} catch {
		// Preserve the original upload failure when the owner is unavailable.
	}
}

function transcriptImportPlatformGate(platform: string) {
	return async (c: Context, next: Next) => {
		const unsupported = getTranscriptImportPlatformError(platform);
		if (unsupported === undefined) return await next();
		return c.json(
			{
				error: unsupported.message,
				code: unsupported.code,
				platform: unsupported.platform,
				supportedPlatforms: [...TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS],
			},
			501,
		);
	};
}

export function registerTranscriptImportRoutes(app: Hono, platform: string = process.platform): void {
	app.use("/api/sources/imports", permission("modify"));
	app.use("/api/sources/imports/*", permission("modify"));
	const platformGate = transcriptImportPlatformGate(platform);
	app.use("/api/sources/imports", platformGate);
	app.use("/api/sources/imports/*", platformGate);
	app.post("/api/sources/imports", async (c) => {
		const agentId = agent(c);
		if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
		let body: unknown;
		try {
			body = await c.req.json();
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
			if (!isRecord(file) || typeof file.name !== "string" || file.name.trim().length === 0)
				return c.json({ error: "each file must have a nonempty name" }, 400);
			requestedFiles.push({ id: randomUUID(), name: file.name.trim() });
		}
		const jobId = randomUUID();
		const statements = [
			{
				sql: "INSERT INTO source_import_jobs (id,kind,agent_id,schema_id,adapter_version,state,generation,duplicate_mode,created_at,updated_at) VALUES (?,?,?,?,1,'staging',0,?,?,?)",
				params: [jobId, "import", agentId, schemaId, duplicateMode, now(), now()],
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
		const uploadKey = `${agentId}:${jobId}:${fileId}`;
		const previous = uploadInFlight.get(uploadKey) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		uploadInFlight.set(uploadKey, gate);
		await previous;
		try {
			const job = await dbOwnerQuery<{ id: string; generation: number; duplicate_mode?: ImportDuplicateMode }>(
				{
					sql: "SELECT id,generation,duplicate_mode FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'staging'",
					params: [jobId, agentId],
					result: "get",
					readonly: true,
				},
				{ operation: "sources.import.upload.scope", lane: "read" },
			);
			if (job == null) return c.json({ error: "import not found or not staging" }, 404);
			const file = await dbOwnerQuery<{ id: string; name: string; ordinal: number; state: string }>(
				{
					sql: "SELECT id,name,ordinal,state FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ?",
					params: [fileId, jobId, agentId],
					result: "get",
					readonly: true,
				},
				{ operation: "sources.import.upload.file", lane: "read" },
			);
			if (file == null) return c.json({ error: "file not found" }, 404);
			if (file.state !== "staging") return c.json({ error: "file not found or already uploaded" }, 409);
			const root = resolveDefaultBasePath();
			let staged: StagedTranscriptFile;
			try {
				staged = await stageTranscriptStream(root, stagedSourceId(jobId, fileId), bodyStream(c.req.raw));
			} catch (error) {
				const message = error instanceof Error ? error.message : "upload failed";
				await markUploadFailed(jobId, fileId, agentId, message);
				return c.json({ error: message }, message === "file exceeds limit" ? 413 : 500);
			}
			return await withTranscriptImportOperationLock(TRANSCRIPT_IMPORT_OPERATION_KEY, async () => {
				const currentJob = await dbOwnerQuery<{ state: string; generation: number }>(
					{
						sql: "SELECT state,generation FROM source_import_jobs WHERE id = ? AND agent_id = ?",
						params: [jobId, agentId],
						result: "get",
						readonly: true,
					},
					{ operation: "sources.import.upload.final-scope", lane: "read" },
				);
				const currentFile = await dbOwnerQuery<{ state: string }>(
					{
						sql: "SELECT state FROM source_import_files WHERE id = ? AND job_id = ? AND agent_id = ?",
						params: [fileId, jobId, agentId],
						result: "get",
						readonly: true,
					},
					{ operation: "sources.import.upload.final-file", lane: "read" },
				);
				if (
					currentJob == null ||
					currentJob.state !== "staging" ||
					currentJob.generation !== job.generation ||
					currentFile?.state !== "staging"
				) {
					await removeStagedPath(root, staged.managedPath);
					return c.json({ error: "import was invalidated during upload" }, 409);
				}

				const added = addImportedSource(
					{
						fileName: file.name,
						contentHash: staged.contentHash,
						format: "jsonl",
						agentId,
						duplicateMode: job.duplicate_mode ?? "skip",
					},
					root,
				);
				if (!added.ok) {
					await removeStagedPath(root, staged.managedPath);
					await markUploadFailed(jobId, fileId, agentId, added.error);
					return c.json({ error: added.error }, 400);
				}
				try {
					await dbOwnerTransaction(
						[
							{
								sql: "UPDATE source_import_files SET source_id = ?, name = ?, managed_path = ?, size_bytes = ?, content_hash = ?, state = 'ready', error = NULL, updated_at = ? WHERE id = ? AND job_id = ? AND agent_id = ? AND state = 'staging' AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'staging' AND generation = ?)",
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
									jobId,
									agentId,
									job.generation,
								],
								result: "run" as const,
								requireChanges: true,
							},
							{
								sql: "UPDATE source_import_jobs SET error = NULL, updated_at = ? WHERE id = ? AND agent_id = ? AND state = 'staging' AND generation = ?",
								params: [now(), jobId, agentId, job.generation],
								result: "run" as const,
								requireChanges: true,
							},
						],
						{ operation: "sources.import.upload", lane: "write" },
					);
				} catch (error) {
					await removeStagedPath(root, staged.managedPath);
					await rollbackCreatedSource(
						{ sourceId: added.source.id, generation: added.source.generation, created: added.created },
						root,
						jobId,
						agentId,
					);
					if (error instanceof Error && error.message.includes("precondition changed zero rows"))
						return c.json({ error: "import was invalidated during upload" }, 409);
					throw error;
				}
				uploadedSources.set(uploadSourceKey(agentId, jobId, fileId), {
					sourceId: added.source.id,
					generation: added.source.generation,
					created: added.created,
				});
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
			});
		} finally {
			release();
			if (uploadInFlight.get(uploadKey) === gate) uploadInFlight.delete(uploadKey);
		}
	});
	for (const control of ["start", "pause", "resume", "retry", "cancel"] as const) {
		app.post(`/api/sources/imports/:jobId/${control}`, async (c) => {
			const agentId = agent(c);
			if (agentId === null) return c.json({ error: "agent scope denied" }, 403);
			const jobId = c.req.param("jobId");
			const statements: Array<{
				readonly sql: string;
				readonly params: readonly (string | number | null)[];
				readonly result: "run";
				readonly requireChanges?: boolean;
			}> = [];
			if (control === "start") {
				statements.push({
					sql: "UPDATE source_import_jobs SET state = 'queued', control_request = NULL, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND agent_id = ? AND state = 'staging' AND EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ?) AND NOT EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ? AND state != 'ready')",
					params: [now(), jobId, agentId, jobId, agentId, jobId, agentId],
					result: "run",
				});
			} else if (control === "pause") {
				statements.push({
					sql: "UPDATE source_import_jobs SET state = CASE WHEN state = 'queued' THEN 'paused' ELSE state END, control_request = CASE WHEN state IN ('running','inventorying') THEN 'pause' ELSE NULL END, generation = CASE WHEN state = 'queued' THEN generation + 1 ELSE generation END, lease_token = CASE WHEN state = 'queued' THEN NULL ELSE lease_token END, lease_expires_at = CASE WHEN state = 'queued' THEN NULL ELSE lease_expires_at END, updated_at = ? WHERE id = ? AND agent_id = ? AND state IN ('queued','running','inventorying')",
					params: [now(), jobId, agentId],
					result: "run",
				});
			} else if (control === "resume") {
				statements.push({
					sql: "UPDATE source_import_jobs SET state = 'queued', control_request = NULL, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND agent_id = ? AND state = 'paused' AND EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ?) AND NOT EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ? AND state IN ('staging','failed'))",
					params: [now(), jobId, agentId, jobId, agentId, jobId, agentId],
					result: "run",
				});
			} else if (control === "retry") {
				statements.push({
					sql: "UPDATE source_import_jobs SET state = 'queued', control_request = NULL, generation = generation + 1, lease_token = NULL, lease_expires_at = NULL, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND agent_id = ? AND state IN ('failed','completed','completed_with_rejections','paused','queued','running','inventorying') AND EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ?) AND NOT EXISTS (SELECT 1 FROM source_import_files WHERE job_id = ? AND agent_id = ? AND state IN ('staging','failed'))",
					params: [now(), jobId, agentId, jobId, agentId, jobId, agentId],
					result: "run",
				});
				statements.push({
					sql: "UPDATE source_import_records SET status = 'pending', rejection_code = NULL, updated_at = datetime('now') WHERE changes() > 0 AND job_id = ? AND agent_id = ? AND status = 'rejected' AND rejection_code NOT IN ('schema_invalid','malformed')",
					params: [jobId, agentId],
					result: "run",
				});
			} else {
				statements.push({
					sql: "UPDATE source_import_jobs SET state = CASE WHEN state IN ('running','inventorying') THEN state ELSE 'cancelled' END, control_request = CASE WHEN state IN ('running','inventorying') THEN 'cancel' ELSE NULL END, generation = CASE WHEN state IN ('running','inventorying') THEN generation ELSE generation + 1 END, lease_token = CASE WHEN state IN ('running','inventorying') THEN lease_token ELSE NULL END, lease_expires_at = CASE WHEN state IN ('running','inventorying') THEN lease_expires_at ELSE NULL END, updated_at = ? WHERE id = ? AND agent_id = ? AND state NOT IN ('completed','completed_with_rejections','cancelled')",
					params: [now(), jobId, agentId],
					result: "run",
				});
				statements.push({
					sql: "UPDATE source_import_records SET status = 'cancelled', rejection_code = 'cancelled_by_user', updated_at = datetime('now') WHERE job_id = ? AND agent_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'cancelled')",
					params: [jobId, agentId, jobId, agentId],
					result: "run",
				});
				statements.push({
					sql: "UPDATE source_import_files SET state = 'failed', error = 'cancelled_by_user', updated_at = datetime('now') WHERE job_id = ? AND agent_id = ? AND state IN ('ready','inventorying') AND EXISTS (SELECT 1 FROM source_import_jobs WHERE id = ? AND agent_id = ? AND state = 'cancelled')",
					params: [jobId, agentId, jobId, agentId],
					result: "run",
				});
			}
			const run = async (): Promise<Response> => {
				const result = await dbOwnerTransaction(statements, {
					operation: `sources.import.${control}`,
					lane: "write",
				});
				if (control === "cancel") await cleanupCancelledImport(jobId, agentId);
				const first = result[0] as { readonly changes?: number } | undefined;
				return c.json({ jobId, control, changed: (first?.changes ?? 0) > 0 });
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

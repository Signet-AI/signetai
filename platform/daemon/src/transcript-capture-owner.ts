import type { WriteDb } from "./db-accessor";
import { prepareTypedStatement } from "./db-accessor";
import { admitSessionTranscriptInDb } from "./session-transcripts";
import type { TranscriptCaptureJobInput } from "./transcript-capture-worker";
import { stagedScopeFilter } from "./staged-upload-owner";
export interface CaptureEnqueueInput {
	readonly input: TranscriptCaptureJobInput;
	readonly source: { readonly path: string; readonly sizeBytes: number; readonly mtimeMs: number } | null;
	readonly stored: { readonly content: string } | null;
	readonly sourceIdentity: string;
	readonly sourceSha256: string | null;
	readonly id: string;
	readonly createdAt: string;
	readonly maxAttempts: number;
}
const MAX_INLINE_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_CAPTURE_TOTAL_BYTES = 64 * 1024 * 1024;
const scalarString = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value : null;
function inlineBytes(transcript: string, raw: string | null): number {
	return Buffer.byteLength(transcript) + Buffer.byteLength(raw ?? "");
}
function existingInlineBytes(db: WriteDb, excludeId: string | null): number {
	return (
		prepareTypedStatement<{ bytes: number }>(
			db,
			`SELECT COALESCE(SUM(length(CAST(transcript AS BLOB)) + length(CAST(COALESCE(raw_transcript, '') AS BLOB))), 0) AS bytes FROM transcript_capture_jobs WHERE (? IS NULL OR id <> ?)`,
		).get(excludeId, excludeId)?.bytes ?? 0
	);
}
export class TranscriptCaptureBacklogFullError extends Error {
	readonly code = "TRANSCRIPT_CAPTURE_BACKLOG_FULL" as const;
	readonly retryable = true as const;
	constructor(limitBytes: number) {
		super(`inline transcript capture budget exceeded (${limitBytes} bytes)`);
		this.name = "TranscriptCaptureBacklogFullError";
	}
}
function enqueue(db: WriteDb, prepared: CaptureEnqueueInput): string | null {
	const { input, source, stored, sourceIdentity, sourceSha256, id, createdAt, maxAttempts } = prepared;
	const rawTranscript = input.rawTranscript ?? null;
	let resolvedId: string | null = id;
	if (!admitSessionTranscriptInDb(db, input)) {
		resolvedId = null;
		return resolvedId;
	}
	const existing = prepareTypedStatement<{
		id: string;
		status: string;
		source_sha256: string | null;
		source_size_bytes: number | null;
		source_mtime_ms: number | null;
		completed_at: string | null;
	}>(
		db,
		`SELECT id, status, source_sha256, source_size_bytes, source_mtime_ms, completed_at FROM transcript_capture_jobs WHERE agent_id = ? AND source_identity = ? ORDER BY created_at ASC LIMIT 1`,
	).get(input.agentId, sourceIdentity);
	resolvedId = scalarString(existing?.id) ?? id;
	const sameGeneration =
		Boolean(existing?.id) &&
		existing?.status !== "dead" &&
		(source
			? (existing?.status === "pending" || existing?.status === "processing") &&
				existing?.source_size_bytes === source.sizeBytes &&
				existing?.source_mtime_ms === source.mtimeMs
			: existing?.source_sha256 === sourceSha256);
	if (sameGeneration) return resolvedId;

	const canonicalAvailable =
		!source && input.transcript.trim().length === 0 && !rawTranscript?.trim() && Boolean(stored?.content);
	const storedTranscript = source || canonicalAvailable ? "" : input.transcript;
	const storedRaw = source || canonicalAvailable ? null : rawTranscript;
	const payloadBytes = inlineBytes(storedTranscript, storedRaw);
	if (payloadBytes > MAX_INLINE_CAPTURE_BYTES) {
		throw new Error(`inline transcript capture exceeds ${MAX_INLINE_CAPTURE_BYTES} bytes; provide transcriptPath`);
	}
	if (
		existingInlineBytes(db, existing?.id ? String(existing.id) : null) + payloadBytes >
		MAX_INLINE_CAPTURE_TOTAL_BYTES
	) {
		throw new TranscriptCaptureBacklogFullError(MAX_INLINE_CAPTURE_TOTAL_BYTES);
	}
	const preservedCompletedAt = source ? scalarString(existing?.completed_at) : null;

	if (existing?.id) {
		db.prepare(
			`UPDATE transcript_capture_jobs
		 SET harness = ?, session_key = ?, session_id = ?, project = ?,
		     transcript = ?, raw_transcript = ?, transcript_path = ?,
		     source_sha256 = ?, source_size_bytes = ?, source_mtime_ms = ?,
		     source_format = NULL, audit_path = NULL, captured_at = ?, ended_at = ?,
		     summary_status = 'not_requested', status = 'pending', attempts = 0,
		     max_attempts = ?, completed_at = ?, error = NULL, updated_at = ?
		 WHERE id = ?`,
		).run(
			input.harness,
			input.sessionKey,
			input.sessionId,
			input.project,
			storedTranscript,
			storedRaw,
			source?.path ?? null,
			sourceSha256,
			source?.sizeBytes ?? null,
			source?.mtimeMs ?? null,
			input.capturedAt,
			input.endedAt,
			maxAttempts,
			preservedCompletedAt,
			createdAt,
			resolvedId,
		);
		return resolvedId;
	}
	db.prepare(
		`INSERT INTO transcript_capture_jobs (
		id, agent_id, harness, session_key, session_id, project, transcript, raw_transcript,
		transcript_path, source_identity, source_sha256, source_size_bytes, source_mtime_ms,
		source_format, audit_path, captured_at, ended_at, summary_status, status, attempts,
		max_attempts, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'not_requested', 'pending', 0, ?, ?, ?)`,
	).run(
		id,
		input.agentId,
		input.harness,
		input.sessionKey,
		input.sessionId,
		input.project,
		storedTranscript,
		storedRaw,
		source?.path ?? null,
		sourceIdentity,
		sourceSha256,
		source?.sizeBytes ?? null,
		source?.mtimeMs ?? null,
		input.capturedAt,
		input.endedAt,
		maxAttempts,
		createdAt,
		createdAt,
	);
	return resolvedId;
}
export function enqueueTranscriptCaptureInTx(db: WriteDb, prepared: CaptureEnqueueInput): string | null {
	const scope = prepared.input.upload;
	const filter = scope ? stagedScopeFilter(scope, "") : null;
	if (
		scope &&
		(scope.agentId !== prepared.input.agentId ||
			scope.harness !== prepared.input.harness ||
			scope.sessionKey !== prepared.input.sessionKey ||
			prepared.source?.path !== `signet-upload:${scope.fileId}`)
	)
		throw new Error("Transcript upload binding mismatch");
	if (filter) {
		const row = prepareTypedStatement<{
			storage_state: string;
			result_json: string | null;
			sha256: string;
			upload_size: number | null;
		}>(
			db,
			`SELECT storage_state,result_json,sha256,upload_size FROM hook_transcript_uploads WHERE ${filter.sql} AND (storage_state = 'consumed' OR updated_at > datetime('now','-24 hours')) UNION ALL SELECT 'consumed' AS storage_state,result_json,sha256,size_bytes AS upload_size FROM hook_transcript_receipts WHERE ${filter.sql} AND consumed_at > datetime('now','-7 days') LIMIT 1`,
		).get(...filter.params, ...filter.params);
		if (!row) throw new Error("Transcript upload not found");
		if (row.result_json !== null) {
			const result: unknown = JSON.parse(row.result_json);
			if (typeof result !== "object" || result === null || !("queued" in result))
				throw new Error("Invalid upload receipt");
			if (result.queued === false) return null;
			if ("transcriptCaptureJobId" in result && typeof result.transcriptCaptureJobId === "string")
				return result.transcriptCaptureJobId;
			throw new Error("Invalid upload receipt");
		}
		if (row.storage_state !== "sealed") throw new Error("Transcript upload is not sealed");
		if (row.sha256 !== prepared.sourceSha256 || row.upload_size !== prepared.source?.sizeBytes)
			throw new Error("Transcript upload metadata mismatch");
	}
	const id = enqueue(db, prepared);
	if (filter) {
		const receipt = JSON.stringify({
			memoriesSaved: 0,
			queued: Boolean(id),
			...(id ? { transcriptCaptureJobId: id } : {}),
		});
		const published = prepareTypedStatement<{ id: string }>(
			db,
			`UPDATE hook_transcript_uploads SET storage_state = CASE WHEN ? IS NULL THEN 'sealed' ELSE 'consumed' END, result_json = ?, reserved_bytes = CASE WHEN ? IS NULL THEN reserved_bytes ELSE (SELECT COALESCE(SUM(length(content)),0) FROM hook_transcript_chunks WHERE file_id = hook_transcript_uploads.id AND agent_id = hook_transcript_uploads.agent_id) END, updated_at = datetime('now') WHERE ${filter.sql} AND storage_state = 'sealed' RETURNING id`,
		).get(id, receipt, id, ...filter.params);
		if (!published) throw new Error("Transcript upload receipt was not published");
	}
	return id;
}

export function purgeHookUploadSessionBatchInTx(db: WriteDb, agentId: string, sessionKey: string): number {
	const rows = prepareTypedStatement<{ file_id: string }>(
		db,
		`DELETE FROM hook_transcript_chunks WHERE (agent_id,file_id,generation,byte_offset) IN (SELECT c.agent_id,c.file_id,c.generation,c.byte_offset FROM hook_transcript_chunks c JOIN hook_transcript_uploads f ON f.agent_id = c.agent_id AND f.id = c.file_id WHERE f.agent_id = ? AND f.session_key IN (?,?) LIMIT 16) RETURNING file_id`,
	).all(agentId, sessionKey, `session:${sessionKey}`);
	if (rows.length) return rows.length;
	const removed = prepareTypedStatement<{ id: string }>(
		db,
		`DELETE FROM hook_transcript_uploads WHERE id IN (SELECT id FROM hook_transcript_uploads WHERE agent_id = ? AND session_key IN (?,?) LIMIT 16) RETURNING id`,
	).all(agentId, sessionKey, `session:${sessionKey}`).length;
	if (removed) return removed;
	return prepareTypedStatement<{ id: string }>(
		db,
		`DELETE FROM hook_transcript_receipts WHERE id IN (SELECT id FROM hook_transcript_receipts WHERE agent_id = ? AND session_key IN (?,?) LIMIT 16) RETURNING id`,
	).all(agentId, sessionKey, `session:${sessionKey}`).length;
}

export interface CaptureGeneration {
	readonly id: string;
	readonly agentId: string;
	readonly sourceSha256: string | null;
	readonly sourceSizeBytes: number | null;
	readonly sourceMtimeMs: number | null;
}
export type CaptureTransitionInput =
	| { readonly action: "recover"; readonly at: string }
	| { readonly action: "settle" }
	| {
			readonly action: "complete";
			readonly job: CaptureGeneration;
			readonly at: string;
			readonly result: {
				readonly auditPath: string | null;
				readonly sourceFormat: string | null;
				readonly sourceSha256: string;
				readonly sourceSizeBytes: number | null;
				readonly sourceMtimeMs: number | null;
			};
	  }
	| {
			readonly action: "fail";
			readonly job: CaptureGeneration;
			readonly at: string;
			readonly error: string;
			readonly terminal: boolean;
	  };
function settleCaptureUpload(db: WriteDb, agentId: string, jobId: string): number {
	const rows = prepareTypedStatement<{ id: string }>(
		db,
		`SELECT id FROM hook_transcript_uploads WHERE agent_id = ? AND json_extract(result_json,'$.transcriptCaptureJobId') = ? AND storage_state = 'consumed' LIMIT 16`,
	).all(agentId, jobId);
	const job = prepareTypedStatement<{ status: string }>(
		db,
		`SELECT status FROM transcript_capture_jobs WHERE agent_id = ? AND id = ? AND status IN ('completed','dead')`,
	).get(agentId, jobId);
	if (!job) return 0;
	if (job.status === "dead")
		db.prepare(
			`UPDATE hook_transcript_receipts SET result_json = json_object('memoriesSaved',0,'queued',json('false'),'captureFailed',json('true'),'transcriptCaptureJobId',?) WHERE agent_id = ? AND json_extract(result_json,'$.transcriptCaptureJobId') = ?`,
		).run(jobId, agentId, jobId);
	for (const row of rows) {
		db.prepare("DELETE FROM hook_transcript_chunks WHERE agent_id = ? AND file_id = ?").run(agentId, row.id);
		db.prepare("DELETE FROM hook_transcript_uploads WHERE agent_id = ? AND id = ?").run(agentId, row.id);
	}
	return rows.length;
}
function settleCompletedUploads(db: WriteDb): number {
	const jobs = prepareTypedStatement<{ agent_id: string; id: string }>(
		db,
		`SELECT u.agent_id,json_extract(u.result_json,'$.transcriptCaptureJobId') AS id FROM hook_transcript_uploads u WHERE u.storage_state = 'consumed' AND EXISTS (SELECT 1 FROM transcript_capture_jobs j WHERE j.agent_id = u.agent_id AND j.id = json_extract(u.result_json,'$.transcriptCaptureJobId') AND j.status IN ('completed','dead')) LIMIT 16`,
	).all();
	return jobs.reduce((count, job) => count + settleCaptureUpload(db, job.agent_id, job.id), 0);
}
export function transitionTranscriptCaptureInTx(db: WriteDb, input: CaptureTransitionInput): number {
	if (input.action === "recover") {
		db.prepare(
			`UPDATE transcript_capture_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END, error = CASE WHEN attempts >= max_attempts THEN COALESCE(error,'interrupted while processing') ELSE error END, updated_at = ? WHERE status = 'processing'`,
		).run(input.at);
		return settleCompletedUploads(db);
	}
	if (input.action === "settle") return settleCompletedUploads(db);
	const job = input.job;
	const params = [job.id, job.agentId, job.sourceSha256, job.sourceSizeBytes, job.sourceMtimeMs];
	const match =
		"WHERE id = ? AND agent_id = ? AND status = 'processing' AND source_sha256 IS ? AND source_size_bytes IS ? AND source_mtime_ms IS ?";
	if (input.action === "complete") {
		const result = input.result;
		db.prepare(
			`UPDATE transcript_capture_jobs SET status = 'completed', completed_at = ?, updated_at = ?, error = NULL, transcript = '', raw_transcript = NULL, audit_path = ?, source_format = ?, source_sha256 = ?, source_size_bytes = ?, source_mtime_ms = ? ${match}`,
		).run(
			input.at,
			input.at,
			result.auditPath,
			result.sourceFormat,
			result.sourceSha256,
			result.sourceSizeBytes,
			result.sourceMtimeMs,
			...params,
		);
	} else {
		db.prepare(`UPDATE transcript_capture_jobs SET status = ?, error = ?, updated_at = ? ${match}`).run(
			input.terminal ? "dead" : "failed",
			input.error.slice(0, 2000),
			input.at,
			...params,
		);
	}
	return settleCaptureUpload(db, job.agentId, job.id);
}

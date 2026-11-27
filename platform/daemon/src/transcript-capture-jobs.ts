import { createHash } from "node:crypto";
import { MAX_INLINE_TRANSCRIPT_BYTES } from "@signet/core/transcript-upload";
import { type WriteDb, prepareTypedStatement } from "./db-accessor";

export interface TranscriptCaptureJobInput {
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId: string;
	readonly project: string | null;
	readonly transcript: string;
	readonly rawTranscript?: string | null;
	readonly transcriptPath?: string | null;
	readonly basePath?: string;
	readonly capturedAt: string;
	readonly endedAt: string | null;
	readonly maxAttempts?: number;
}

export interface TranscriptCaptureSource {
	readonly path: string;
	readonly sizeBytes: number;
	readonly mtimeMs: number;
}

export interface TranscriptCaptureJobWrite {
	readonly input: TranscriptCaptureJobInput;
	readonly source: TranscriptCaptureSource | null;
	readonly sourceSha256: string | null;
	readonly storedAvailable: boolean;
	readonly createdAt: string;
}

export class TranscriptCaptureBacklogFullError extends Error {
	readonly code = "TRANSCRIPT_CAPTURE_BACKLOG_FULL" as const;
	readonly retryable = true as const;
	constructor(limitBytes: number) {
		super(`inline transcript capture budget exceeded (${limitBytes} bytes)`);
		this.name = "TranscriptCaptureBacklogFullError";
	}
}

const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_INLINE_CAPTURE_TOTAL_BYTES = 64 * 1024 * 1024;

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function scalarString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeMaxAttempts(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
	return Math.max(1, Math.min(20, Math.trunc(value)));
}

export function transcriptCaptureSourceIdentity(input: TranscriptCaptureJobInput, sourcePath: string | null): string {
	if (sourcePath) return `file:${input.harness.trim().toLowerCase()}:${sourcePath}`;
	if (input.sessionKey?.trim()) return `session:${input.sessionKey.trim()}`;
	return `inline:${input.sessionId.trim()}`;
}

export function transcriptCaptureJobId(input: TranscriptCaptureJobInput): string {
	const sourceIdentity = transcriptCaptureSourceIdentity(input, input.transcriptPath?.trim() || null);
	return `tcj_${sha256(`${input.agentId}\0${sourceIdentity}`).slice(0, 32)}`;
}

function inlineBytes(transcript: string, rawTranscript: string | null): number {
	return Buffer.byteLength(transcript, "utf8") + Buffer.byteLength(rawTranscript ?? "", "utf8");
}

function existingInlineBytes(db: WriteDb, excludeId: string | null): number {
	const row = prepareTypedStatement<{ bytes: number }>(
		db,
		`SELECT COALESCE(SUM(
			length(CAST(transcript AS BLOB)) + length(CAST(COALESCE(raw_transcript, '') AS BLOB))
		), 0) AS bytes
		 FROM transcript_capture_jobs
		 WHERE (? IS NULL OR id <> ?)`,
	).get(excludeId, excludeId);
	return row?.bytes ?? 0;
}

export function upsertTranscriptCaptureJobInTx(db: WriteDb, job: TranscriptCaptureJobWrite): string {
	const { input, source, sourceSha256 } = job;
	const rawTranscript = input.rawTranscript ?? null;
	const sourceIdentity = transcriptCaptureSourceIdentity(input, source?.path ?? null);
	const id = transcriptCaptureJobId({ ...input, transcriptPath: source?.path ?? null });
	const existing = prepareTypedStatement<{
		id: string;
		status: string;
		source_sha256: string | null;
		source_size_bytes: number | null;
		source_mtime_ms: number | null;
		completed_at: string | null;
	}>(
		db,
		`SELECT id, status, source_sha256, source_size_bytes, source_mtime_ms, completed_at
		 FROM transcript_capture_jobs
		 WHERE agent_id = ? AND source_identity = ?
		 ORDER BY created_at ASC
		 LIMIT 1`,
	).get(input.agentId, sourceIdentity);
	const resolvedId = existing?.id ?? id;
	const sameGeneration = existing
		? existing.status !== "dead" &&
			(source
				? (existing.status === "pending" || existing.status === "processing") &&
					existing.source_size_bytes === source.sizeBytes &&
					existing.source_mtime_ms === source.mtimeMs
				: existing.source_sha256 === sourceSha256)
		: false;
	if (sameGeneration) return resolvedId;

	const canonicalAvailable =
		!source && input.transcript.trim().length === 0 && !rawTranscript?.trim() && job.storedAvailable;
	const storedTranscript = source || canonicalAvailable ? "" : input.transcript;
	const storedRaw = source || canonicalAvailable ? null : rawTranscript;
	const payloadBytes = inlineBytes(storedTranscript, storedRaw);
	if (payloadBytes > MAX_INLINE_TRANSCRIPT_BYTES) {
		throw new Error(`inline transcript capture exceeds ${MAX_INLINE_TRANSCRIPT_BYTES} bytes; provide transcriptPath`);
	}
	if (existingInlineBytes(db, existing?.id ?? null) + payloadBytes > MAX_INLINE_CAPTURE_TOTAL_BYTES) {
		throw new TranscriptCaptureBacklogFullError(MAX_INLINE_CAPTURE_TOTAL_BYTES);
	}
	const preservedCompletedAt = source ? scalarString(existing?.completed_at) : null;
	const maxAttempts = normalizeMaxAttempts(input.maxAttempts);

	if (existing) {
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
			job.createdAt,
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
		job.createdAt,
		job.createdAt,
	);
	return id;
}

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DbAccessor, WriteDb } from "./db-accessor";
import { runWriteTxAsync } from "./db-accessor";
import { logger } from "./logger";
import { indexCanonicalTranscriptJsonl, writeTranscriptArtifact } from "./memory-lineage";
import { isNoiseSession } from "./session-noise";
import { awaitPressureClear, isSystemPressureHigh } from "./system-pressure";
import { getStoredSessionTranscriptInfoAsync, upsertSessionTranscriptAsync } from "./session-transcripts";
import { normalizeSessionTranscript } from "./transcript-normalization";
import { pruneTranscriptAudit, writeTranscriptAudit } from "./transcript-audit";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import {
	canonicalTranscriptRelativePath,
	inferTranscriptSourceFormat,
	withTranscriptFileLock,
} from "./transcript-jsonl";

export type TranscriptCaptureJobStatus = "pending" | "processing" | "completed" | "failed" | "dead";

export interface TranscriptCaptureJobInput {
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId: string;
	readonly project: string | null;
	readonly transcript: string;
	readonly rawTranscript?: string | null;
	readonly transcriptPath?: string | null;
	/** Workspace root owning the DB and transcript artifacts; one DB must not be shared across roots. */
	readonly basePath?: string;
	readonly capturedAt: string;
	readonly endedAt: string | null;
	readonly maxAttempts?: number;
}

interface TranscriptCaptureJobRow {
	readonly id: string;
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId: string;
	readonly project: string | null;
	readonly transcript: string;
	readonly rawTranscript: string;
	readonly transcriptPath: string | null;
	readonly sourceIdentity: string | null;
	readonly sourceSha256: string | null;
	readonly sourceSizeBytes: number | null;
	readonly sourceMtimeMs: number | null;
	readonly capturedAt: string;
	readonly endedAt: string | null;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly previouslyCompleted: boolean;
}

interface ResolvedTranscript {
	readonly raw: string;
	readonly transcript: string;
	readonly sourceFormat: string | null;
	readonly sourceSha256: string;
	readonly sourceSizeBytes: number | null;
	readonly sourceMtimeMs: number | null;
	readonly sessionCompleted: boolean;
}

interface TranscriptCaptureResult {
	readonly auditPath: string | null;
	readonly sourceFormat: string | null;
	readonly sourceSha256: string;
	readonly sourceSizeBytes: number | null;
	readonly sourceMtimeMs: number | null;
}

export interface TranscriptCaptureWorkerHandle {
	stop(): void;
	nudge(): void;
	readonly running: boolean;
}

export interface TranscriptCaptureStatusSummary {
	readonly pending: number;
	readonly processing: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestPendingAt: string | null;
	readonly lastError: string | null;
}

export interface TranscriptCaptureJobReceipt {
	readonly id: string;
	readonly status: TranscriptCaptureJobStatus;
	readonly error: string | null;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_INLINE_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_CAPTURE_TOTAL_BYTES = 64 * 1024 * 1024;
const POLL_INTERVAL_MS = 30_000;
const MAX_JOBS_PER_DRAIN_TICK = 5;
const SOURCE_GENERATION_MATCH = `
	   AND (source_sha256 = ? OR (source_sha256 IS NULL AND ? IS NULL))
	   AND (source_size_bytes = ? OR (source_size_bytes IS NULL AND ? IS NULL))
	   AND (source_mtime_ms = ? OR (source_mtime_ms IS NULL AND ? IS NULL))`;

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function nowIso(): string {
	return new Date().toISOString();
}

function scalarString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function scalarNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeMaxAttempts(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
	return Math.max(1, Math.min(20, Math.trunc(value)));
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sourceGenerationParams(
	job: TranscriptCaptureJobRow,
): readonly [string | null, string | null, number | null, number | null, number | null, number | null] {
	return [
		job.sourceSha256,
		job.sourceSha256,
		job.sourceSizeBytes,
		job.sourceSizeBytes,
		job.sourceMtimeMs,
		job.sourceMtimeMs,
	];
}

function basePathFor(input?: string): string {
	return input ?? process.env.SIGNET_PATH ?? process.cwd();
}

function sourceLockPath(basePath: string, agentId: string, sourceIdentity: string): string {
	const token = sha256(`${agentId}\0${sourceIdentity}`).slice(0, 32);
	return join(basePath, ".daemon", "locks", `transcript-capture-${token}`);
}

function sourceIdentityFor(input: TranscriptCaptureJobInput, sourcePath: string | null): string {
	if (sourcePath) return `file:${input.harness.trim().toLowerCase()}:${sourcePath}`;
	if (input.sessionKey?.trim()) return `session:${input.sessionKey.trim()}`;
	return `inline:${input.sessionId.trim()}`;
}

export function transcriptCaptureJobId(input: TranscriptCaptureJobInput): string {
	const sourceIdentity = sourceIdentityFor(input, input.transcriptPath?.trim() || null);
	return `tcj_${sha256(`${input.agentId}\0${sourceIdentity}`).slice(0, 32)}`;
}

interface SourceMetadata {
	readonly path: string;
	readonly sizeBytes: number;
	readonly mtimeMs: number;
}

interface SourceFingerprint extends SourceMetadata {
	readonly sha256: string;
}

async function statSource(path: string): Promise<SourceMetadata> {
	const resolvedPath = await realpath(path);
	const metadata = await stat(resolvedPath);
	return { path: resolvedPath, sizeBytes: metadata.size, mtimeMs: metadata.mtimeMs };
}

async function readSource(path: string): Promise<{ readonly raw: string; readonly fingerprint: SourceFingerprint }> {
	const resolvedPath = await realpath(path);
	const before = await stat(resolvedPath);
	const bytes = await readFile(resolvedPath);
	const after = await stat(resolvedPath);
	const fingerprint = {
		path: resolvedPath,
		sha256: sha256(bytes),
		sizeBytes: bytes.byteLength,
		mtimeMs: after.mtimeMs,
	};
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
		throw new Error(`transcript source changed while reading: ${resolvedPath}`);
	}
	return { raw: bytes.toString("utf8"), fingerprint };
}

function inlineBytes(transcript: string, rawTranscript: string | null): number {
	return Buffer.byteLength(transcript, "utf8") + Buffer.byteLength(rawTranscript ?? "", "utf8");
}

function existingInlineBytes(db: WriteDb, excludeId: string | null): number {
	const row = db
		.prepare(
			`SELECT COALESCE(SUM(
				length(CAST(transcript AS BLOB)) + length(CAST(COALESCE(raw_transcript, '') AS BLOB))
			), 0) AS bytes
			 FROM transcript_capture_jobs
			 WHERE (? IS NULL OR id <> ?)`,
		)
		.get(excludeId, excludeId) as { bytes?: unknown } | undefined;
	return scalarNumber(row?.bytes);
}

export async function enqueueTranscriptCaptureJob(
	dbAccessor: DbAccessor,
	input: TranscriptCaptureJobInput,
	signal?: AbortSignal,
): Promise<string | null> {
	const rawTranscript = input.rawTranscript ?? null;
	let source: SourceMetadata | null = null;
	if (input.transcriptPath?.trim()) {
		try {
			source = await statSource(input.transcriptPath);
		} catch (error) {
			if (!input.sessionKey?.trim()) throw error;
		}
	}
	const stored =
		!source && input.sessionKey?.trim()
			? await getStoredSessionTranscriptInfoAsync(input.sessionKey.trim(), input.agentId, dbAccessor, signal)
			: undefined;
	const inlineTranscript =
		input.transcript.trim().length > 0
			? input.transcript
			: rawTranscript?.trim()
				? rawTranscript
				: (stored?.content ?? "");
	const sourceIdentity = sourceIdentityFor(input, source?.path ?? null);
	const sourceSha256 = source ? null : sha256(inlineTranscript);
	if (!source && inlineTranscript.trim().length === 0) return null;
	const id = transcriptCaptureJobId({ ...input, transcriptPath: source?.path ?? null });
	const createdAt = nowIso();
	const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
	const basePath = basePathFor(input.basePath);
	const lockPath = sourceLockPath(basePath, input.agentId, sourceIdentity);
	return await withTranscriptFileLock(lockPath, async () => {
		let resolvedId = id;
		await runWriteTxAsync(
			dbAccessor,
			(db) => {
				const existing = db
					.prepare(
						`SELECT id, status, source_sha256, source_size_bytes, source_mtime_ms, completed_at
						 FROM transcript_capture_jobs
						 WHERE agent_id = ? AND source_identity = ?
						 ORDER BY created_at ASC
						 LIMIT 1`,
					)
					.get(input.agentId, sourceIdentity) as
					| {
							id?: unknown;
							status?: unknown;
							source_sha256?: unknown;
							source_size_bytes?: unknown;
							source_mtime_ms?: unknown;
							completed_at?: unknown;
					  }
					| undefined;
				resolvedId = scalarString(existing?.id) ?? id;
				const sameGeneration =
					Boolean(existing?.id) &&
					existing?.status !== "dead" &&
					// A completed source must be re-read. Size and mtime are only cheap
					// admission hints; they are not content identity.
					(source
						? (existing?.status === "pending" || existing?.status === "processing") &&
							existing?.source_size_bytes === source.sizeBytes &&
							existing?.source_mtime_ms === source.mtimeMs
						: existing?.source_sha256 === sourceSha256);
				if (sameGeneration) return;

				const canonicalAvailable =
					!source && input.transcript.trim().length === 0 && !rawTranscript?.trim() && Boolean(stored?.content);
				const storedTranscript = source || canonicalAvailable ? "" : input.transcript;
				const storedRaw = source || canonicalAvailable ? null : rawTranscript;
				const payloadBytes = inlineBytes(storedTranscript, storedRaw);
				if (payloadBytes > MAX_INLINE_CAPTURE_BYTES) {
					throw new Error(
						`inline transcript capture exceeds ${MAX_INLINE_CAPTURE_BYTES} bytes; provide transcriptPath`,
					);
				}
				if (
					existingInlineBytes(db, existing?.id ? String(existing.id) : null) + payloadBytes >
					MAX_INLINE_CAPTURE_TOTAL_BYTES
				) {
					throw new Error(`inline transcript capture budget exceeded (${MAX_INLINE_CAPTURE_TOTAL_BYTES} bytes)`);
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
					return;
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
			},
			{ operation: "transcript-capture.enqueue", signal },
		);
		return resolvedId;
	});
}

function resetInterruptedJobs(db: WriteDb): void {
	db.prepare(
		`UPDATE transcript_capture_jobs
		 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
		     error = CASE WHEN attempts >= max_attempts THEN COALESCE(error, 'interrupted while processing') ELSE error END,
		     updated_at = ?
		 WHERE status = 'processing'`,
	).run(nowIso());
}

async function leaseJob(dbAccessor: DbAccessor): Promise<TranscriptCaptureJobRow | null> {
	let leased: TranscriptCaptureJobRow | null = null;
	await runWriteTxAsync(dbAccessor, (db) => {
		const row = db
			.prepare(
				`SELECT * FROM transcript_capture_jobs
				 WHERE status IN ('pending', 'failed') AND attempts < max_attempts
				 ORDER BY created_at ASC
				 LIMIT 1`,
			)
			.get() as Record<string, unknown> | undefined;
		if (!row) return;
		const id = scalarString(row.id);
		if (!id) return;
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = 'processing', attempts = attempts + 1, updated_at = ?, error = NULL
			 WHERE id = ? AND status IN ('pending', 'failed')`,
		).run(nowIso(), id);
		leased = {
			id,
			agentId: scalarString(row.agent_id) ?? "default",
			harness: scalarString(row.harness) ?? "unknown",
			sessionKey: scalarString(row.session_key),
			sessionId: scalarString(row.session_id) ?? id,
			project: scalarString(row.project),
			transcript: scalarString(row.transcript) ?? "",
			rawTranscript: scalarString(row.raw_transcript) ?? "",
			transcriptPath: scalarString(row.transcript_path),
			sourceIdentity: scalarString(row.source_identity),
			sourceSha256: scalarString(row.source_sha256),
			sourceSizeBytes: typeof row.source_size_bytes === "number" ? row.source_size_bytes : null,
			sourceMtimeMs: typeof row.source_mtime_ms === "number" ? row.source_mtime_ms : null,
			capturedAt: scalarString(row.captured_at) ?? nowIso(),
			endedAt: scalarString(row.ended_at),
			attempts: scalarNumber(row.attempts) + 1,
			maxAttempts: scalarNumber(row.max_attempts),
			previouslyCompleted: scalarString(row.completed_at) !== null,
		};
	});
	return leased;
}

async function currentJobMatches(dbAccessor: DbAccessor, job: TranscriptCaptureJobRow): Promise<boolean> {
	return await dbAccessor.withReadDbAsync(
		async (db) => {
			const row = db
				.prepare(
					"SELECT status, source_sha256, source_size_bytes, source_mtime_ms FROM transcript_capture_jobs WHERE id = ?",
				)
				.get(job.id) as
				| { status?: unknown; source_sha256?: unknown; source_size_bytes?: unknown; source_mtime_ms?: unknown }
				| undefined;
			if (row?.status !== "processing") return false;
			if (!job.transcriptPath) return row.source_sha256 === job.sourceSha256;
			return row.source_size_bytes === job.sourceSizeBytes && row.source_mtime_ms === job.sourceMtimeMs;
		},
		{ siteToken: "db:transcript.capture.current" },
	);
}

async function sessionTranscript(
	dbAccessor: DbAccessor,
	job: TranscriptCaptureJobRow,
): Promise<{ readonly content: string; readonly completed: boolean }> {
	if (!job.sessionKey) return { content: "", completed: false };
	const stored = await getStoredSessionTranscriptInfoAsync(job.sessionKey, job.agentId, dbAccessor);
	return {
		content: stored?.content ?? "",
		completed: stored?.completedAt !== null && stored?.completedAt !== undefined,
	};
}

async function resolveJobTranscript(dbAccessor: DbAccessor, job: TranscriptCaptureJobRow): Promise<ResolvedTranscript> {
	const stored = await sessionTranscript(dbAccessor, job);
	if (job.transcriptPath) {
		const source = await readSource(job.transcriptPath);
		if (
			(job.sourceSizeBytes !== null && source.fingerprint.sizeBytes !== job.sourceSizeBytes) ||
			(job.sourceMtimeMs !== null && source.fingerprint.mtimeMs !== job.sourceMtimeMs)
		) {
			throw new Error(`transcript source metadata changed before processing: ${source.fingerprint.path}`);
		}
		return {
			raw: source.raw,
			transcript: normalizeSessionTranscript(job.harness, source.raw),
			sourceFormat: inferTranscriptSourceFormat(source.raw),
			sourceSha256: source.fingerprint.sha256,
			sourceSizeBytes: source.fingerprint.sizeBytes,
			sourceMtimeMs: source.fingerprint.mtimeMs,
			sessionCompleted: stored.completed,
		};
	}
	const raw = stored.content || job.rawTranscript || job.transcript;
	const transcript = job.transcript || (raw ? normalizeSessionTranscript(job.harness, raw) : "");
	return {
		raw,
		transcript,
		sourceFormat: raw ? inferTranscriptSourceFormat(raw) : "normalized",
		sourceSha256: job.sourceSha256 ?? sha256(transcript || raw),
		sourceSizeBytes: null,
		sourceMtimeMs: null,
		sessionCompleted: stored.completed,
	};
}

function captureResult(auditPath: string | null, resolved: ResolvedTranscript): TranscriptCaptureResult {
	return {
		auditPath,
		sourceFormat: resolved.sourceFormat,
		sourceSha256: resolved.sourceSha256,
		sourceSizeBytes: resolved.sourceSizeBytes,
		sourceMtimeMs: resolved.sourceMtimeMs,
	};
}

async function writeCaptureAudit(
	basePath: string,
	job: TranscriptCaptureJobRow,
	resolved: ResolvedTranscript,
): Promise<string> {
	const audit = await writeTranscriptAudit({
		basePath,
		agentId: job.agentId,
		sourceIdentity: job.sourceIdentity ?? `legacy:${job.id}`,
		sourcePath: job.transcriptPath,
		sourceSha256: resolved.sourceSha256,
		sourceSizeBytes: resolved.sourceSizeBytes,
		sourceFormat: resolved.sourceFormat,
		sessionId: job.sessionId,
		sessionKey: job.sessionKey,
		preview: job.transcriptPath ? undefined : resolved.raw,
		capturedAt: job.capturedAt,
	});
	return audit.latestPath;
}

async function processTranscriptCaptureJob(
	dbAccessor: DbAccessor,
	basePath: string,
	job: TranscriptCaptureJobRow,
): Promise<TranscriptCaptureResult> {
	const resolved = await resolveJobTranscript(dbAccessor, job);
	if (resolved.transcript.trim().length === 0) {
		logger.debug("transcripts", "Transcript capture job completed without canonical turns", {
			jobId: job.id,
			harness: job.harness,
			sessionKey: job.sessionKey,
		});
		return captureResult(await writeCaptureAudit(basePath, job, resolved), resolved);
	}
	const sourceBacked = Boolean(job.transcriptPath);
	if (!sourceBacked && job.sessionKey) {
		await upsertSessionTranscriptAsync(
			job.sessionKey,
			resolved.transcript,
			job.harness,
			job.project,
			job.agentId,
			job.endedAt ?? job.capturedAt,
			dbAccessor,
			{ completedAt: job.endedAt ?? job.capturedAt, preserveExistingContent: true },
		);
	}
	if (
		isNoiseSession({
			project: job.project,
			sessionKey: job.sessionKey,
			sessionId: job.sessionId,
			harness: job.harness,
		})
	) {
		return captureResult(await writeCaptureAudit(basePath, job, resolved), resolved);
	}
	const canonicalWasWritten = await writeCanonicalTranscriptFromSnapshot({
		basePath,
		agentId: job.agentId,
		harness: job.harness,
		sessionKey: job.sessionKey,
		sessionId: job.sessionId,
		project: job.project,
		rawTranscript: resolved.raw,
		transcript: resolved.transcript,
		capturedAt: job.capturedAt,
		transcriptPath: job.transcriptPath ?? undefined,
		preserveExistingSession: resolved.sessionCompleted || job.previouslyCompleted,
	});
	if (!canonicalWasWritten) return captureResult(null, resolved);
	if (sourceBacked && job.sessionKey && (!resolved.sessionCompleted || job.previouslyCompleted)) {
		await upsertSessionTranscriptAsync(
			job.sessionKey,
			resolved.transcript,
			job.harness,
			job.project,
			job.agentId,
			job.endedAt ?? job.capturedAt,
			dbAccessor,
			{ completedAt: job.endedAt ?? job.capturedAt, preserveExistingContent: true },
		);
	}
	const transcriptArtifact = await writeTranscriptArtifact({
		agentId: job.agentId,
		sessionId: job.sessionId,
		sessionKey: job.sessionKey,
		project: job.project,
		harness: job.harness,
		capturedAt: job.capturedAt,
		startedAt: null,
		endedAt: job.endedAt,
		transcript: resolved.transcript,
		summaryStatus: "not_requested",
		replaceExisting: job.sourceIdentity !== null,
	});
	await indexCanonicalTranscriptJsonl({
		agentId: job.agentId,
		sessionId: job.sessionId,
		sessionKey: job.sessionKey,
		project: job.project,
		harness: job.harness,
		capturedAt: job.capturedAt,
		startedAt: null,
		endedAt: job.endedAt,
		transcript: resolved.transcript,
		manifestPath: transcriptArtifact.manifestPath,
	});
	const auditPath = await writeCaptureAudit(basePath, job, resolved);
	logger.debug("transcripts", "Transcript capture job completed", {
		jobId: job.id,
		harness: job.harness,
		sessionKey: job.sessionKey,
		path: canonicalTranscriptRelativePath(job.harness),
		transcriptPath: transcriptArtifact.transcriptPath,
	});
	return captureResult(auditPath, resolved);
}

async function markDone(
	dbAccessor: DbAccessor,
	job: TranscriptCaptureJobRow,
	result: TranscriptCaptureResult,
): Promise<void> {
	const completedAt = nowIso();
	await runWriteTxAsync(dbAccessor, (db) => {
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = 'completed', completed_at = ?, updated_at = ?, error = NULL,
			     transcript = '', raw_transcript = NULL, audit_path = ?, source_format = ?,
			     source_sha256 = ?, source_size_bytes = ?, source_mtime_ms = ?
			 WHERE id = ? AND status = 'processing'
			${SOURCE_GENERATION_MATCH}`,
		).run(
			completedAt,
			completedAt,
			result.auditPath,
			result.sourceFormat,
			result.sourceSha256,
			result.sourceSizeBytes,
			result.sourceMtimeMs,
			job.id,
			...sourceGenerationParams(job),
		);
	});
}

async function markFailed(dbAccessor: DbAccessor, job: TranscriptCaptureJobRow, error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const status: TranscriptCaptureJobStatus = job.attempts >= job.maxAttempts ? "dead" : "failed";
	const updatedAt = nowIso();
	await runWriteTxAsync(dbAccessor, (db) => {
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = ?, error = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing'
			${SOURCE_GENERATION_MATCH}`,
		).run(status, message.slice(0, 2000), updatedAt, job.id, ...sourceGenerationParams(job));
	});
}

export async function cleanupTranscriptCaptureStorage(
	dbAccessor: DbAccessor,
	basePath: string,
): Promise<{ readonly clearedRows: number; readonly retainedBytes: number }> {
	const rows = await dbAccessor.withReadDbAsync(
		async (db) =>
			db
				.prepare(
					`SELECT id, transcript_path, agent_id, session_key,
						length(CAST(transcript AS BLOB)) + length(CAST(COALESCE(raw_transcript, '') AS BLOB)) AS bytes,
						EXISTS (
							SELECT 1 FROM session_transcripts st
							WHERE st.agent_id = transcript_capture_jobs.agent_id
							  AND st.session_key = transcript_capture_jobs.session_key
						) AS has_session_source
					 FROM transcript_capture_jobs
					 WHERE length(CAST(transcript AS BLOB)) + length(CAST(COALESCE(raw_transcript, '') AS BLOB)) > 0`,
				)
				.all() as Array<{
				id: string;
				transcript_path: string | null;
				agent_id: string;
				session_key: string | null;
				bytes: number;
				has_session_source: number;
			}>,
		{ siteToken: "db:transcript.capture.cleanup" },
	);
	const clearIds = rows
		.filter((row) => {
			const path = row.transcript_path;
			return Boolean(row.has_session_source) || Boolean(path && (existsSync(path) || existsSync(join(basePath, path))));
		})
		.map((row) => row.id);
	if (clearIds.length > 0) {
		await runWriteTxAsync(dbAccessor, (db) => {
			const clear = db.prepare(
				"UPDATE transcript_capture_jobs SET transcript = '', raw_transcript = NULL, updated_at = ? WHERE id = ?",
			);
			for (const id of clearIds) clear.run(nowIso(), id);
		});
	}
	return {
		clearedRows: clearIds.length,
		retainedBytes: rows.filter((row) => !clearIds.includes(row.id)).reduce((sum, row) => sum + row.bytes, 0),
	};
}

async function runTranscriptCaptureOnceInternal(dbAccessor: DbAccessor, basePath: string): Promise<boolean> {
	const job = await leaseJob(dbAccessor);
	if (!job) return false;
	const identity = job.sourceIdentity ?? `legacy:${job.id}`;
	return await withTranscriptFileLock(sourceLockPath(basePath, job.agentId, identity), async () => {
		if (!(await currentJobMatches(dbAccessor, job))) return true;
		try {
			const result = await processTranscriptCaptureJob(dbAccessor, basePath, job);
			await markDone(dbAccessor, job, result);
		} catch (error) {
			await markFailed(dbAccessor, job, error);
			throw error;
		}
		return true;
	});
}

export function runTranscriptCaptureOnce(dbAccessor: DbAccessor, basePath: string): Promise<boolean> {
	return runTranscriptCaptureOnceInternal(dbAccessor, basePath);
}

export async function startTranscriptCaptureWorker(
	dbAccessor: DbAccessor,
	basePath: string,
): Promise<TranscriptCaptureWorkerHandle> {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	await runWriteTxAsync(dbAccessor, resetInterruptedJobs);
	const cleanup = await cleanupTranscriptCaptureStorage(dbAccessor, basePath);
	const auditCleanup = await pruneTranscriptAudit(basePath);
	if (cleanup.clearedRows > 0 || auditCleanup.removedFiles > 0) {
		logger.info("transcripts", "Transcript capture storage cleanup completed", {
			clearedRows: cleanup.clearedRows,
			retainedBytes: cleanup.retainedBytes,
			auditFilesRemoved: auditCleanup.removedFiles,
			auditBytesRemoved: auditCleanup.removedBytes,
		});
	}

	const schedule = (delayMs: number): void => {
		if (stopped || timer) return;
		timer = setTimeout(() => {
			timer = null;
			void drain();
		}, delayMs);
	};

	const drain = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		let nextDelayMs = POLL_INTERVAL_MS;
		try {
			let processed = false;
			let processedThisTick = 0;
			do {
				if (isSystemPressureHigh()) await awaitPressureClear();
				processed = await runTranscriptCaptureOnce(dbAccessor, basePath).catch((error) => {
					logger.warn("transcripts", "Transcript capture job failed", {
						error: error instanceof Error ? error.message : String(error),
					});
					return false;
				});
				if (processed && !stopped) {
					processedThisTick++;
					await yieldToEventLoop();
				}
				if (processedThisTick >= MAX_JOBS_PER_DRAIN_TICK) nextDelayMs = 0;
			} while (processed && !stopped && processedThisTick < MAX_JOBS_PER_DRAIN_TICK);
		} finally {
			running = false;
			schedule(nextDelayMs);
		}
	};

	void drain();
	return {
		stop(): void {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		nudge(): void {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			void drain();
		},
		get running(): boolean {
			return running;
		},
	};
}

interface TranscriptStatusProjectionRow {
	readonly pending: number;
	readonly processing: number;
	readonly completed: number;
	readonly failed: number;
	readonly dead: number;
	readonly oldestPendingAt: string | null;
	readonly lastError: string | null;
}

const EMPTY_TRANSCRIPT_STATUS: TranscriptCaptureStatusSummary = {
	pending: 0,
	processing: 0,
	completed: 0,
	failed: 0,
	dead: 0,
	oldestPendingAt: null,
	lastError: null,
};

function projectionRowToSummary(row: TranscriptStatusProjectionRow): TranscriptCaptureStatusSummary {
	return {
		pending: row.pending,
		processing: row.processing,
		completed: row.completed,
		failed: row.failed,
		dead: row.dead,
		oldestPendingAt: row.oldestPendingAt ?? null,
		lastError: row.lastError ?? null,
	};
}

/**
 * Bounded capture status for /api/status and health surfaces.
 *
 * Reads the `transcript_capture_status` projection (migration 138), which
 * triggers maintain on every job mutation. The previous implementation
 * grouped `transcript_capture_jobs` — whose rows carry full transcript
 * payloads inline — directly on the HTTP-serving isolate, which wedged the
 * parent event loop on production-scale databases (#1670). Both reads here
 * are bounded: one projection row by primary key, or a SUM over the tiny
 * one-row-per-agent projection table. Same fields, same values, cheap source.
 */
export async function getTranscriptCaptureStatus(
	dbAccessor: DbAccessor,
	agentId?: string | null,
): Promise<TranscriptCaptureStatusSummary> {
	return await dbAccessor.withReadDbAsync(
		async (db) => {
			if (agentId) {
				const row = db
					.prepare(
						`SELECT pending, processing, completed, failed, dead,
					        oldest_pending_at AS oldestPendingAt, last_error AS lastError
					 FROM transcript_capture_status
					 WHERE agent_id = ?`,
					)
					.get(agentId) as TranscriptStatusProjectionRow | undefined;
				return row == null ? EMPTY_TRANSCRIPT_STATUS : projectionRowToSummary(row);
			}
			const row = db
				.prepare(
					`SELECT COALESCE(SUM(pending), 0) AS pending,
				        COALESCE(SUM(processing), 0) AS processing,
				        COALESCE(SUM(completed), 0) AS completed,
				        COALESCE(SUM(failed), 0) AS failed,
				        COALESCE(SUM(dead), 0) AS dead,
				        MIN(oldest_pending_at) AS oldestPendingAt,
				        (SELECT last_error FROM transcript_capture_status
				         WHERE last_error_at IS NOT NULL
				         ORDER BY last_error_at DESC LIMIT 1) AS lastError
				 FROM transcript_capture_status`,
				)
				.get() as TranscriptStatusProjectionRow | undefined;
			return row == null ? EMPTY_TRANSCRIPT_STATUS : projectionRowToSummary(row);
		},
		{ siteToken: "db:transcript.capture.status" },
	);
}

/** Read one agent-scoped capture receipt without exposing transcript content. */
export async function getTranscriptCaptureJobStatus(
	dbAccessor: DbAccessor,
	agentId: string,
	id: string,
): Promise<TranscriptCaptureJobReceipt | null> {
	return await dbAccessor.withReadDbAsync(
		async (db) => {
			const row = db
				.prepare(
					`SELECT id, status, error
				 FROM transcript_capture_jobs
				 WHERE id = ? AND agent_id = ?`,
				)
				.get(id, agentId) as { id?: unknown; status?: unknown; error?: unknown } | undefined;
			if (typeof row?.id !== "string" || typeof row.status !== "string") return null;
			return {
				id: row.id,
				status: row.status as TranscriptCaptureJobStatus,
				error: typeof row.error === "string" ? row.error : null,
			};
		},
		{ siteToken: "db:transcript.capture.receipt" },
	);
}

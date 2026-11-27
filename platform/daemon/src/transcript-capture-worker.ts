import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "@signet/core";
import type { DbAccessor, WriteDb } from "./db-accessor";
import { runWriteTxAsync } from "./db-accessor";
import { logger } from "./logger";
import { indexCanonicalTranscriptJsonl } from "./memory-lineage";
import { isNoiseSession } from "./session-noise";
import { awaitPressureClear, isSystemPressureHigh } from "./system-pressure";
import {
	admitSessionTranscriptInDb,
	getStoredSessionTranscriptInfoAsync,
	upsertSessionTranscriptAsync,
} from "./session-transcripts";
import { normalizeSessionTranscript } from "./transcript-normalization";
import { pruneTranscriptAudit } from "./transcript-audit";
import { captureTranscriptOwned } from "./session-transcript-lifecycle";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import {
	type TranscriptCaptureJobInput,
	transcriptCaptureSourceIdentity,
	upsertTranscriptCaptureJobInTx,
	sha256,
} from "./transcript-capture-jobs";
import { isTranscriptUploadPath, readTranscriptUploadPrefix } from "./transcript-upload-paths";
import {
	canonicalTranscriptRelativePath,
	inferTranscriptSourceFormat,
	withTranscriptFileLock,
} from "./transcript-jsonl";

export type TranscriptCaptureJobStatus = "pending" | "processing" | "completed" | "failed" | "dead";

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

class CanonicalTranscriptMismatchError extends Error {
	readonly name = "CanonicalTranscriptMismatchError";
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
const POLL_INTERVAL_MS = 30_000;
const MAX_JOBS_PER_DRAIN_TICK = 5;
const JOB_GENERATION_MATCH = `
	   AND (source_sha256 = ? OR (source_sha256 IS NULL AND ? IS NULL))
	   AND (source_size_bytes = ? OR (source_size_bytes IS NULL AND ? IS NULL))
	   AND (source_mtime_ms = ? OR (source_mtime_ms IS NULL AND ? IS NULL))
	   AND ended_at IS ?`;

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

function jobGenerationParams(
	job: TranscriptCaptureJobRow,
): readonly [string | null, string | null, number | null, number | null, number | null, number | null, string | null] {
	return [
		job.sourceSha256,
		job.sourceSha256,
		job.sourceSizeBytes,
		job.sourceSizeBytes,
		job.sourceMtimeMs,
		job.sourceMtimeMs,
		job.endedAt,
	];
}

function basePathFor(input?: string): string {
	return input ?? process.env.SIGNET_PATH ?? process.cwd();
}

export function sourceLockPath(basePath: string, agentId: string, sourceIdentity: string): string {
	const token = sha256(`${agentId}\0${sourceIdentity}`).slice(0, 32);
	return join(resolveWorkspaceLayout(basePath).runtime, "locks", `transcript-capture-${token}`);
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
	const sourceIdentity = transcriptCaptureSourceIdentity(input, source?.path ?? null);
	const sourceSha256 = source ? null : sha256(inlineTranscript);
	if (!source && inlineTranscript.trim().length === 0) return null;
	const createdAt = nowIso();
	const basePath = basePathFor(input.basePath);
	const lockPath = sourceLockPath(basePath, input.agentId, sourceIdentity);
	return await withTranscriptFileLock(lockPath, async () => {
		let resolvedId: string | null = null;
		await runWriteTxAsync(
			dbAccessor,
			(db) => {
				if (!admitSessionTranscriptInDb(db, input)) return;
				resolvedId = upsertTranscriptCaptureJobInTx(db, {
					input,
					source,
					sourceSha256,
					storedAvailable: Boolean(stored?.content),
					createdAt,
				});
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
					"SELECT status, source_sha256, source_size_bytes, source_mtime_ms, ended_at FROM transcript_capture_jobs WHERE id = ?",
				)
				.get(job.id) as
				| {
						status?: unknown;
						source_sha256?: unknown;
						source_size_bytes?: unknown;
						source_mtime_ms?: unknown;
						ended_at?: unknown;
				  }
				| undefined;
			if (row?.status !== "processing" || scalarString(row.ended_at) !== job.endedAt) return false;
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

async function readJobSource(
	basePath: string,
	job: TranscriptCaptureJobRow,
	path: string,
): Promise<{ readonly raw: string; readonly fingerprint: SourceFingerprint }> {
	if (job.sourceSizeBytes !== null && isTranscriptUploadPath(basePath, path)) {
		const bytes = await readTranscriptUploadPrefix(basePath, path, job.sourceSizeBytes);
		return {
			raw: bytes.toString("utf8"),
			fingerprint: { path, sha256: sha256(bytes), sizeBytes: bytes.byteLength, mtimeMs: job.sourceMtimeMs ?? 0 },
		};
	}
	const source = await readSource(path);
	if (
		(job.sourceSizeBytes !== null && source.fingerprint.sizeBytes !== job.sourceSizeBytes) ||
		(job.sourceMtimeMs !== null && source.fingerprint.mtimeMs !== job.sourceMtimeMs)
	) {
		throw new Error(`transcript source metadata changed before processing: ${source.fingerprint.path}`);
	}
	return source;
}

async function resolveJobTranscript(
	dbAccessor: DbAccessor,
	basePath: string,
	job: TranscriptCaptureJobRow,
): Promise<ResolvedTranscript> {
	const stored = await sessionTranscript(dbAccessor, job);
	if (job.transcriptPath) {
		const source = await readJobSource(basePath, job, job.transcriptPath);
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
): Promise<string | null> {
	const audit = await captureTranscriptOwned({
		kind: "audit",
		input: {
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
		},
	});
	return audit?.latestPath ?? null;
}

async function processTranscriptCaptureJob(
	dbAccessor: DbAccessor,
	basePath: string,
	job: TranscriptCaptureJobRow,
): Promise<TranscriptCaptureResult> {
	const resolved = await resolveJobTranscript(dbAccessor, basePath, job);
	if (resolved.transcript.trim().length === 0) {
		logger.debug("transcripts", "Transcript capture job completed without canonical turns", {
			jobId: job.id,
			harness: job.harness,
			sessionKey: job.sessionKey,
		});
		return captureResult(await writeCaptureAudit(basePath, job, resolved), resolved);
	}
	const sourceBacked = Boolean(job.transcriptPath);
	const indexedTranscript = await writeCanonicalTranscriptFromSnapshot({
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
	if (indexedTranscript === null) {
		throw new CanonicalTranscriptMismatchError(
			`canonical transcript mismatch: retained JSONL is richer or divergent for session ${job.sessionKey ?? job.sessionId}`,
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
	if (!sourceBacked && job.sessionKey) {
		await upsertSessionTranscriptAsync(
			job.sessionKey,
			indexedTranscript,
			job.harness,
			job.project,
			job.agentId,
			job.endedAt ?? job.capturedAt,
			dbAccessor,
			{ completedAt: job.endedAt ?? job.capturedAt, preserveExistingContent: true },
		);
	}
	if (sourceBacked && job.sessionKey && (!resolved.sessionCompleted || job.previouslyCompleted)) {
		await upsertSessionTranscriptAsync(
			job.sessionKey,
			indexedTranscript,
			job.harness,
			job.project,
			job.agentId,
			job.endedAt ?? job.capturedAt,
			dbAccessor,
			{ completedAt: job.endedAt ?? job.capturedAt, preserveExistingContent: true },
		);
	}
	await indexCanonicalTranscriptJsonl({
		agentId: job.agentId,
		sessionId: job.sessionId,
		sessionKey: job.sessionKey,
		project: job.project,
		harness: job.harness,
		capturedAt: job.capturedAt,
		startedAt: null,
		endedAt: job.endedAt,
		transcript: indexedTranscript,
	});
	const auditPath = await writeCaptureAudit(basePath, job, resolved);
	logger.debug("transcripts", "Transcript capture job completed", {
		jobId: job.id,
		harness: job.harness,
		sessionKey: job.sessionKey,
		path: canonicalTranscriptRelativePath(job.harness),
		transcriptPath: canonicalTranscriptRelativePath(job.harness),
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
			${JOB_GENERATION_MATCH}`,
		).run(
			completedAt,
			completedAt,
			result.auditPath,
			result.sourceFormat,
			result.sourceSha256,
			result.sourceSizeBytes,
			result.sourceMtimeMs,
			job.id,
			...jobGenerationParams(job),
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
			${JOB_GENERATION_MATCH}`,
		).run(status, message.slice(0, 2000), updatedAt, job.id, ...jobGenerationParams(job));
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
			if (error instanceof CanonicalTranscriptMismatchError) return true;
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

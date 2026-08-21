import { createHash } from "node:crypto";
import type { DbAccessor, WriteDb } from "./db-accessor";
import { runWriteTxAsync } from "./db-accessor";
import { logger } from "./logger";
import { indexCanonicalTranscriptJsonl, writeTranscriptArtifact } from "./memory-lineage";
import { isNoiseSession } from "./session-noise";
import { awaitPressureClear, isSystemPressureHigh } from "./system-pressure";
import { writeTranscriptAudit } from "./transcript-audit";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import { canonicalTranscriptRelativePath } from "./transcript-jsonl";

export type TranscriptCaptureJobStatus = "pending" | "processing" | "completed" | "failed" | "dead";

export interface TranscriptCaptureJobInput {
	readonly agentId: string;
	readonly harness: string;
	readonly sessionKey: string | null;
	readonly sessionId: string;
	readonly project: string | null;
	readonly transcript: string;
	readonly rawTranscript: string;
	readonly transcriptPath?: string | null;
	readonly capturedAt: string;
	readonly endedAt: string | null;
	readonly summaryStatus?: "pending" | "skipped" | "not_requested";
	readonly maxAttempts?: number;
}

interface TranscriptCaptureJobRow extends TranscriptCaptureJobInput {
	readonly id: string;
	readonly status: TranscriptCaptureJobStatus;
	readonly attempts: number;
	readonly maxAttempts: number;
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
const POLL_INTERVAL_MS = 30_000;
const MAX_JOBS_PER_DRAIN_TICK = 5;
let captureRunTail: Promise<void> = Promise.resolve();

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

export function transcriptCaptureJobId(input: TranscriptCaptureJobInput): string {
	const hash = createHash("sha256");
	hash.update(input.agentId);
	hash.update("\0");
	hash.update(input.sessionId);
	hash.update("\0");
	hash.update(input.capturedAt);
	hash.update("\0");
	const identityTranscript = input.transcript.trim().length > 0 ? input.transcript : input.rawTranscript;
	hash.update(String(identityTranscript.length));
	hash.update("\0");
	hash.update(createHash("sha256").update(identityTranscript).digest("hex"));
	return `tcj_${hash.digest("hex").slice(0, 32)}`;
}

export async function enqueueTranscriptCaptureJob(
	dbAccessor: DbAccessor,
	input: TranscriptCaptureJobInput,
	signal?: AbortSignal,
): Promise<string | null> {
	if (input.transcript.trim().length === 0 && input.rawTranscript.trim().length === 0) return null;
	const id = transcriptCaptureJobId(input);
	const createdAt = nowIso();
	const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
	let resolvedId = id;
	await runWriteTxAsync(
		dbAccessor,
		(db) => {
			// capturedAt is delivery time for hooks but file mtime for recovery scans.
			// Treat the stable snapshot identity + content as authoritative so a
			// hook/recovery race cannot create two jobs for the same snapshot.
			const existing = db
				.prepare(
					`SELECT id
				 FROM transcript_capture_jobs
				 WHERE agent_id = ? AND session_id = ? AND transcript = ?
				   AND status <> 'dead'
				 LIMIT 1`,
				)
				.get(input.agentId, input.sessionId, input.transcript) as { id?: unknown } | undefined;
			if (typeof existing?.id === "string") {
				resolvedId = existing.id;
				return;
			}
			db.prepare(
				`INSERT INTO transcript_capture_jobs (
				id, agent_id, harness, session_key, session_id, project, transcript, raw_transcript,
				transcript_path, captured_at, ended_at, summary_status, status, attempts, max_attempts, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				transcript = excluded.transcript,
				raw_transcript = COALESCE(excluded.raw_transcript, transcript_capture_jobs.raw_transcript),
				transcript_path = COALESCE(excluded.transcript_path, transcript_capture_jobs.transcript_path),
				project = excluded.project,
				ended_at = excluded.ended_at,
				summary_status = excluded.summary_status,
				updated_at = excluded.updated_at,
				status = CASE
					WHEN transcript_capture_jobs.status IN ('failed', 'dead') THEN 'pending'
					ELSE transcript_capture_jobs.status
				END,
				attempts = CASE
					WHEN transcript_capture_jobs.status IN ('failed', 'dead') THEN 0
					ELSE transcript_capture_jobs.attempts
				END,
				error = CASE
					WHEN transcript_capture_jobs.status IN ('failed', 'dead') THEN NULL
					ELSE transcript_capture_jobs.error
				END`,
			).run(
				id,
				input.agentId,
				input.harness,
				input.sessionKey,
				input.sessionId,
				input.project,
				input.transcript,
				input.rawTranscript || null,
				input.transcriptPath ?? null,
				input.capturedAt,
				input.endedAt,
				// Session summaries are retired. Keep the legacy column explicit so
				// old manifests cannot enqueue a second derived delivery path.
				"not_requested",
				maxAttempts,
				createdAt,
				createdAt,
			);
		},
		{ operation: "transcript-capture.enqueue", signal },
	);
	return resolvedId;
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
			capturedAt: scalarString(row.captured_at) ?? nowIso(),
			endedAt: scalarString(row.ended_at),
			summaryStatus: "not_requested",
			status: "processing",
			attempts: scalarNumber(row.attempts) + 1,
			maxAttempts: scalarNumber(row.max_attempts),
		};
	});
	return leased;
}

async function processTranscriptCaptureJob(basePath: string, job: TranscriptCaptureJobRow): Promise<void> {
	if (job.rawTranscript) {
		await writeTranscriptAudit({
			basePath,
			agentId: job.agentId,
			sessionId: job.sessionId,
			sessionKey: job.sessionKey,
			rawTranscript: job.rawTranscript,
			capturedAt: job.capturedAt,
		});
	}
	if (job.transcript.trim().length === 0) {
		logger.debug("transcripts", "Transcript capture job completed raw-audit only", {
			jobId: job.id,
			harness: job.harness,
			sessionKey: job.sessionKey,
		});
		return;
	}
	if (
		isNoiseSession({
			project: job.project,
			sessionKey: job.sessionKey,
			sessionId: job.sessionId,
			harness: job.harness,
		})
	) {
		logger.debug("transcripts", "Transcript capture job skipped canonical artifacts for noise session", {
			jobId: job.id,
			harness: job.harness,
			sessionKey: job.sessionKey,
		});
		return;
	}
	await writeCanonicalTranscriptFromSnapshot({
		basePath,
		agentId: job.agentId,
		harness: job.harness,
		sessionKey: job.sessionKey,
		sessionId: job.sessionId,
		project: job.project,
		rawTranscript: job.rawTranscript,
		transcript: job.transcript,
		capturedAt: job.capturedAt,
		transcriptPath: job.transcriptPath ?? undefined,
	});
	const transcriptArtifact = await writeTranscriptArtifact({
		agentId: job.agentId,
		sessionId: job.sessionId,
		sessionKey: job.sessionKey,
		project: job.project,
		harness: job.harness,
		capturedAt: job.capturedAt,
		startedAt: null,
		endedAt: job.endedAt,
		transcript: job.transcript,
		summaryStatus: job.summaryStatus,
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
		transcript: job.transcript,
		manifestPath: transcriptArtifact.manifestPath,
	});
	logger.debug("transcripts", "Transcript capture job completed", {
		jobId: job.id,
		harness: job.harness,
		sessionKey: job.sessionKey,
		path: canonicalTranscriptRelativePath(job.harness),
		transcriptPath: transcriptArtifact.transcriptPath,
	});
}

async function markDone(dbAccessor: DbAccessor, id: string): Promise<void> {
	await runWriteTxAsync(dbAccessor, (db) => {
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = 'completed', completed_at = ?, updated_at = ?, error = NULL
			 WHERE id = ?`,
		).run(nowIso(), nowIso(), id);
	});
}

async function markFailed(dbAccessor: DbAccessor, job: TranscriptCaptureJobRow, error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	const status: TranscriptCaptureJobStatus = job.attempts >= job.maxAttempts ? "dead" : "failed";
	await runWriteTxAsync(dbAccessor, (db) => {
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = ?, error = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, message.slice(0, 2000), nowIso(), job.id);
	});
}

async function runTranscriptCaptureOnceInternal(dbAccessor: DbAccessor, basePath: string): Promise<boolean> {
	const job = await leaseJob(dbAccessor);
	if (!job) return false;
	try {
		await processTranscriptCaptureJob(basePath, job);
		await markDone(dbAccessor, job.id);
	} catch (error) {
		await markFailed(dbAccessor, job, error);
		throw error;
	}
	return true;
}

export function runTranscriptCaptureOnce(dbAccessor: DbAccessor, basePath: string): Promise<boolean> {
	const run = captureRunTail.then(() => runTranscriptCaptureOnceInternal(dbAccessor, basePath));
	captureRunTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export async function startTranscriptCaptureWorker(
	dbAccessor: DbAccessor,
	basePath: string,
): Promise<TranscriptCaptureWorkerHandle> {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	await runWriteTxAsync(dbAccessor, resetInterruptedJobs);

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
				// bun:sqlite returns null (not undefined) for a missing row.
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
		{ siteToken: "transcript-capture-worker.ts:463" },
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
		{ siteToken: "transcript-capture-worker.ts:503" },
	);
}

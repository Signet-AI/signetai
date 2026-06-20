import { createHash } from "node:crypto";
import type { DbAccessor, WriteDb } from "./db-accessor";
import { logger } from "./logger";
import { indexCanonicalTranscriptJsonl, writeTranscriptArtifact } from "./memory-lineage";
import { isNoiseSession } from "./session-noise";
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

const DEFAULT_MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 30_000;

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

export function enqueueTranscriptCaptureJob(dbAccessor: DbAccessor, input: TranscriptCaptureJobInput): string | null {
	if (input.transcript.trim().length === 0 && input.rawTranscript.trim().length === 0) return null;
	const id = transcriptCaptureJobId(input);
	const createdAt = nowIso();
	const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
	dbAccessor.withWriteTx((db) => {
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
			input.summaryStatus ?? "not_requested",
			maxAttempts,
			createdAt,
			createdAt,
		);
	});
	return id;
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

function leaseJob(dbAccessor: DbAccessor): TranscriptCaptureJobRow | null {
	let leased: TranscriptCaptureJobRow | null = null;
	dbAccessor.withWriteTx((db) => {
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
			summaryStatus:
				(scalarString(row.summary_status) as TranscriptCaptureJobInput["summaryStatus"]) ?? "not_requested",
			status: "processing",
			attempts: scalarNumber(row.attempts) + 1,
			maxAttempts: scalarNumber(row.max_attempts),
		};
	});
	return leased;
}

async function processTranscriptCaptureJob(basePath: string, job: TranscriptCaptureJobRow): Promise<void> {
	if (job.rawTranscript) {
		writeTranscriptAudit({
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
	const transcriptArtifact = writeTranscriptArtifact({
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
	indexCanonicalTranscriptJsonl({
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

function markDone(dbAccessor: DbAccessor, id: string): void {
	dbAccessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = 'completed', completed_at = ?, updated_at = ?, error = NULL
			 WHERE id = ?`,
		).run(nowIso(), nowIso(), id);
	});
}

function markFailed(dbAccessor: DbAccessor, job: TranscriptCaptureJobRow, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const status: TranscriptCaptureJobStatus = job.attempts >= job.maxAttempts ? "dead" : "failed";
	dbAccessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE transcript_capture_jobs
			 SET status = ?, error = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, message.slice(0, 2000), nowIso(), job.id);
	});
}

export async function runTranscriptCaptureOnce(dbAccessor: DbAccessor, basePath: string): Promise<boolean> {
	const job = leaseJob(dbAccessor);
	if (!job) return false;
	try {
		await processTranscriptCaptureJob(basePath, job);
		markDone(dbAccessor, job.id);
	} catch (error) {
		markFailed(dbAccessor, job, error);
		throw error;
	}
	return true;
}

export function startTranscriptCaptureWorker(dbAccessor: DbAccessor, basePath: string): TranscriptCaptureWorkerHandle {
	let stopped = false;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	dbAccessor.withWriteTx(resetInterruptedJobs);

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
		try {
			let processed = false;
			do {
				processed = await runTranscriptCaptureOnce(dbAccessor, basePath).catch((error) => {
					logger.warn("transcripts", "Transcript capture job failed", {
						error: error instanceof Error ? error.message : String(error),
					});
					return false;
				});
			} while (processed && !stopped);
		} finally {
			running = false;
			schedule(POLL_INTERVAL_MS);
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

export function getTranscriptCaptureStatus(
	dbAccessor: DbAccessor,
	agentId?: string | null,
): TranscriptCaptureStatusSummary {
	return dbAccessor.withReadDb((db) => {
		const where = agentId ? "WHERE agent_id = ?" : "";
		const params = agentId ? [agentId] : [];
		const rows = db
			.prepare(
				`SELECT status, COUNT(*) AS count, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending
				 FROM transcript_capture_jobs ${where}
				 GROUP BY status`,
			)
			.all(...params) as Array<{ status: string; count: number; oldest_pending?: string | null }>;
		const latestError = db
			.prepare(
				`SELECT error FROM transcript_capture_jobs ${where}${where ? " AND" : "WHERE"} error IS NOT NULL
				 ORDER BY updated_at DESC LIMIT 1`,
			)
			.get(...params) as { error?: string | null } | undefined;
		const summary = {
			pending: 0,
			processing: 0,
			completed: 0,
			failed: 0,
			dead: 0,
			oldestPendingAt: null as string | null,
			lastError: latestError?.error ?? null,
		};
		for (const row of rows) {
			const key = row.status as keyof Pick<
				TranscriptCaptureStatusSummary,
				"pending" | "processing" | "completed" | "failed" | "dead"
			>;
			if (key in summary) summary[key] = row.count;
			if (row.oldest_pending) summary.oldestPendingAt = row.oldest_pending;
		}
		return summary;
	});
}

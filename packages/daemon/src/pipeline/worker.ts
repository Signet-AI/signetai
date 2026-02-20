/**
 * Job worker for the extraction/decision pipeline.
 *
 * Polls memory_jobs, leases work atomically inside withWriteTx,
 * processes extraction+decision, writes shadow audit records to
 * memory_history. Never mutates memory content in Phase B.
 */

import type { DbAccessor, WriteDb } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import type { DecisionConfig } from "./decision";
import { extractFactsAndEntities } from "./extraction";
import { runShadowDecisions } from "./decision";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface JobRow {
	id: string;
	memory_id: string;
	job_type: string;
	payload: string | null;
	attempts: number;
	max_attempts: number;
}

interface MemoryContentRow {
	content: string;
}

// ---------------------------------------------------------------------------
// Job enqueue (called by daemon remember endpoint)
// ---------------------------------------------------------------------------

export function enqueueExtractionJob(
	accessor: DbAccessor,
	memoryId: string,
): void {
	accessor.withWriteTx((db) => {
		// Dedup: skip if a pending/leased job already exists
		const existing = db
			.prepare(
				`SELECT 1 FROM memory_jobs
				 WHERE memory_id = ? AND job_type = 'extract'
				   AND status IN ('pending', 'leased')
				 LIMIT 1`,
			)
			.get(memoryId);
		if (existing) return;

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts,
			  created_at, updated_at)
			 VALUES (?, ?, 'extract', 'pending', 0, ?, ?, ?)`,
		).run(id, memoryId, 3, now, now);
	});
}

// ---------------------------------------------------------------------------
// Lease a job atomically
// ---------------------------------------------------------------------------

function leaseJob(
	db: WriteDb,
	jobType: string,
	maxAttempts: number,
): JobRow | null {
	const now = new Date().toISOString();

	const row = db
		.prepare(
			`SELECT id, memory_id, job_type, payload, attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = ? AND status = 'pending' AND attempts < ?
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(jobType, maxAttempts) as JobRow | undefined;

	if (!row) return null;

	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'leased', leased_at = ?, attempts = attempts + 1,
		     updated_at = ?
		 WHERE id = ?`,
	).run(now, now, row.id);

	return { ...row, attempts: row.attempts + 1 };
}

// ---------------------------------------------------------------------------
// Job completion / failure
// ---------------------------------------------------------------------------

function completeJob(
	db: WriteDb,
	jobId: string,
	result: string | null,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'completed', result = ?, completed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(result, now, now, jobId);
}

function failJob(
	db: WriteDb,
	jobId: string,
	error: string,
	attempts: number,
	maxAttempts: number,
): void {
	const now = new Date().toISOString();
	const status = attempts >= maxAttempts ? "dead" : "failed";

	// Failed jobs go back to pending for retry; dead jobs stay dead
	const nextStatus = status === "dead" ? "dead" : "pending";

	db.prepare(
		`UPDATE memory_jobs
		 SET status = ?, error = ?, failed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(nextStatus, error, now, now, jobId);
}

function updateExtractionStatus(
	db: WriteDb,
	memoryId: string,
	status: string,
): void {
	db.prepare(
		`UPDATE memories SET extraction_status = ? WHERE id = ?`,
	).run(status, memoryId);
}

// ---------------------------------------------------------------------------
// Shadow history recording
// ---------------------------------------------------------------------------

function recordShadowHistory(
	db: WriteDb,
	memoryId: string,
	proposal: {
		action: string;
		targetMemoryId?: string;
		confidence: number;
		reason: string;
	},
	meta: {
		extractionModel: string;
		factCount: number;
		entityCount: number;
	},
): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const metadata = JSON.stringify({
		shadow: true,
		proposedAction: proposal.action,
		targetMemoryId: proposal.targetMemoryId ?? null,
		confidence: proposal.confidence,
		extractionModel: meta.extractionModel,
		factCount: meta.factCount,
		entityCount: meta.entityCount,
	});

	db.prepare(
		`INSERT INTO memory_history
		 (id, memory_id, event, new_content, changed_by, reason, metadata, created_at)
		 VALUES (?, ?, 'updated', NULL, 'pipeline-shadow', ?, ?, ?)`,
	).run(id, memoryId, proposal.reason, metadata, now);
}

// ---------------------------------------------------------------------------
// Stale lease reaper
// ---------------------------------------------------------------------------

function reapStaleLeases(accessor: DbAccessor, timeoutMs: number): number {
	return accessor.withWriteTx((db) => {
		const cutoff = new Date(Date.now() - timeoutMs).toISOString();
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`UPDATE memory_jobs
				 SET status = 'pending', updated_at = ?
				 WHERE status = 'leased' AND leased_at < ?`,
			)
			.run(now, cutoff);
		return (result as any).changes ?? 0;
	});
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export function startWorker(
	accessor: DbAccessor,
	provider: LlmProvider,
	pipelineCfg: PipelineV2Config,
	decisionCfg: DecisionConfig,
): WorkerHandle {
	let running = true;
	let inflight: Promise<void> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let reapTimer: ReturnType<typeof setInterval> | null = null;

	// Backoff state
	let consecutiveFailures = 0;
	const BASE_DELAY = 1000;
	const MAX_DELAY = 30000;
	const JITTER = 500;

	async function processExtractJob(job: JobRow): Promise<void> {
		// Fetch memory content
		const row = accessor.withReadDb((db) =>
			db
				.prepare("SELECT content FROM memories WHERE id = ?")
				.get(job.memory_id) as MemoryContentRow | undefined,
		);

		if (!row) {
			accessor.withWriteTx((db) => {
				completeJob(db, job.id, JSON.stringify({ skipped: "memory_not_found" }));
			});
			return;
		}

		// Run extraction
		const extraction = await extractFactsAndEntities(row.content, provider);

		// Run shadow decisions on extracted facts
		const decisions = extraction.facts.length > 0
			? await runShadowDecisions(
					extraction.facts,
					accessor,
					provider,
					decisionCfg,
				)
			: { proposals: [], warnings: [] };

		// Record everything atomically
		accessor.withWriteTx((db) => {
			const resultPayload = JSON.stringify({
				facts: extraction.facts,
				entities: extraction.entities,
				proposals: decisions.proposals,
				warnings: [
					...extraction.warnings,
					...decisions.warnings,
				],
			});

			completeJob(db, job.id, resultPayload);
			updateExtractionStatus(db, job.memory_id, "completed");

			// Write shadow history for each proposal
			for (const proposal of decisions.proposals) {
				recordShadowHistory(db, job.memory_id, proposal, {
					extractionModel: pipelineCfg.extractionModel,
					factCount: extraction.facts.length,
					entityCount: extraction.entities.length,
				});
			}
		});

		logger.info("pipeline", "Extraction job completed", {
			jobId: job.id,
			memoryId: job.memory_id,
			facts: extraction.facts.length,
			entities: extraction.entities.length,
			proposals: decisions.proposals.length,
		});
	}

	async function tick(): Promise<void> {
		if (!running) return;

		try {
			// Lease a job inside write tx
			const job = accessor.withWriteTx((db) =>
				leaseJob(db, "extract", pipelineCfg.workerMaxRetries),
			);

			if (!job) return; // Nothing to do

			try {
				await processExtractJob(job);
				consecutiveFailures = 0;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				logger.warn("pipeline", "Job failed", {
					jobId: job.id,
					error: msg,
					attempt: job.attempts,
				});
				accessor.withWriteTx((db) => {
					failJob(db, job.id, msg, job.attempts, job.max_attempts);
					if (job.attempts >= job.max_attempts) {
						updateExtractionStatus(db, job.memory_id, "failed");
					}
				});
				consecutiveFailures++;
			}
		} catch (e) {
			logger.error(
				"pipeline",
				"Worker tick error",
				e instanceof Error ? e : new Error(String(e)),
			);
			consecutiveFailures++;
		}
	}

	function getBackoffDelay(): number {
		if (consecutiveFailures === 0) return pipelineCfg.workerPollMs;
		const exp = Math.min(
			BASE_DELAY * 2 ** consecutiveFailures,
			MAX_DELAY,
		);
		return exp + Math.random() * JITTER;
	}

	// Use setTimeout chain instead of setInterval for backoff support
	function scheduleTick(): void {
		if (!running) return;
		const delay = getBackoffDelay();
		pollTimer = setTimeout(async () => {
			inflight = tick();
			await inflight;
			inflight = null;
			scheduleTick();
		}, delay);
	}

	// Stale lease reaper runs every 60s
	reapTimer = setInterval(() => {
		if (!running) return;
		try {
			const reaped = reapStaleLeases(accessor, pipelineCfg.leaseTimeoutMs);
			if (reaped > 0) {
				logger.info("pipeline", "Reaped stale leases", { count: reaped });
			}
		} catch (e) {
			logger.warn("pipeline", "Lease reaper error", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}, 60000);

	// Start the tick loop
	scheduleTick();
	logger.info("pipeline", "Worker started", {
		pollMs: pipelineCfg.workerPollMs,
		maxRetries: pipelineCfg.workerMaxRetries,
		model: pipelineCfg.extractionModel,
	});

	return {
		get running() {
			return running;
		},
		async stop() {
			running = false;
			if (pollTimer) clearTimeout(pollTimer);
			if (reapTimer) clearInterval(reapTimer);
			if (inflight) await inflight;
			logger.info("pipeline", "Worker stopped");
		},
	};
}

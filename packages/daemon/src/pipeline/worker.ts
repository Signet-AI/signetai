/**
 * Job worker for the extraction/decision pipeline.
 *
 * Polls memory_jobs, leases work atomically inside withWriteTx,
 * processes extraction+decision, and records audit records in
 * memory_history. In shadow mode it logs proposals only; in
 * controlled-write mode it applies ADD/NONE decisions with safety gates.
 */

import type { DbAccessor, WriteDb } from "../db-accessor";
import type { PipelineV2Config } from "../memory-config";
import type { LlmProvider } from "./provider";
import type { DecisionConfig, FactDecisionProposal } from "./decision";
import { extractFactsAndEntities } from "./extraction";
import { runShadowDecisions } from "./decision";
import { logger } from "../logger";
import { txIngestEnvelope } from "../transactions";
import { normalizeAndHashContent } from "../content-normalization";
import { vectorToBlob, countChanges } from "../db-helpers";

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

interface AppliedWriteStats {
	added: number;
	deduped: number;
	skippedLowConfidence: number;
	blockedDestructive: number;
	reviewNeeded: number;
	embeddingsAdded: number;
}

const NEGATION_TOKENS = new Set([
	"not",
	"no",
	"never",
	"cannot",
	"cant",
	"doesnt",
	"dont",
	"isnt",
	"wasnt",
	"wont",
	"without",
]);

const CONTRADICTION_ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["enabled", "disabled"],
	["allow", "deny"],
	["accept", "reject"],
	["always", "never"],
	["on", "off"],
	["true", "false"],
];

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length >= 2);
}

function hasNegation(tokens: readonly string[]): boolean {
	return tokens.some((token) => NEGATION_TOKENS.has(token));
}

function overlapCount(
	left: readonly string[],
	right: readonly string[],
): number {
	const rightSet = new Set(right);
	let overlap = 0;
	for (const token of left) {
		if (rightSet.has(token)) overlap++;
	}
	return overlap;
}

function hasAntonymConflict(
	leftTokens: ReadonlySet<string>,
	rightTokens: ReadonlySet<string>,
): boolean {
	for (const [leftWord, rightWord] of CONTRADICTION_ANTONYM_PAIRS) {
		const leftHasLeft = leftTokens.has(leftWord);
		const leftHasRight = leftTokens.has(rightWord);
		const rightHasLeft = rightTokens.has(leftWord);
		const rightHasRight = rightTokens.has(rightWord);

		const leftExclusive = leftHasLeft !== leftHasRight;
		const rightExclusive = rightHasLeft !== rightHasRight;
		const oppositePolarity =
			(leftHasLeft && rightHasRight) || (leftHasRight && rightHasLeft);

		if (leftExclusive && rightExclusive && oppositePolarity) {
			return true;
		}
	}
	return false;
}

function detectContradictionRisk(
	factContent: string,
	targetContent: string | undefined,
): boolean {
	if (!targetContent) return false;

	const factTokens = tokenize(factContent);
	const targetTokens = tokenize(targetContent);
	if (factTokens.length === 0 || targetTokens.length === 0) return false;

	const lexicalOverlap = overlapCount(factTokens, targetTokens);
	if (lexicalOverlap < 2) return false;

	const factHasNegation = hasNegation(factTokens);
	const targetHasNegation = hasNegation(targetTokens);
	if (factHasNegation !== targetHasNegation) {
		return true;
	}

	return hasAntonymConflict(new Set(factTokens), new Set(targetTokens));
}

function zeroWriteStats(): AppliedWriteStats {
	return {
		added: 0,
		deduped: 0,
		skippedLowConfidence: 0,
		blockedDestructive: 0,
		reviewNeeded: 0,
		embeddingsAdded: 0,
	};
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

function completeJob(db: WriteDb, jobId: string, result: string | null): void {
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
	extractionModel?: string,
): void {
	if (extractionModel === undefined) {
		db.prepare("UPDATE memories SET extraction_status = ? WHERE id = ?").run(
			status,
			memoryId,
		);
		return;
	}
	db.prepare(
		`UPDATE memories
		 SET extraction_status = ?, extraction_model = ?
		 WHERE id = ?`,
	).run(status, extractionModel, memoryId);
}

// ---------------------------------------------------------------------------
// Decision audit + controlled writes
// ---------------------------------------------------------------------------

interface DecisionAuditMeta {
	readonly shadow: boolean;
	readonly extractionModel: string;
	readonly factCount: number;
	readonly entityCount: number;
	readonly createdMemoryId?: string;
	readonly dedupedExistingId?: string;
	readonly blockedReason?: string;
	readonly reviewNeeded?: boolean;
	readonly contradictionRisk?: boolean;
	readonly skippedReason?: string;
}

function recordDecisionHistory(
	db: WriteDb,
	memoryId: string,
	proposal: FactDecisionProposal,
	meta: DecisionAuditMeta,
): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const metadata = JSON.stringify({
		shadow: meta.shadow,
		proposedAction: proposal.action,
		targetMemoryId: proposal.targetMemoryId ?? null,
		targetContent: proposal.targetContent ?? null,
		confidence: proposal.confidence,
		fact: proposal.fact,
		extractionModel: meta.extractionModel,
		factCount: meta.factCount,
		entityCount: meta.entityCount,
		createdMemoryId: meta.createdMemoryId ?? null,
		dedupedExistingId: meta.dedupedExistingId ?? null,
		blockedReason: meta.blockedReason ?? null,
		reviewNeeded: meta.reviewNeeded === true,
		contradictionRisk: meta.contradictionRisk === true,
		skippedReason: meta.skippedReason ?? null,
	});

	db.prepare(
		`INSERT INTO memory_history
		 (id, memory_id, event, old_content, new_content, changed_by, reason, metadata, created_at)
		 VALUES (?, ?, 'none', NULL, NULL, ?, ?, ?, ?)`,
	).run(
		id,
		memoryId,
		meta.shadow ? "pipeline-shadow" : "pipeline-v2",
		proposal.reason,
		metadata,
		now,
	);
}

function recordCreatedMemoryHistory(
	db: WriteDb,
	memoryId: string,
	content: string,
	proposal: FactDecisionProposal,
	sourceMemoryId: string,
	extractionModel: string,
): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const metadata = JSON.stringify({
		proposedAction: proposal.action,
		sourceMemoryId,
		decisionConfidence: proposal.confidence,
		factConfidence: proposal.fact.confidence,
		extractionModel,
	});

	db.prepare(
		`INSERT INTO memory_history
		 (id, memory_id, event, old_content, new_content, changed_by, reason, metadata, created_at)
		 VALUES (?, ?, 'created', NULL, ?, 'pipeline-v2', ?, ?, ?)`,
	).run(id, memoryId, content, proposal.reason, metadata, now);
}

function insertMemoryEmbedding(
	db: WriteDb,
	memoryId: string,
	contentHash: string,
	content: string,
	vector: readonly number[],
	now: string,
): boolean {
	const embId = crypto.randomUUID();
	const blob = vectorToBlob(vector);
	db.prepare(
		`DELETE FROM embeddings
		 WHERE source_type = 'memory' AND source_id = ? AND content_hash <> ?`,
	).run(memoryId, contentHash);
	const insert = db.prepare(
		`INSERT INTO embeddings
		 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
		 ON CONFLICT(content_hash) DO UPDATE SET
		   vector = excluded.vector,
		   dimensions = excluded.dimensions,
		   source_type = excluded.source_type,
		   source_id = excluded.source_id,
		   chunk_text = excluded.chunk_text,
		   created_at = excluded.created_at`,
	);
	const result = insert.run(
		embId,
		contentHash,
		blob,
		vector.length,
		memoryId,
		content,
		now,
	);
	return countChanges(result) > 0;
}

function applyPhaseCWrites(
	db: WriteDb,
	sourceMemoryId: string,
	proposals: readonly FactDecisionProposal[],
	meta: {
		readonly extractionModel: string;
		readonly embeddingModel: string;
		readonly factCount: number;
		readonly entityCount: number;
		readonly minFactConfidenceForWrite: number;
		readonly allowUpdateDelete: boolean;
	},
	embeddingByHash: ReadonlyMap<string, readonly number[]>,
): AppliedWriteStats {
	const stats: AppliedWriteStats = {
		added: 0,
		deduped: 0,
		skippedLowConfidence: 0,
		blockedDestructive: 0,
		reviewNeeded: 0,
		embeddingsAdded: 0,
	};

	for (const proposal of proposals) {
		if (proposal.action === "add") {
			if (proposal.fact.confidence < meta.minFactConfidenceForWrite) {
				stats.skippedLowConfidence++;
				recordDecisionHistory(db, sourceMemoryId, proposal, {
					shadow: false,
					extractionModel: meta.extractionModel,
					factCount: meta.factCount,
					entityCount: meta.entityCount,
					skippedReason: "low_fact_confidence",
				});
				continue;
			}

			const normalized = normalizeAndHashContent(proposal.fact.content);
			if (normalized.normalizedContent.length === 0) {
				stats.skippedLowConfidence++;
				recordDecisionHistory(db, sourceMemoryId, proposal, {
					shadow: false,
					extractionModel: meta.extractionModel,
					factCount: meta.factCount,
					entityCount: meta.entityCount,
					skippedReason: "empty_fact_content",
				});
				continue;
			}

			const { storageContent, normalizedContent, contentHash } = normalized;
			const existing = db
				.prepare(
					`SELECT id FROM memories
					 WHERE content_hash = ? AND is_deleted = 0
					 LIMIT 1`,
				)
				.get(contentHash) as { id: string } | undefined;

			if (existing) {
				stats.deduped++;
				recordDecisionHistory(db, sourceMemoryId, proposal, {
					shadow: false,
					extractionModel: meta.extractionModel,
					factCount: meta.factCount,
					entityCount: meta.entityCount,
					dedupedExistingId: existing.id,
				});
				continue;
			}

			const now = new Date().toISOString();
			const newMemoryId = crypto.randomUUID();
			const vector = embeddingByHash.get(contentHash);

			let inserted = true;
			try {
				txIngestEnvelope(db, {
					id: newMemoryId,
					content: storageContent,
					normalizedContent,
					contentHash,
					who: "pipeline-v2",
					why: "extracted-fact",
					project: null,
					importance: Math.max(0, Math.min(1, proposal.fact.confidence)),
					type: proposal.fact.type,
					tags: null,
					pinned: 0,
					isDeleted: 0,
					extractionStatus: "completed",
					embeddingModel: vector ? meta.embeddingModel : null,
					extractionModel: meta.extractionModel,
					sourceType: "pipeline-v2",
					sourceId: sourceMemoryId,
					createdAt: now,
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				if (!message.includes("UNIQUE constraint")) {
					throw e;
				}
				inserted = false;
			}

			if (!inserted) {
				const collided = db
					.prepare(
						`SELECT id FROM memories
						 WHERE content_hash = ? AND is_deleted = 0
						 LIMIT 1`,
					)
					.get(contentHash) as { id: string } | undefined;
				stats.deduped++;
				recordDecisionHistory(db, sourceMemoryId, proposal, {
					shadow: false,
					extractionModel: meta.extractionModel,
					factCount: meta.factCount,
					entityCount: meta.entityCount,
					dedupedExistingId: collided?.id,
				});
				continue;
			}

			stats.added++;
			recordCreatedMemoryHistory(
				db,
				newMemoryId,
				storageContent,
				proposal,
				sourceMemoryId,
				meta.extractionModel,
			);
			recordDecisionHistory(db, sourceMemoryId, proposal, {
				shadow: false,
				extractionModel: meta.extractionModel,
				factCount: meta.factCount,
				entityCount: meta.entityCount,
				createdMemoryId: newMemoryId,
			});

			if (vector) {
				const insertedEmbedding = insertMemoryEmbedding(
					db,
					newMemoryId,
					contentHash,
					storageContent,
					vector,
					now,
				);
				if (insertedEmbedding) {
					stats.embeddingsAdded++;
				}
			}
			continue;
		}

		if (proposal.action === "none") {
			recordDecisionHistory(db, sourceMemoryId, proposal, {
				shadow: false,
				extractionModel: meta.extractionModel,
				factCount: meta.factCount,
				entityCount: meta.entityCount,
			});
			continue;
		}

		const contradictionRisk = detectContradictionRisk(
			proposal.fact.content,
			proposal.targetContent,
		);
		stats.blockedDestructive++;
		if (contradictionRisk) {
			stats.reviewNeeded++;
		}

		recordDecisionHistory(db, sourceMemoryId, proposal, {
			shadow: false,
			extractionModel: meta.extractionModel,
			factCount: meta.factCount,
			entityCount: meta.entityCount,
			blockedReason: meta.allowUpdateDelete
				? "destructive_mutations_not_implemented"
				: "destructive_mutations_disabled",
			reviewNeeded: contradictionRisk,
			contradictionRisk,
		});
	}

	return stats;
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
		return countChanges(result);
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
		const row = accessor.withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memories WHERE id = ?")
					.get(job.memory_id) as MemoryContentRow | undefined,
		);

		if (!row) {
			accessor.withWriteTx((db) => {
				completeJob(
					db,
					job.id,
					JSON.stringify({ skipped: "memory_not_found" }),
				);
			});
			return;
		}

		// Run extraction
		const extraction = await extractFactsAndEntities(row.content, provider);

		// Run shadow decisions on extracted facts
		const decisions =
			extraction.facts.length > 0
				? await runShadowDecisions(
						extraction.facts,
						accessor,
						provider,
						decisionCfg,
					)
				: { proposals: [], warnings: [] };

		const controlledWritesEnabled =
			pipelineCfg.enabled &&
			!pipelineCfg.shadowMode &&
			!pipelineCfg.mutationsFrozen;

		const embeddingByHash = new Map<string, readonly number[]>();
		const prefetchWarnings: string[] = [];
		if (controlledWritesEnabled) {
			for (const proposal of decisions.proposals) {
				if (proposal.action !== "add") continue;
				if (proposal.fact.confidence < pipelineCfg.minFactConfidenceForWrite) {
					continue;
				}

				const normalized = normalizeAndHashContent(proposal.fact.content);
				if (normalized.normalizedContent.length === 0) continue;

				const { contentHash, storageContent } = normalized;
				if (embeddingByHash.has(contentHash)) continue;

				try {
					const vector = await decisionCfg.fetchEmbedding(
						storageContent,
						decisionCfg.embedding,
					);
					if (vector && vector.length > 0) {
						embeddingByHash.set(contentHash, vector);
					}
				} catch (e) {
					prefetchWarnings.push(
						`Embedding prefetch failed: ${
							e instanceof Error ? e.message : String(e)
						}`,
					);
				}
			}
		}

		let writeStats = zeroWriteStats();

		// Record everything atomically.
		accessor.withWriteTx((db) => {
			if (controlledWritesEnabled) {
				writeStats = applyPhaseCWrites(
					db,
					job.memory_id,
					decisions.proposals,
					{
						extractionModel: pipelineCfg.extractionModel,
						embeddingModel: decisionCfg.embedding.model,
						factCount: extraction.facts.length,
						entityCount: extraction.entities.length,
						minFactConfidenceForWrite: pipelineCfg.minFactConfidenceForWrite,
						allowUpdateDelete: pipelineCfg.allowUpdateDelete,
					},
					embeddingByHash,
				);
			} else {
				for (const proposal of decisions.proposals) {
					recordDecisionHistory(db, job.memory_id, proposal, {
						shadow: true,
						extractionModel: pipelineCfg.extractionModel,
						factCount: extraction.facts.length,
						entityCount: extraction.entities.length,
					});
				}
			}

			const resultPayload = JSON.stringify({
				facts: extraction.facts,
				entities: extraction.entities,
				proposals: decisions.proposals,
				writeMode: controlledWritesEnabled ? "phase-c" : "shadow",
				writeStats,
				warnings: [
					...extraction.warnings,
					...decisions.warnings,
					...prefetchWarnings,
				],
			});

			completeJob(db, job.id, resultPayload);
			updateExtractionStatus(
				db,
				job.memory_id,
				"completed",
				pipelineCfg.extractionModel,
			);
		});

		logger.info("pipeline", "Extraction job completed", {
			jobId: job.id,
			memoryId: job.memory_id,
			facts: extraction.facts.length,
			entities: extraction.entities.length,
			proposals: decisions.proposals.length,
			writeMode: controlledWritesEnabled ? "phase-c" : "shadow",
			added: writeStats.added,
			deduped: writeStats.deduped,
			skippedLowConfidence: writeStats.skippedLowConfidence,
			blockedDestructive: writeStats.blockedDestructive,
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
						updateExtractionStatus(
							db,
							job.memory_id,
							"failed",
							pipelineCfg.extractionModel,
						);
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
		const exp = Math.min(BASE_DELAY * 2 ** consecutiveFailures, MAX_DELAY);
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
		mode:
			pipelineCfg.enabled &&
			!pipelineCfg.shadowMode &&
			!pipelineCfg.mutationsFrozen
				? "controlled-write"
				: "shadow",
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

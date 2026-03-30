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
import { cpus, loadavg } from "node:os";
import { extractFactsAndEntities } from "./extraction";
import { escalate } from "./extraction-escalation";
import { detectSemanticContradiction } from "./contradiction";
import { runShadowDecisions } from "./decision";
import { logger } from "../logger";
import { assessSignificance, type SignificanceConfig } from "./significance-gate";
import { txIngestEnvelope, txModifyMemory, txForgetMemory } from "../transactions";
import { archiveToCold } from "./retention-worker";
import { normalizeAndHashContent } from "../content-normalization";
import { vectorToBlob, countChanges, syncVecInsert, syncVecDeleteBySourceExceptHash } from "../db-helpers";
import { txPersistEntities } from "./graph-transactions";
import { invalidateTraversalCache } from "./graph-traversal";
import { enqueueHintsJob } from "./prospective-index";
import type { AnalyticsCollector } from "../analytics";
import type { TelemetryCollector } from "../telemetry";
import { generateWithTracking } from "./provider";
import { recoverStaleLeases, type StaleLeaseRecovery } from "./stale-leases";
import { assessWriteGate, type WriteGateConfig } from "./write-gate";
import { PROSPECTIVE_ANTONYM_PAIRS, tokenize, hasNegation, overlapCount, hasAntonymConflict } from "./antonyms";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerStats {
	readonly failures: number;
	readonly lastProgressAt: number;
	readonly pending: number;
	readonly processed: number;
	readonly backoffMs: number;
	readonly overloaded: boolean;
	readonly loadPerCpu: number | null;
	readonly maxLoadPerCpu: number;
	readonly overloadBackoffMs: number;
	readonly overloadSince: string | null;
	readonly nextTickInMs: number;
}

export interface WorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
	nudge(): void;
	readonly stats: WorkerStats;
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
	extraction_status: string | null;
	agent_id: string | null;
	project: string | null;
	scope: string | null;
	visibility: string | null;
	source_type: string | null;
	source_id: string | null;
}

interface WorkerRuntimeDeps {
	readonly now: () => number;
	readonly getLoadPerCpu: () => number | null;
}

interface WrittenFact {
	readonly memoryId: string;
	readonly content: string;
	readonly normalizedContent: string;
	readonly confidence: number;
}

interface AppliedWriteStats {
	added: number;
	updated: number;
	deleted: number;
	deduped: number;
	skippedLowConfidence: number;
	blockedDestructive: number;
	reviewNeeded: number;
	embeddingsAdded: number;
	writeGateConsidered: number;
	writeGatePassed: number;
	writeGateBlocked: number;
	writeGateBypassed: number;
	writeGateContinuityDiscounted: number;
	writtenFacts: WrittenFact[];
	dedupedFacts: WrittenFact[];
}

const WRITE_GATE_ALERT_MIN_SAMPLES = 5;

function detectContradictionRisk(factContent: string, targetContent: string | undefined): boolean {
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

	return hasAntonymConflict(new Set(factTokens), new Set(targetTokens), PROSPECTIVE_ANTONYM_PAIRS);
}

function zeroWriteStats(): AppliedWriteStats {
	return {
		added: 0,
		updated: 0,
		deleted: 0,
		deduped: 0,
		skippedLowConfidence: 0,
		blockedDestructive: 0,
		reviewNeeded: 0,
		embeddingsAdded: 0,
		writeGateConsidered: 0,
		writeGatePassed: 0,
		writeGateBlocked: 0,
		writeGateBypassed: 0,
		writeGateContinuityDiscounted: 0,
		writtenFacts: [],
		dedupedFacts: [],
	};
}

// ---------------------------------------------------------------------------
// Job enqueue (called by daemon remember endpoint)
// ---------------------------------------------------------------------------

export function enqueueExtractionJob(accessor: DbAccessor, memoryId: string): void {
	accessor.withWriteTx((db) => {
		// Skip if memory extraction is already complete (structured passthrough
		// or prior pipeline run). This prevents re-processing memories that
		// were ingested with pre-extracted data.
		const mem = db.prepare(`SELECT extraction_status FROM memories WHERE id = ? LIMIT 1`).get(memoryId) as
			| { extraction_status: string | null }
			| undefined;
		if (mem?.extraction_status === "complete" || mem?.extraction_status === "completed") return;

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

function leaseJob(db: WriteDb, jobType: string, maxAttempts: number): JobRow | null {
	const now = new Date().toISOString();
	const nowEpoch = Math.floor(Date.now() / 1000);

	// Per-job exponential backoff baked into the query: skip jobs whose
	// failed_at is too recent relative to their attempt count.
	// Backoff: ~5s after 1st fail, ~10s after 2nd, ~20s after 3rd... capped at 120s.
	// Jobs that have never failed (failed_at IS NULL) are always eligible.
	const row = db
		.prepare(
			`SELECT id, memory_id, job_type, payload, attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = ? AND status = 'pending' AND attempts < ?
			   AND (failed_at IS NULL
			        OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
			           > MIN((1 << attempts) * 5, 120))
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(jobType, maxAttempts, nowEpoch) as JobRow | undefined;

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

function failJob(db: WriteDb, jobId: string, error: string, attempts: number, maxAttempts: number): void {
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

function updateExtractionStatus(db: WriteDb, memoryId: string, status: string, extractionModel?: string): void {
	if (extractionModel === undefined) {
		db.prepare("UPDATE memories SET extraction_status = ? WHERE id = ?").run(status, memoryId);
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
	readonly updatedMemoryId?: string;
	readonly deletedMemoryId?: string;
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
		updatedMemoryId: meta.updatedMemoryId ?? null,
		deletedMemoryId: meta.deletedMemoryId ?? null,
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
	).run(id, memoryId, meta.shadow ? "pipeline-shadow" : "pipeline-v2", proposal.reason, metadata, now);
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
	expectedDimensions?: number,
): boolean {
	if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
		logger.warn("pipeline", "Embedding dimension mismatch, skipping vector insert", {
			got: vector.length,
			expected: expectedDimensions,
			memoryId,
		});
		return false;
	}
	const embId = crypto.randomUUID();
	const blob = vectorToBlob(vector);
	syncVecDeleteBySourceExceptHash(db, "memory", memoryId, contentHash);
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
	insert.run(embId, contentHash, blob, vector.length, memoryId, content, now);
	// Resolve actual embedding ID (may differ from embId on conflict)
	const actualRow = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get(contentHash) as
		| { id: string }
		| undefined;
	if (actualRow) {
		syncVecInsert(db, actualRow.id, vector);
	}
	return actualRow !== undefined;
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
		readonly expectedEmbeddingDimensions: number;
		readonly sourceAgentId: string;
		readonly sourceProject: string | null;
		readonly sourceScope: string | null;
		readonly sourceVisibility: "global" | "private" | "archived";
		readonly writeGate: WriteGateConfig;
		readonly semanticContradictions?: ReadonlyMap<number, { detected: boolean; confidence: number; reasoning: string }>;
	},
	embeddingByHash: ReadonlyMap<string, readonly number[]>,
): AppliedWriteStats {
	const stats = zeroWriteStats();
	const findByHash = (hash: string): { id: string } | undefined => {
		if (meta.sourceScope !== null) {
			return db
				.prepare(
					`SELECT id FROM memories
					 WHERE content_hash = ? AND is_deleted = 0
					   AND agent_id = ?
					   AND visibility = ?
					   AND scope = ?
					 LIMIT 1`,
				)
				.get(hash, meta.sourceAgentId, meta.sourceVisibility, meta.sourceScope) as { id: string } | undefined;
		}
		return db
			.prepare(
				`SELECT id FROM memories
				 WHERE content_hash = ? AND is_deleted = 0
				   AND agent_id = ?
				   AND visibility = ?
				   AND scope IS NULL
				 LIMIT 1`,
			)
			.get(hash, meta.sourceAgentId, meta.sourceVisibility) as { id: string } | undefined;
	};

	for (let proposalIdx = 0; proposalIdx < proposals.length; proposalIdx++) {
		const proposal = proposals[proposalIdx];
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
			const existing = findByHash(contentHash);

			if (existing) {
				stats.deduped++;
				stats.dedupedFacts.push({
					memoryId: existing.id,
					content: storageContent,
					normalizedContent,
					confidence: proposal.fact.confidence,
				});
				recordDecisionHistory(db, sourceMemoryId, proposal, {
					shadow: false,
					extractionModel: meta.extractionModel,
					factCount: meta.factCount,
					entityCount: meta.entityCount,
					dedupedExistingId: existing.id,
				});
				continue;
			}

			const gate = assessWriteGate(db, meta.writeGate, {
				agentId: meta.sourceAgentId,
				sourceMemoryId,
				sourceProject: meta.sourceProject,
				sourceScope: meta.sourceScope,
				sourceVisibility: meta.sourceVisibility,
				factType: proposal.fact.type,
				content: storageContent,
				vector: embeddingByHash.get(contentHash) ?? null,
			});

			if (gate.bypassed) {
				stats.writeGateBypassed++;
			}

			if (!gate.bypassed) {
				stats.writeGateConsidered++;
				if (gate.continuityApplied) {
					stats.writeGateContinuityDiscounted++;
				}
				if (!gate.pass) {
					stats.writeGateBlocked++;
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						skippedReason: "write_gate_low_surprisal",
					});
					continue;
				}
				stats.writeGatePassed++;
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
					project: meta.sourceProject,
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
					scope: meta.sourceScope,
					agentId: meta.sourceAgentId,
					visibility: meta.sourceVisibility,
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
				const collided = findByHash(contentHash);
				stats.deduped++;
				if (collided) {
					stats.dedupedFacts.push({
						memoryId: collided.id,
						content: storageContent,
						normalizedContent,
						confidence: proposal.fact.confidence,
					});
				}
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
			stats.writtenFacts.push({
				memoryId: newMemoryId,
				content: storageContent,
				normalizedContent,
				confidence: proposal.fact.confidence,
			});
			recordCreatedMemoryHistory(db, newMemoryId, storageContent, proposal, sourceMemoryId, meta.extractionModel);
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
					meta.expectedEmbeddingDimensions,
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

		if (meta.allowUpdateDelete) {
			if (proposal.action === "update") {
				const targetId = proposal.targetMemoryId;
				if (!targetId) {
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						skippedReason: "missing_target_id",
					});
					continue;
				}

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
				const vector = embeddingByHash.get(contentHash) ?? null;
				const now = new Date().toISOString();

				// Block update if semantic contradiction was detected
				const semConflict = meta.semanticContradictions?.get(proposalIdx);
				if (semConflict?.detected) {
					stats.reviewNeeded++;
					stats.blockedDestructive++;
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						blockedReason: "semantic_contradiction",
						reviewNeeded: true,
						contradictionRisk: true,
					});
					continue;
				}

				// Archive the pre-update state to cold tier before modifying
				archiveToCold(db, [targetId], "superseded");

				const result = txModifyMemory(db, {
					memoryId: targetId,
					patch: {
						content: storageContent,
						normalizedContent,
						contentHash,
						type: proposal.fact.type,
					},
					reason: proposal.reason,
					changedBy: "pipeline-v2",
					changedAt: now,
					extractionStatusOnContentChange: "completed",
					extractionModelOnContentChange: meta.extractionModel,
					embeddingModelOnContentChange: vector ? meta.embeddingModel : null,
					embeddingVector: vector,
					ctx: { actorType: "pipeline" },
				});

				if (result.status === "updated") {
					stats.updated++;
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						updatedMemoryId: targetId,
					});
				} else {
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						skippedReason: `update_${result.status}`,
					});
				}
				continue;
			}

			if (proposal.action === "delete") {
				const targetId = proposal.targetMemoryId;
				if (!targetId) {
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						skippedReason: "missing_target_id",
					});
					continue;
				}

				// Archive to cold tier before soft-deleting (lossless retention)
				archiveToCold(db, [targetId], "pipeline_delete");

				const now = new Date().toISOString();
				const result = txForgetMemory(db, {
					memoryId: targetId,
					reason: proposal.reason,
					changedBy: "pipeline-v2",
					changedAt: now,
					force: false,
					ctx: { actorType: "pipeline" },
				});

				if (result.status === "deleted") {
					stats.deleted++;
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						deletedMemoryId: targetId,
					});
				} else {
					recordDecisionHistory(db, sourceMemoryId, proposal, {
						shadow: false,
						extractionModel: meta.extractionModel,
						factCount: meta.factCount,
						entityCount: meta.entityCount,
						skippedReason: `delete_${result.status}`,
					});
				}
				continue;
			}
		}

		// Blocked: allowUpdateDelete is false or unknown action
		const contradictionRisk = detectContradictionRisk(proposal.fact.content, proposal.targetContent);
		stats.blockedDestructive++;
		if (contradictionRisk) {
			stats.reviewNeeded++;
		}

		recordDecisionHistory(db, sourceMemoryId, proposal, {
			shadow: false,
			extractionModel: meta.extractionModel,
			factCount: meta.factCount,
			entityCount: meta.entityCount,
			blockedReason: "destructive_mutations_disabled",
			reviewNeeded: contradictionRisk,
			contradictionRisk,
		});
	}

	return stats;
}

// ---------------------------------------------------------------------------
// Stale lease reaper
// ---------------------------------------------------------------------------

function reapStaleLeases(accessor: DbAccessor, timeoutMs: number): StaleLeaseRecovery {
	return accessor.withWriteTx((db) => {
		const cutoff = new Date(Date.now() - timeoutMs).toISOString();
		const now = new Date().toISOString();
		return recoverStaleLeases(db, { cutoff, now });
	});
}

// ---------------------------------------------------------------------------
// Pass 1: Structural assignment (no LLM)
// ---------------------------------------------------------------------------

interface StructuralPass1Stats {
	attributesCreated: number;
	classifyEnqueued: number;
	dependencyEnqueued: number;
}

/**
 * Heuristic entity linking for written facts. For each fact, find
 * matching entity triples, resolve entity IDs, create stub
 * entity_attributes rows (aspect_id=NULL), and enqueue classification
 * and dependency jobs. Runs synchronously, no LLM calls.
 */
function runStructuralPass1(
	accessor: DbAccessor,
	writtenFacts: readonly WrittenFact[],
	extractionTriples: readonly import("@signet/core").ExtractedEntity[],
): StructuralPass1Stats {
	const stats: StructuralPass1Stats = {
		attributesCreated: 0,
		classifyEnqueued: 0,
		dependencyEnqueued: 0,
	};

	return accessor.withWriteTx((db) => {
		for (const fact of writtenFacts) {
			const lowerContent = fact.content.toLowerCase();

			// Find matching entity triple — heuristic: fact content contains
			// the source entity name (case-insensitive)
			let matchedTriple: import("@signet/core").ExtractedEntity | null = null;
			for (const triple of extractionTriples) {
				if (lowerContent.includes(triple.source.toLowerCase())) {
					matchedTriple = triple;
					break;
				}
			}
			if (!matchedTriple) continue;

			// Resolve source entity ID from the entities table
			const canonical = matchedTriple.source.trim().toLowerCase().replace(/\s+/g, " ");
			const entityRow = db
				.prepare("SELECT id, entity_type, agent_id FROM entities WHERE canonical_name = ? LIMIT 1")
				.get(canonical) as { id: string; entity_type: string; agent_id: string } | undefined;
			if (!entityRow) continue;

			// Skip if this memory already has a structural attribute row (classified or stub)
			const existingAttr = db
				.prepare(`SELECT 1 FROM entity_attributes WHERE memory_id = ? LIMIT 1`)
				.get(fact.memoryId) as unknown | undefined;
			if (existingAttr) continue;

			// Create stub entity_attributes row (aspect_id=NULL, awaiting classification)
			const attrId = crypto.randomUUID();
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				  confidence, importance, status, created_at, updated_at)
				 VALUES (?, NULL, ?, ?, 'attribute', ?, ?, ?, 0.5, 'active', ?, ?)`,
			).run(attrId, entityRow.agent_id, fact.memoryId, fact.content, fact.normalizedContent, fact.confidence, now, now);
			stats.attributesCreated++;

			// Enqueue structural_classify job
			const classifyPayload = JSON.stringify({
				memory_id: fact.memoryId,
				entity_id: entityRow.id,
				entity_name: matchedTriple.source,
				entity_type: entityRow.entity_type,
				fact_content: fact.content,
				attribute_id: attrId,
				agent_id: entityRow.agent_id,
			});
			enqueueStructuralJob(db, fact.memoryId, "structural_classify", classifyPayload);
			stats.classifyEnqueued++;

			// If target entity exists in graph, enqueue structural_dependency job
			if (matchedTriple.target) {
				const targetCanonical = matchedTriple.target.trim().toLowerCase().replace(/\s+/g, " ");
				if (targetCanonical !== canonical) {
					const targetRow = db
						.prepare("SELECT id FROM entities WHERE canonical_name = ? LIMIT 1")
						.get(targetCanonical) as { id: string } | undefined;
					if (targetRow) {
						const depPayload = JSON.stringify({
							memory_id: fact.memoryId,
							entity_id: entityRow.id,
							entity_name: matchedTriple.source,
							fact_content: fact.content,
							target_entity_name: matchedTriple.target,
						});
						enqueueStructuralJob(db, fact.memoryId, "structural_dependency", depPayload);
						stats.dependencyEnqueued++;
					}
				}
			}
		}

		return stats;
	});
}

function enqueueStructuralJob(db: WriteDb, memoryId: string, jobType: string, payload: string): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts,
		  created_at, updated_at)
		 VALUES (?, ?, ?, 'pending', ?, 0, 3, ?, ?)`,
	).run(id, memoryId, jobType, payload, now, now);
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

interface MemoryRecoveryResult {
	readonly updated: number;
}

/**
 * Mark memory_jobs that are stuck in 'pending' with attempts >= their
 * effective retry limit as 'dead'. The effective limit is the lesser of the
 * stored max_attempts column and the current runtime maxRetries value, so
 * that jobs are also recovered when the operator lowers maxRetries after rows
 * were originally inserted with a higher max_attempts value.
 *
 * @param accessor - DB accessor
 * @param maxRetries - runtime retry limit from pipelineCfg.worker.maxRetries
 */
export function recoverMemoryJobs(
	accessor: DbAccessor,
	maxRetries?: number,
): MemoryRecoveryResult {
	return accessor.withWriteTx((db) => {
		const table = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_jobs'")
			.get() as { name: string } | undefined;
		if (!table) return { updated: 0 };

		// Use MIN(max_attempts, maxRetries) so that both the DB-stored limit and
		// the current runtime limit are honoured. When maxRetries is undefined
		// (e.g. called from tests without a pipeline config) fall back to the
		// column value only.
		const updated =
			maxRetries !== undefined
				? countChanges(
						db
							.prepare(
								`UPDATE memory_jobs
							 SET status = 'dead'
							 WHERE status = 'pending'
							   AND attempts >= MIN(max_attempts, ?)`,
							)
							.run(maxRetries),
					)
				: countChanges(
						db
							.prepare(
								`UPDATE memory_jobs
							 SET status = 'dead'
							 WHERE status = 'pending' AND attempts >= max_attempts`,
							)
							.run(),
					);
		return { updated };
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
	analytics?: AnalyticsCollector,
	telemetry?: TelemetryCollector,
	runtimeDeps?: Partial<WorkerRuntimeDeps>,
): WorkerHandle {
	const runtime: WorkerRuntimeDeps = {
		now: runtimeDeps?.now ?? (() => Date.now()),
		getLoadPerCpu:
			runtimeDeps?.getLoadPerCpu ??
			(() => {
				if (process.platform === "win32") return null;
				const cpuCount = cpus().length;
				if (cpuCount <= 0) return null;
				const oneMinuteLoad = loadavg()[0];
				if (!Number.isFinite(oneMinuteLoad)) return null;
				return oneMinuteLoad / cpuCount;
			}),
	};
	let running = true;
	let inflight: Promise<void> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let reapTimer: ReturnType<typeof setInterval> | null = null;

	// Backoff state
	let consecutiveFailures = 0;
	const BASE_DELAY = 1000;
	const MAX_DELAY = 15000;
	const JITTER = 500;

	// Progress tracking for watchdog and stats
	let lastAttempt = runtime.now(); // updated on every tick (success or failure)
	let lastSuccess = runtime.now(); // updated only on successful job completion
	let processed = 0;
	let overloaded = false;
	let lastLoadPerCpu: number | null = null;
	let overloadSinceEpochMs: number | null = null;
	let nextTickAtEpochMs = runtime.now();
	let watchdog: ReturnType<typeof setInterval> | null = null;
	const WATCHDOG_INTERVAL = 30_000;
	const STALL_THRESHOLD = 60_000;

	async function processExtractJob(job: JobRow): Promise<void> {
		// Fetch memory content + extraction status
		const row = accessor.withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT content, extraction_status, agent_id, project, scope, visibility, source_type, source_id
						 FROM memories
						 WHERE id = ?`,
					)
					.get(job.memory_id) as MemoryContentRow | undefined,
		);

		if (!row) {
			accessor.withWriteTx((db) => {
				completeJob(db, job.id, JSON.stringify({ skipped: "memory_not_found" }));
			});
			return;
		}

		// Bail if memory was already extracted (structured passthrough or
		// prior run). Completes the job without running LLM extraction.
		if (row.extraction_status === "complete" || row.extraction_status === "completed") {
			accessor.withWriteTx((db) => {
				completeJob(db, job.id, JSON.stringify({ skipped: "already_extracted" }));
			});
			return;
		}

		const agentId = typeof row.agent_id === "string" && row.agent_id.trim().length > 0 ? row.agent_id : "default";
		const sourceProject = typeof row.project === "string" && row.project.length > 0 ? row.project : null;
		const sourceScope = typeof row.scope === "string" && row.scope.length > 0 ? row.scope : null;
		const sourceVisibility =
			row.visibility === "private" || row.visibility === "archived" || row.visibility === "global"
				? row.visibility
				: "global";
		const sourceSessionKey =
			row.source_type === "session" && typeof row.source_id === "string" && row.source_id.length > 0
				? row.source_id
				: null;

		// --- Significance gate: skip extraction for trivial sessions ---
		const sigCfg: SignificanceConfig = pipelineCfg.significance ?? {
			enabled: true,
			minTurns: 5,
			minEntityOverlap: 1,
			noveltyThreshold: 0.15,
		};

		if (sigCfg.enabled) {
			const assessment = accessor.withReadDb((db) => assessSignificance(row.content, db, agentId, sigCfg));

			if (!assessment.significant) {
				logger.info("pipeline", "Session below significance threshold — skipping extraction", {
					jobId: job.id,
					memoryId: job.memory_id,
					scores: assessment.scores,
					reason: assessment.reason,
				});

				// Mark the job complete with gate result — raw transcript
				// is already persisted, only LLM extraction is skipped.
				accessor.withWriteTx((db) => {
					completeJob(
						db,
						job.id,
						JSON.stringify({
							skipped: "significance_gate",
							scores: assessment.scores,
							reason: assessment.reason,
						}),
					);
					updateExtractionStatus(db, job.memory_id, "completed");
				});
				return;
			}
		}

		// Wrap provider to capture llm.generate telemetry on every call
		const instrumentedProvider: LlmProvider = telemetry
			? {
					name: provider.name,
					available: () => provider.available(),
					async generate(prompt, opts) {
						const start = Date.now();
						try {
							const result = await generateWithTracking(provider, prompt, opts);
							telemetry.record("llm.generate", {
								provider: provider.name,
								inputTokens: result.usage?.inputTokens ?? null,
								outputTokens: result.usage?.outputTokens ?? null,
								cacheReadTokens: result.usage?.cacheReadTokens ?? null,
								cacheCreationTokens: result.usage?.cacheCreationTokens ?? null,
								totalCost: result.usage?.totalCost ?? null,
								durationMs: Date.now() - start,
								success: true,
								errorCode: null,
							});
							return result.text;
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							telemetry.record("llm.generate", {
								provider: provider.name,
								inputTokens: null,
								outputTokens: null,
								cacheReadTokens: null,
								cacheCreationTokens: null,
								totalCost: null,
								durationMs: Date.now() - start,
								success: false,
								errorCode: msg.includes("timeout") ? "TIMEOUT" : "ERROR",
							});
							throw e;
						}
					},
				}
			: provider;

		// Run extraction — strength controls max tokens and timeout scaling
		const strengthMaxTokens = { low: 1024, medium: 2048, high: 4096 } as const;
		const strengthTimeoutMultiplier = { low: 1, medium: 1.5, high: 2.5 } as const;
		const strength = pipelineCfg.extraction.strength;
		const extractionMaxTokens = strengthMaxTokens[strength] ?? 1024;
		const rawExtractionTimeout = Math.round(
			pipelineCfg.extraction.timeout * (strengthTimeoutMultiplier[strength] ?? 1),
		);
		// Cap timeout to half the lease timeout to prevent duplicate job processing
		// when escalation triggers two sequential LLM calls
		const leaseLimit = Math.max(Math.floor(pipelineCfg.worker.leaseTimeoutMs / 2), 30_000);
		const extractionTimeout = Math.min(rawExtractionTimeout, leaseLimit);
		const extractionStart = Date.now();
		const rawExtraction = await extractFactsAndEntities(row.content, instrumentedProvider, {
			timeoutMs: extractionTimeout,
			maxTokens: extractionMaxTokens,
		});
		const extractionMs = Date.now() - extractionStart;

		// Escalation: check output volume and re-run or filter if noisy
		const escalationThresholds = pipelineCfg.extraction.escalation ?? {
			maxNewEntitiesPerChunk: 10,
			maxNewAttributesPerEntity: 20,
			level2MaxEntities: 5,
		};

		const escalated = await escalate(
			row.content,
			rawExtraction,
			instrumentedProvider,
			accessor,
			agentId,
			escalationThresholds,
			{ timeoutMs: extractionTimeout, maxTokens: extractionMaxTokens },
		);

		const extraction = escalated.result;

		telemetry?.record("pipeline.extraction", {
			factCount: extraction.facts.length,
			entityCount: extraction.entities.length,
			warningCount: extraction.warnings.length,
			durationMs: extractionMs,
			model: pipelineCfg.extraction.model,
			escalationLevel: escalated.level,
			originalEntityCount: escalated.originalEntityCount,
			originalFactCount: escalated.originalFactCount,
		});

		// Run shadow decisions on extracted facts
		const decisions =
			extraction.facts.length > 0
				? await runShadowDecisions(
						extraction.facts,
						accessor,
						instrumentedProvider,
						decisionCfg,
						{
							agentId,
							scope: sourceScope,
							visibility: sourceVisibility,
						},
					)
				: { proposals: [], warnings: [] };

		const controlledWritesEnabled =
			pipelineCfg.enabled &&
			!pipelineCfg.shadowMode &&
			!pipelineCfg.mutationsFrozen &&
			!pipelineCfg.nativeShadowEnabled;

		// Convenience aliases for nested config
		const { extraction: extractionCfg, autonomous: autonomousCfg } = pipelineCfg;
		const writeGateCfg: WriteGateConfig = pipelineCfg.writeGate ?? {
			enabled: true,
			threshold: 0.4,
			continuityDiscount: 0.15,
		};

		const embeddingByHash = new Map<string, readonly number[]>();
		const prefetchWarnings: string[] = [];
		if (controlledWritesEnabled) {
			for (const proposal of decisions.proposals) {
				if (proposal.action !== "add" && proposal.action !== "update") continue;
				if (proposal.action === "update" && !autonomousCfg.allowUpdateDelete) continue;
				if (proposal.fact.confidence < extractionCfg.minConfidence) {
					continue;
				}

				const normalized = normalizeAndHashContent(proposal.fact.content);
				if (normalized.normalizedContent.length === 0) continue;

				const { contentHash, storageContent } = normalized;
				if (embeddingByHash.has(contentHash)) continue;

				try {
					const vector = await decisionCfg.fetchEmbedding(storageContent, decisionCfg.embedding);
					if (vector && vector.length > 0) {
						if (vector.length !== decisionCfg.embedding.dimensions) {
							prefetchWarnings.push(
								`Embedding dimension mismatch (got ${vector.length}, expected ${decisionCfg.embedding.dimensions})`,
							);
						} else {
							embeddingByHash.set(contentHash, vector);
						}
					}
				} catch (e) {
					const emsg = e instanceof Error ? e.message : String(e);
					prefetchWarnings.push(`Embedding prefetch failed: ${emsg}`);
					analytics?.recordError({
						timestamp: new Date().toISOString(),
						stage: "embedding",
						code: emsg.includes("timeout") ? "EMBEDDING_TIMEOUT" : "EMBEDDING_PROVIDER_DOWN",
						message: emsg,
						memoryId: job.memory_id,
					});
				}
			}
		}

		// --- Semantic contradiction check (pre-tx, async) ---
		const contradictionFlags = new Map<number, { detected: boolean; confidence: number; reasoning: string }>();
		if (controlledWritesEnabled && pipelineCfg.semanticContradictionEnabled && autonomousCfg.allowUpdateDelete) {
			for (let i = 0; i < decisions.proposals.length; i++) {
				const proposal = decisions.proposals[i];
				if (proposal.action !== "update" || !proposal.targetContent) continue;

				// Only run semantic check when syntactic check returned false
				// and there's enough lexical overlap to suggest related content.
				// Threshold >= 3 avoids the slow LLM path for loosely-related memories
				// (1-2 shared tokens are often stopword noise). Matches contradiction.ts.
				const factTokens = tokenize(proposal.fact.content);
				const targetTokens = tokenize(proposal.targetContent);
				const overlap = overlapCount(factTokens, targetTokens);

				if (overlap >= 3 && !detectContradictionRisk(proposal.fact.content, proposal.targetContent)) {
					try {
						const result = await detectSemanticContradiction(
							proposal.fact.content,
							proposal.targetContent,
							instrumentedProvider,
							pipelineCfg.semanticContradictionTimeoutMs,
						);
						if (result.detected && result.confidence >= 0.7) {
							contradictionFlags.set(i, result);
						}
					} catch (e) {
						const semMsg = e instanceof Error ? e.message : String(e);
						logger.warn("pipeline", "Semantic contradiction check failed, proceeding with update", {
							proposalIdx: i,
							error: semMsg,
						});
					}
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
						extractionModel: extractionCfg.model,
						embeddingModel: decisionCfg.embedding.model,
						factCount: extraction.facts.length,
						entityCount: extraction.entities.length,
						minFactConfidenceForWrite: extractionCfg.minConfidence,
						allowUpdateDelete: autonomousCfg.allowUpdateDelete,
						expectedEmbeddingDimensions: decisionCfg.embedding.dimensions,
						sourceAgentId: agentId,
						sourceProject,
						sourceScope,
						sourceVisibility,
						writeGate: writeGateCfg,
						semanticContradictions: contradictionFlags,
					},
					embeddingByHash,
				);
			} else {
				for (const proposal of decisions.proposals) {
					recordDecisionHistory(db, job.memory_id, proposal, {
						shadow: true,
						extractionModel: extractionCfg.model,
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
				warnings: [...extraction.warnings, ...decisions.warnings, ...prefetchWarnings],
			});

			completeJob(db, job.id, resultPayload);
			updateExtractionStatus(db, job.memory_id, "completed", extractionCfg.model);
		});

		if (controlledWritesEnabled && writeStats.writeGateConsidered > 0) {
			const blockRate = writeStats.writeGateBlocked / writeStats.writeGateConsidered;
			const payload = {
				jobId: job.id,
				memoryId: job.memory_id,
				sessionKey: sourceSessionKey,
				agentId,
				considered: writeStats.writeGateConsidered,
				passed: writeStats.writeGatePassed,
				blocked: writeStats.writeGateBlocked,
				bypassed: writeStats.writeGateBypassed,
				continuityDiscounted: writeStats.writeGateContinuityDiscounted,
				blockRate: Number(blockRate.toFixed(3)),
			};
			if (writeStats.writeGateConsidered < WRITE_GATE_ALERT_MIN_SAMPLES) {
				logger.info("pipeline", "Adaptive write gate ratio sample too small", payload);
			} else if (blockRate > 0.8 || blockRate < 0.2) {
				logger.warn("pipeline", "Adaptive write gate ratio outside expected band", payload);
			} else {
				logger.info("pipeline", "Adaptive write gate ratio", payload);
			}
		}

		// Persist graph entities in a separate transaction so failure
		// never reverts fact extraction. Non-fatal on error.
		let graphStats = {
			entitiesInserted: 0,
			entitiesUpdated: 0,
			relationsInserted: 0,
			relationsUpdated: 0,
			mentionsLinked: 0,
		};
		if (pipelineCfg.graph.enabled && extraction.entities.length > 0) {
			try {
				graphStats = accessor.withWriteTx((db) =>
					txPersistEntities(db, {
						entities: extraction.entities,
						sourceMemoryId: job.memory_id,
						extractedAt: new Date().toISOString(),
						agentId,
					}),
				);
				// New entities/relations invalidate traversal table cache
				invalidateTraversalCache();
			} catch (e) {
				logger.warn("pipeline", "Graph entity persistence failed (non-fatal)", {
					jobId: job.id,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Build broader structural facts from all sources:
		// newly written + deduped + "none" proposals resolved by hash + successful updates
		const structuralFacts: WrittenFact[] = [...writeStats.writtenFacts, ...writeStats.dedupedFacts];

		if (controlledWritesEnabled) {
			for (const proposal of decisions.proposals) {
				if (proposal.action !== "none") continue;
				const normalized = normalizeAndHashContent(proposal.fact.content);
				if (normalized.normalizedContent.length === 0) continue;
				const existing = accessor.withReadDb(
					(db) => {
						if (sourceScope !== null) {
							return db
								.prepare(
									`SELECT id FROM memories
							 WHERE content_hash = ?
							   AND is_deleted = 0
							   AND agent_id = ?
							   AND visibility = ?
							   AND scope = ?
							 LIMIT 1`,
								)
								.get(normalized.contentHash, agentId, sourceVisibility, sourceScope) as
								| { id: string }
								| undefined;
						}
						return db
							.prepare(
								`SELECT id FROM memories
							 WHERE content_hash = ?
							   AND is_deleted = 0
							   AND agent_id = ?
							   AND visibility = ?
							   AND scope IS NULL
							 LIMIT 1`,
							)
							.get(normalized.contentHash, agentId, sourceVisibility) as { id: string } | undefined;
					},
				);
				if (existing) {
					structuralFacts.push({
						memoryId: existing.id,
						content: normalized.storageContent,
						normalizedContent: normalized.normalizedContent,
						confidence: proposal.fact.confidence,
					});
				}
			}
			// Also collect successful updates
			for (const proposal of decisions.proposals) {
				if (proposal.action !== "update" || !proposal.targetMemoryId) continue;
				const normalized = normalizeAndHashContent(proposal.fact.content);
				if (normalized.normalizedContent.length === 0) continue;
				structuralFacts.push({
					memoryId: proposal.targetMemoryId,
					content: normalized.storageContent,
					normalizedContent: normalized.normalizedContent,
					confidence: proposal.fact.confidence,
				});
			}
		}

		// Pass 1: structural assignment — link written facts to entities,
		// create stub entity_attributes, enqueue classification jobs.
		// No LLM calls. Non-fatal on error.
		let structuralStats = { attributesCreated: 0, classifyEnqueued: 0, dependencyEnqueued: 0 };
		if (
			pipelineCfg.structural.enabled &&
			pipelineCfg.graph.enabled &&
			structuralFacts.length > 0 &&
			extraction.entities.length > 0
		) {
			try {
				structuralStats = runStructuralPass1(accessor, structuralFacts, extraction.entities);
			} catch (e) {
				logger.warn("pipeline", "Structural pass 1 failed (non-fatal)", {
					jobId: job.id,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		// Enqueue prospective indexing jobs for newly written facts.
		// Non-fatal: hint generation is async and can fail independently.
		let hintsEnqueued = 0;
		if (pipelineCfg.hints?.enabled && writeStats.writtenFacts.length > 0) {
			try {
				accessor.withWriteTx((db) => {
					for (const fact of writeStats.writtenFacts) {
						enqueueHintsJob(db, fact.memoryId, fact.content);
						hintsEnqueued++;
					}
				});
			} catch (e) {
				logger.warn("pipeline", "Hints job enqueueing failed (non-fatal)", {
					jobId: job.id,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		logger.info("pipeline", "Extraction job completed", {
			jobId: job.id,
			memoryId: job.memory_id,
			facts: extraction.facts.length,
			entities: extraction.entities.length,
			proposals: decisions.proposals.length,
			writeMode: controlledWritesEnabled ? "phase-c" : "shadow",
			added: writeStats.added,
			updated: writeStats.updated,
			deleted: writeStats.deleted,
			deduped: writeStats.deduped,
			skippedLowConfidence: writeStats.skippedLowConfidence,
			blockedDestructive: writeStats.blockedDestructive,
			entitiesInserted: graphStats.entitiesInserted,
			entitiesUpdated: graphStats.entitiesUpdated,
			relationsInserted: graphStats.relationsInserted,
			relationsUpdated: graphStats.relationsUpdated,
			mentionsLinked: graphStats.mentionsLinked,
			structuralAttributesCreated: structuralStats.attributesCreated,
			structuralClassifyEnqueued: structuralStats.classifyEnqueued,
			structuralDependencyEnqueued: structuralStats.dependencyEnqueued,
			hintsEnqueued,
		});
	}

	async function tick(): Promise<void> {
		if (!running) return;

		try {
			// Lease a job inside write tx
			const job = accessor.withWriteTx((db) => leaseJob(db, "extract", pipelineCfg.worker.maxRetries));

			if (!job) {
				consecutiveFailures = 0;
				return;
			}

			const jobStart = Date.now();
			try {
				await processExtractJob(job);
				consecutiveFailures = 0;
				lastAttempt = runtime.now();
				lastSuccess = runtime.now();
				processed++;
				analytics?.recordLatency("jobs", runtime.now() - jobStart);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				logger.warn("pipeline", "Job failed", {
					jobId: job.id,
					error: msg,
					attempt: job.attempts,
				});
				analytics?.recordLatency("jobs", runtime.now() - jobStart);
				analytics?.recordError({
					timestamp: new Date().toISOString(),
					stage: "extraction",
					code: msg.includes("timeout") ? "EXTRACTION_TIMEOUT" : "EXTRACTION_PARSE_FAIL",
					message: msg,
					memoryId: job.memory_id,
				});
				telemetry?.record("pipeline.error", {
					stage: "extraction",
					code: msg.includes("timeout") ? "EXTRACTION_TIMEOUT" : "EXTRACTION_PARSE_FAIL",
					durationMs: runtime.now() - jobStart,
				});
				accessor.withWriteTx((db) => {
					failJob(db, job.id, msg, job.attempts, job.max_attempts);
					if (job.attempts >= job.max_attempts) {
						updateExtractionStatus(db, job.memory_id, "failed", pipelineCfg.extraction.model);
					}
				});
				consecutiveFailures++;
				lastAttempt = runtime.now();
			}
		} catch (e) {
			logger.error("pipeline", "Worker tick error", e instanceof Error ? e : new Error(String(e)));
			consecutiveFailures++;
			lastAttempt = runtime.now();
		}
	}

	function getBackoffDelay(): number {
		if (consecutiveFailures === 0) return pipelineCfg.worker.pollMs;
		const exp = Math.min(BASE_DELAY * 2 ** consecutiveFailures, MAX_DELAY);
		return exp + Math.random() * JITTER;
	}

	// Use setTimeout chain instead of setInterval for backoff support
	function scheduleTick(): void {
		if (!running) return;
		const loadPerCpu = runtime.getLoadPerCpu();
		lastAttempt = runtime.now();
		lastLoadPerCpu = loadPerCpu;
		const overloadedNow =
			loadPerCpu !== null && Number.isFinite(loadPerCpu) && loadPerCpu > pipelineCfg.worker.maxLoadPerCpu;
		if (overloadedNow) {
			overloaded = true;
			overloadSinceEpochMs = overloadSinceEpochMs ?? runtime.now();
			const delay = pipelineCfg.worker.overloadBackoffMs;
			nextTickAtEpochMs = runtime.now() + delay;
			pollTimer = setTimeout(() => {
				scheduleTick();
			}, delay);
			return;
		}
		overloaded = false;
		overloadSinceEpochMs = null;
		const delay = getBackoffDelay();
		nextTickAtEpochMs = runtime.now() + delay;
		if (consecutiveFailures > 2) {
			logger.warn("pipeline", "Worker backing off", {
				failures: consecutiveFailures,
				delayMs: Math.round(delay),
			});
		}
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
			const reaped = reapStaleLeases(accessor, pipelineCfg.worker.leaseTimeoutMs);
			if (reaped.total > 0) {
				logger.info("pipeline", "Reaped stale leases", {
					count: reaped.total,
					pending: reaped.pending,
					dead: reaped.dead,
				});
			}
		} catch (e) {
			logger.warn("pipeline", "Lease reaper error", {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}, 60000);

	// Stall watchdog — detect when worker stops making progress.
	// Uses lastSuccess (not lastAttempt) so failure loops still trigger it.
	// Only counts jobs with attempts < maxRetries to match leaseJob() eligibility,
	// so exhausted jobs do not cause spurious stall resets.
	watchdog = setInterval(() => {
		if (!running) return;
		// Intentional load-shedding is not a stall.
		if (overloaded) return;
		if (runtime.now() - lastSuccess < STALL_THRESHOLD) return;

		let pending = 0;
		try {
			const row = accessor.withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT COUNT(*) as cnt FROM memory_jobs WHERE job_type = 'extract' AND status = 'pending' AND attempts < ?",
						)
						.get(pipelineCfg.worker.maxRetries) as { cnt: number },
			);
			pending = row.cnt;
		} catch {
			return;
		}
		if (pending === 0) return;

		logger.warn("pipeline", "Worker stall detected, resetting backoff", {
			pending,
			failures: consecutiveFailures,
			stalledMs: runtime.now() - lastSuccess,
		});

		consecutiveFailures = 0;
		lastSuccess = runtime.now();
		// If a tick is already running, just reset backoff — the
		// in-progress tick will call scheduleTick() on completion.
		if (inflight) return;
		if (pollTimer) clearTimeout(pollTimer);
		// Re-enter normal scheduling so overload checks still apply.
		scheduleTick();
	}, WATCHDOG_INTERVAL);

	// Startup recovery: mark memory_jobs that are pending but have exhausted
	// their effective retry limit as dead. The effective limit is the lesser of
	// the stored max_attempts column and the current runtime maxRetries value,
	// so jobs are also recovered when the operator lowers maxRetries after rows
	// were inserted with a higher max_attempts value. These jobs are silently
	// skipped by the tick loop (requires attempts < maxRetries) and cause the
	// stall detector to fire every interval without this cleanup step.
	try {
		const { updated } = recoverMemoryJobs(accessor, pipelineCfg.worker.maxRetries);
		if (updated > 0) logger.info("pipeline", `Startup recovery: marked ${updated} exhausted pending job(s) as dead`);
	} catch (e) {
		logger.warn("pipeline", "Startup recovery failed (non-fatal)", {
			error: e instanceof Error ? e.message : String(e),
		});
	}

	// Start the tick loop
	scheduleTick();
	logger.info("pipeline", "Worker started", {
		pollMs: pipelineCfg.worker.pollMs,
		maxRetries: pipelineCfg.worker.maxRetries,
		model: pipelineCfg.extraction.model,
		mode:
			pipelineCfg.enabled &&
			!pipelineCfg.shadowMode &&
			!pipelineCfg.mutationsFrozen &&
			!pipelineCfg.nativeShadowEnabled
				? "controlled-write"
				: "shadow",
	});

	function pendingCount(): number {
		try {
			const row = accessor.withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT COUNT(*) as cnt FROM memory_jobs WHERE job_type = 'extract' AND status = 'pending' AND attempts < ?",
						)
						.get(pipelineCfg.worker.maxRetries) as { cnt: number },
			);
			return row.cnt;
		} catch {
			return 0;
		}
	}

	return {
		get running() {
			return running;
		},
		nudge() {
			consecutiveFailures = 0;
			// If a tick is already running, just reset backoff — the
			// in-progress tick will call scheduleTick() on completion
			// with the now-zeroed failure count.
			if (inflight) return;
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = setTimeout(async () => {
				inflight = tick();
				await inflight;
				inflight = null;
				scheduleTick();
			}, 0);
		},
		get stats(): WorkerStats {
			return {
				failures: consecutiveFailures,
				lastProgressAt: lastSuccess,
				pending: pendingCount(),
				processed,
				backoffMs: getBackoffDelay(),
				overloaded,
				loadPerCpu: lastLoadPerCpu,
				maxLoadPerCpu: pipelineCfg.worker.maxLoadPerCpu,
				overloadBackoffMs: pipelineCfg.worker.overloadBackoffMs,
				overloadSince: overloadSinceEpochMs === null ? null : new Date(overloadSinceEpochMs).toISOString(),
				nextTickInMs: Math.max(0, nextTickAtEpochMs - runtime.now()),
			};
		},
		async stop() {
			running = false;
			if (pollTimer) clearTimeout(pollTimer);
			if (reapTimer) clearInterval(reapTimer);
			if (watchdog) clearInterval(watchdog);
			if (inflight) await inflight;
			logger.info("pipeline", "Worker stopped");
		},
	};
}

/**
 * Predictor Training Pairs
 *
 * Collects anonymized feature vectors and ground-truth labels from
 * session-end processing. These pairs feed local training of the
 * predictive memory scorer and can eventually be exported for
 * federated community model training.
 *
 * Privacy invariant: NO memory content is ever stored or exported.
 * Only structural features (recency, importance, access patterns)
 * and numerical labels (relevance scores).
 */

import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureVector {
	readonly recencyDays: number;
	readonly accessCount: number;
	readonly importance: number;
	readonly decayFactor: number;
	readonly embeddingSimilarity: number | null;
	readonly entitySlot: number | null;
	readonly aspectSlot: number | null;
	readonly isConstraint: boolean;
	readonly structuralDensity: number | null;
	readonly ftsHitCount: number;
}

export interface CombinedLabel {
	readonly agentRelevanceScore: number | null;
	readonly continuityScore: number | null;
	readonly ftsOverlapScore: number | null;
	readonly combined: number;
}

export interface TrainingPair {
	readonly memoryId: string;
	readonly features: FeatureVector;
	readonly label: CombinedLabel;
	readonly wasInjected: boolean;
	readonly predictorRank: number | null;
	readonly baselineRank: number | null;
}

export interface ExportOptions {
	readonly since?: string;
	readonly limit?: number;
	readonly offset?: number;
}

export interface ExportedTrainingPair {
	readonly id: string;
	readonly agentId: string;
	readonly sessionKey: string;
	readonly memoryId: string;
	readonly features: FeatureVector;
	readonly label: CombinedLabel;
	readonly wasInjected: boolean;
	readonly predictorRank: number | null;
	readonly baselineRank: number | null;
	readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Label computation
// ---------------------------------------------------------------------------

/**
 * Compute FTS adjustment from hit count.
 * Caps at 1.0, scales linearly at 0.3 per hit.
 */
function ftsAdjustment(ftsHitCount: number): number {
	if (ftsHitCount <= 0) return 0;
	return Math.min(1.0, ftsHitCount * 0.3);
}

/**
 * Compute combined label from available signal sources.
 *
 * When agent relevance is available (primary signal):
 *   combined = agent * 0.7 + fts * 0.2 + continuity * 0.1
 *
 * Fallback (no agent feedback):
 *   combined = continuity * 0.8 + fts * 0.2
 */
export function computeCombinedLabel(
	agentRelevanceScore: number | null,
	continuityScore: number | null,
	ftsHitCount: number,
): CombinedLabel {
	const ftsAdj = ftsAdjustment(ftsHitCount);
	const ftsOverlap = ftsAdj;
	// Normalize continuity to [0, 1]
	const continuityNormalized = continuityScore !== null ? Math.max(0, Math.min(1, continuityScore)) : null;

	let combined: number;
	if (agentRelevanceScore !== null) {
		// Spec allows negative labels (e.g. -0.3 for superseded memories)
		const agentClamped = Math.max(-1, Math.min(1, agentRelevanceScore));
		const continuityMod = continuityNormalized ?? 0;
		combined = agentClamped * 0.7 + ftsAdj * 0.2 + continuityMod * 0.1;
	} else {
		const contScore = continuityNormalized ?? 0;
		combined = contScore * 0.8 + ftsAdj * 0.2;
	}

	return {
		agentRelevanceScore,
		continuityScore: continuityNormalized,
		ftsOverlapScore: ftsOverlap,
		combined: Math.max(-1, Math.min(1, combined)),
	};
}

// ---------------------------------------------------------------------------
// Decay factor computation
// ---------------------------------------------------------------------------

/**
 * Simple exponential decay factor based on age.
 * Half-life of 30 days by default.
 */
function computeDecayFactor(recencyDays: number): number {
	const halfLifeDays = 30;
	return Math.exp((-Math.LN2 * recencyDays) / halfLifeDays);
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

interface SessionMemoryRow {
	readonly memory_id: string;
	readonly effective_score: number | null;
	readonly predictor_score: number | null;
	readonly rank: number;
	readonly was_injected: number;
	readonly relevance_score: number | null;
	readonly fts_hit_count: number;
	readonly source: string;
	readonly predictor_rank: number | null;
	readonly agent_relevance_score: number | null;
}

interface MemoryRow {
	readonly id: string;
	readonly importance: number | null;
	readonly access_count: number | null;
	readonly created_at: string;
}

interface EntityMentionRow {
	readonly entity_id: string;
}

/**
 * Collect training pairs from session_memories + memories tables.
 * Builds feature vectors and labels for each memory candidate
 * that was tracked during the session.
 */
export function collectTrainingPairs(
	accessor: DbAccessor,
	sessionKey: string,
	agentId: string,
): ReadonlyArray<TrainingPair> {
	try {
		return accessor.withReadDb((db) => {
			return collectTrainingPairsFromDb(db, sessionKey, agentId);
		});
	} catch (e) {
		logger.warn("training-pairs", "Failed to collect training pairs", {
			error: e instanceof Error ? e.message : String(e),
			sessionKey,
		});
		return [];
	}
}

function collectTrainingPairsFromDb(db: ReadDb, sessionKey: string, agentId: string): ReadonlyArray<TrainingPair> {
	// Load session memories for this session
	const sessionMemories = db
		.prepare(
			`SELECT memory_id, effective_score, predictor_score, rank,
			        was_injected, relevance_score, fts_hit_count, source, predictor_rank,
			        agent_relevance_score
			 FROM session_memories
			 WHERE session_key = ?
			   AND agent_id = ?
			 ORDER BY rank ASC`,
		)
		.all(sessionKey, agentId) as ReadonlyArray<SessionMemoryRow>;

	if (sessionMemories.length === 0) return [];

	const memoryIds = sessionMemories.map((sm) => sm.memory_id);
	const placeholders = memoryIds.map(() => "?").join(", ");

	// Load memory metadata
	const memoryRows = db
		.prepare(
			`SELECT id, importance, access_count, created_at
			 FROM memories
			 WHERE id IN (${placeholders})`,
		)
		.all(...memoryIds) as ReadonlyArray<MemoryRow>;

	const memoryMap = new Map<string, MemoryRow>();
	for (const row of memoryRows) {
		memoryMap.set(row.id, row);
	}

	// Load entity mention counts per memory (structural density)
	const entityCounts = new Map<string, number>();
	try {
		const mentionRows = db
			.prepare(
				`SELECT memory_id, COUNT(*) as cnt
				 FROM memory_entity_mentions
				 WHERE memory_id IN (${placeholders})
				 GROUP BY memory_id`,
			)
			.all(...memoryIds) as ReadonlyArray<{
			memory_id: string;
			cnt: number;
		}>;
		for (const row of mentionRows) {
			entityCounts.set(row.memory_id, row.cnt);
		}
	} catch {
		// Graph tables may not exist -- non-fatal
	}

	// Load entity slot info (whether the memory has entity mentions)
	const entitySlots = new Map<string, number>();
	try {
		const entityRows = db
			.prepare(
				`SELECT DISTINCT memory_id, entity_id
				 FROM memory_entity_mentions
				 WHERE memory_id IN (${placeholders})`,
			)
			.all(...memoryIds) as ReadonlyArray<EntityMentionRow & { memory_id: string }>;
		const entityPerMemory = new Map<string, Set<string>>();
		for (const row of entityRows) {
			const set = entityPerMemory.get(row.memory_id) ?? new Set();
			set.add(row.entity_id);
			entityPerMemory.set(row.memory_id, set);
		}
		for (const [memId, entities] of entityPerMemory) {
			entitySlots.set(memId, entities.size);
		}
	} catch {
		// Non-fatal
	}

	// Get session continuity score if available
	let sessionContinuityScore: number | null = null;
	try {
		let scoreRow: { score: number } | undefined;
		try {
			scoreRow = db
				.prepare(
					`SELECT score FROM session_scores
					 WHERE session_key = ? AND agent_id = ?
					 ORDER BY created_at DESC LIMIT 1`,
				)
				.get(sessionKey, agentId) as { score: number } | undefined;
		} catch {
			scoreRow = db
				.prepare(
					`SELECT score FROM session_scores
					 WHERE session_key = ?
					 ORDER BY created_at DESC LIMIT 1`,
				)
				.get(sessionKey) as { score: number } | undefined;
		}
		if (scoreRow) {
			sessionContinuityScore = scoreRow.score;
		}
	} catch {
		// Non-fatal
	}

	const now = Date.now();
	const pairs: TrainingPair[] = [];

	for (const sm of sessionMemories) {
		const mem = memoryMap.get(sm.memory_id);
		if (!mem) continue;

		const createdMs = new Date(mem.created_at).getTime();
		const recencyDays = Math.max(0, (now - createdMs) / (1000 * 60 * 60 * 24));
		const importance = mem.importance ?? 0.5;
		const accessCount = mem.access_count ?? 0;
		const decayFactor = computeDecayFactor(recencyDays);
		const entitySlot = entitySlots.get(sm.memory_id) ?? null;
		const structuralDensity = entityCounts.get(sm.memory_id) ?? null;

		// Use inline agent feedback (running mean from per-prompt scoring) as primary signal
		const agentRelevance = sm.agent_relevance_score;
		// Use LLM continuity score or session-level fallback
		const continuity = sm.relevance_score ?? sessionContinuityScore;

		const label = computeCombinedLabel(agentRelevance, continuity, sm.fts_hit_count);

		const features: FeatureVector = {
			recencyDays,
			accessCount,
			importance,
			decayFactor,
			embeddingSimilarity: sm.effective_score,
			entitySlot,
			aspectSlot: null, // Aspect slots not yet tracked in schema
			isConstraint: false, // Constraint flag not yet tracked
			structuralDensity,
			ftsHitCount: sm.fts_hit_count,
		};

		pairs.push({
			memoryId: sm.memory_id,
			features,
			label,
			wasInjected: sm.was_injected === 1,
			predictorRank: sm.predictor_rank ?? null,
			baselineRank: sm.predictor_score === null ? sm.rank : null,
		});
	}

	return pairs;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Batch-insert training pairs into predictor_training_pairs.
 * Uses a single transaction for efficiency.
 */
export function saveTrainingPairs(
	accessor: DbAccessor,
	agentId: string,
	sessionKey: string,
	pairs: ReadonlyArray<TrainingPair>,
): number {
	if (pairs.length === 0) return 0;

	try {
		return accessor.withWriteTx((db) => {
			return saveTrainingPairsTx(db, agentId, sessionKey, pairs);
		});
	} catch (e) {
		logger.warn("training-pairs", "Failed to save training pairs", {
			error: e instanceof Error ? e.message : String(e),
			sessionKey,
			count: pairs.length,
		});
		return 0;
	}
}

function saveTrainingPairsTx(
	db: WriteDb,
	agentId: string,
	sessionKey: string,
	pairs: ReadonlyArray<TrainingPair>,
): number {
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO predictor_training_pairs
		 (id, agent_id, session_key, memory_id,
		  recency_days, access_count, importance, decay_factor,
		  embedding_similarity, entity_slot, aspect_slot,
		  is_constraint, structural_density, fts_hit_count,
		  agent_relevance_score, continuity_score, fts_overlap_score,
		  combined_label, was_injected, predictor_rank, baseline_rank,
		  created_at)
		 VALUES (?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?)`,
	);

	const now = new Date().toISOString();
	let saved = 0;

	for (const pair of pairs) {
		const id = crypto.randomUUID();
		stmt.run(
			id,
			agentId,
			sessionKey,
			pair.memoryId,
			pair.features.recencyDays,
			pair.features.accessCount,
			pair.features.importance,
			pair.features.decayFactor,
			pair.features.embeddingSimilarity,
			pair.features.entitySlot,
			pair.features.aspectSlot,
			pair.features.isConstraint ? 1 : 0,
			pair.features.structuralDensity,
			pair.features.ftsHitCount,
			pair.label.agentRelevanceScore,
			pair.label.continuityScore,
			pair.label.ftsOverlapScore,
			pair.label.combined,
			pair.wasInjected ? 1 : 0,
			pair.predictorRank,
			pair.baselineRank,
			now,
		);
		saved++;
	}

	logger.info("training-pairs", "Saved training pairs", {
		agentId,
		sessionKey,
		count: saved,
	});

	return saved;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Read training pairs for export. Returns anonymized feature vectors
 * and labels -- never memory content.
 */
export function exportTrainingPairs(
	accessor: DbAccessor,
	agentId: string,
	options: ExportOptions = {},
): ReadonlyArray<ExportedTrainingPair> {
	const limit = Math.min(options.limit ?? 1000, 10000);
	const offset = options.offset ?? 0;

	return accessor.withReadDb((db) => {
		const conditions: string[] = ["agent_id = ?"];
		const params: unknown[] = [agentId];

		if (options.since) {
			conditions.push("created_at >= ?");
			params.push(options.since);
		}

		const where = conditions.join(" AND ");

		const rows = db
			.prepare(
				`SELECT id, agent_id, session_key, memory_id,
				        recency_days, access_count, importance, decay_factor,
				        embedding_similarity, entity_slot, aspect_slot,
				        is_constraint, structural_density, fts_hit_count,
				        agent_relevance_score, continuity_score, fts_overlap_score,
				        combined_label, was_injected, predictor_rank, baseline_rank,
				        created_at
				 FROM predictor_training_pairs
				 WHERE ${where}
				 ORDER BY created_at ASC
				 LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as ReadonlyArray<TrainingPairRow>;

		return rows.map(rowToExported);
	});
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Purge training pairs older than the retention period (default 90 days).
 * Returns the number of rows deleted.
 */
export function purgeOldTrainingPairs(accessor: DbAccessor, retentionDays = 90): number {
	try {
		return accessor.withWriteTx((db) => {
			const result = db
				.prepare(
					`DELETE FROM predictor_training_pairs
					 WHERE created_at < datetime('now', ? || ' days')`,
				)
				.run(`-${retentionDays}`);

			// bun:sqlite .run() returns the statement; use changes property
			const changes =
				typeof result === "object" && result !== null ? ((result as { changes?: number }).changes ?? 0) : 0;

			if (changes > 0) {
				logger.info("training-pairs", "Purged old training pairs", {
					deleted: changes,
					retentionDays,
				});
			}

			return changes;
		});
	} catch (e) {
		logger.warn("training-pairs", "Failed to purge training pairs", {
			error: e instanceof Error ? e.message : String(e),
		});
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TrainingPairRow {
	readonly id: string;
	readonly agent_id: string;
	readonly session_key: string;
	readonly memory_id: string;
	readonly recency_days: number;
	readonly access_count: number;
	readonly importance: number;
	readonly decay_factor: number;
	readonly embedding_similarity: number | null;
	readonly entity_slot: number | null;
	readonly aspect_slot: number | null;
	readonly is_constraint: number;
	readonly structural_density: number | null;
	readonly fts_hit_count: number;
	readonly agent_relevance_score: number | null;
	readonly continuity_score: number | null;
	readonly fts_overlap_score: number | null;
	readonly combined_label: number;
	readonly was_injected: number;
	readonly predictor_rank: number | null;
	readonly baseline_rank: number | null;
	readonly created_at: string;
}

function rowToExported(row: TrainingPairRow): ExportedTrainingPair {
	return {
		id: row.id,
		agentId: row.agent_id,
		sessionKey: row.session_key,
		memoryId: row.memory_id,
		features: {
			recencyDays: row.recency_days,
			accessCount: row.access_count,
			importance: row.importance,
			decayFactor: row.decay_factor,
			embeddingSimilarity: row.embedding_similarity,
			entitySlot: row.entity_slot,
			aspectSlot: row.aspect_slot,
			isConstraint: row.is_constraint === 1,
			structuralDensity: row.structural_density,
			ftsHitCount: row.fts_hit_count,
		},
		label: {
			agentRelevanceScore: row.agent_relevance_score,
			continuityScore: row.continuity_score,
			ftsOverlapScore: row.fts_overlap_score,
			combined: row.combined_label,
		},
		wasInjected: row.was_injected === 1,
		predictorRank: row.predictor_rank,
		baselineRank: row.baseline_rank,
		createdAt: row.created_at,
	};
}

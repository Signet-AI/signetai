import { cosineSimilarity } from "@signet/core";
import type { ReadDb } from "../db-accessor";
import { isDecisionContent } from "../inline-entity-linker";

const CONSTRAINT_KEYWORDS = ["constraint", "must", "never", "always", "required"] as const;
const ERROR_KEYWORDS = ["error", "exception", "failed", "failure", "stack trace", "traceback", "crash", "bug"] as const;

const CONTINUITY_WINDOW_MS = 30 * 60 * 1000;
const CONTINUITY_RECENT_MIN = 3;
const CONTINUITY_SIMILARITY_THRESHOLD = 0.65;
const NEIGHBOR_LIMIT = 50;
const RECENT_SIMILARITY_LIMIT = 5;

export interface WriteGateConfig {
	readonly enabled: boolean;
	readonly threshold: number;
	readonly continuityDiscount: number;
}

export interface WriteGateInput {
	readonly agentId: string;
	readonly sourceMemoryId: string;
	readonly sourceProject: string | null;
	readonly factType: string;
	readonly content: string;
	readonly vector: readonly number[] | null;
}

export interface WriteGateSignals {
	readonly sameDirectory: boolean;
	readonly recentStores: boolean;
	readonly semanticSimilarity: boolean;
}

export interface WriteGateResult {
	readonly pass: boolean;
	readonly bypassed: boolean;
	readonly reason:
		| "gate_disabled"
		| "decision_bypass"
		| "constraint_bypass"
		| "error_bypass"
		| "missing_embedding"
		| "low_surprisal"
		| "passed";
	readonly surprise: number | null;
	readonly maxSimilarity: number | null;
	readonly threshold: number;
	readonly continuityApplied: boolean;
	readonly signals: WriteGateSignals;
}

function clampUnit(v: number): number {
	return Math.max(0, Math.min(1, v));
}

function toF32(buf: Buffer): Float32Array {
	return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function isConstraintContent(content: string): boolean {
	const lower = content.toLowerCase();
	return CONSTRAINT_KEYWORDS.some((k) => lower.includes(k));
}

function isErrorContent(content: string): boolean {
	const lower = content.toLowerCase();
	return ERROR_KEYWORDS.some((k) => lower.includes(k));
}

function findMaxSimilarityVec(db: ReadDb, query: Float32Array, input: WriteGateInput): number | null {
	const scoped = input.sourceProject !== null;
	const sql = scoped
		? `SELECT v.distance
		   FROM vec_embeddings v
		   JOIN embeddings e ON v.id = e.id
		   JOIN memories m ON e.source_id = m.id
		   WHERE v.embedding MATCH ? AND k = ?
		     AND e.source_type = 'memory'
		     AND m.is_deleted = 0
		     AND m.agent_id = ?
		     AND m.id <> ?
		     AND m.project = ?
		   ORDER BY v.distance
		   LIMIT 1`
		: `SELECT v.distance
		   FROM vec_embeddings v
		   JOIN embeddings e ON v.id = e.id
		   JOIN memories m ON e.source_id = m.id
		   WHERE v.embedding MATCH ? AND k = ?
		     AND e.source_type = 'memory'
		     AND m.is_deleted = 0
		     AND m.agent_id = ?
		     AND m.id <> ?
		   ORDER BY v.distance
		   LIMIT 1`;

	const row = scoped
		? (db.prepare(sql).get(query, NEIGHBOR_LIMIT, input.agentId, input.sourceMemoryId, input.sourceProject) as
				| { distance: number }
				| undefined)
		: (db.prepare(sql).get(query, NEIGHBOR_LIMIT, input.agentId, input.sourceMemoryId) as
				| { distance: number }
				| undefined);
	if (!row || !Number.isFinite(row.distance)) return null;
	return clampUnit(1 - row.distance);
}

function findMaxSimilarityFallback(db: ReadDb, query: Float32Array, input: WriteGateInput): number | null {
	const scoped = input.sourceProject !== null;
	const sql = scoped
		? `SELECT e.vector
		   FROM embeddings e
		   JOIN memories m ON e.source_id = m.id
		   WHERE e.source_type = 'memory'
		     AND m.is_deleted = 0
		     AND m.agent_id = ?
		     AND m.id <> ?
		     AND m.project = ?
		   ORDER BY m.updated_at DESC
		   LIMIT ?`
		: `SELECT e.vector
		   FROM embeddings e
		   JOIN memories m ON e.source_id = m.id
		   WHERE e.source_type = 'memory'
		     AND m.is_deleted = 0
		     AND m.agent_id = ?
		     AND m.id <> ?
		   ORDER BY m.updated_at DESC
		   LIMIT ?`;

	const rows = scoped
		? (db.prepare(sql).all(input.agentId, input.sourceMemoryId, input.sourceProject, NEIGHBOR_LIMIT) as ReadonlyArray<{
				vector: Buffer;
			}>)
		: (db.prepare(sql).all(input.agentId, input.sourceMemoryId, NEIGHBOR_LIMIT) as ReadonlyArray<{ vector: Buffer }>);

	if (rows.length === 0) return null;
	let max = 0;
	for (const row of rows) {
		const score = clampUnit(cosineSimilarity(query, toF32(row.vector)));
		if (score > max) max = score;
	}
	return max;
}

function findMaxSimilarity(db: ReadDb, query: Float32Array, input: WriteGateInput): number | null {
	try {
		const top = findMaxSimilarityVec(db, query, input);
		if (top !== null) return top;
	} catch {
		// vec path unavailable, fall back to dense scan of recent scoped rows
	}
	return findMaxSimilarityFallback(db, query, input);
}

function computeContinuitySignals(db: ReadDb, input: WriteGateInput, query: Float32Array | null): WriteGateSignals {
	const cutoff = new Date(Date.now() - CONTINUITY_WINDOW_MS).toISOString();

	const sameDirectory = (() => {
		if (!input.sourceProject) return false;
		const row = db
			.prepare(
				`SELECT COUNT(*) AS cnt
				 FROM memories
				 WHERE agent_id = ?
				   AND id <> ?
				   AND project = ?
				   AND is_deleted = 0
				   AND created_at >= ?`,
			)
			.get(input.agentId, input.sourceMemoryId, input.sourceProject, cutoff) as { cnt: number } | undefined;
		return (row?.cnt ?? 0) > 0;
	})();

	const recentStores = (() => {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS cnt
				 FROM memories
				 WHERE agent_id = ?
				   AND id <> ?
				   AND is_deleted = 0
				   AND created_at >= ?`,
			)
			.get(input.agentId, input.sourceMemoryId, cutoff) as { cnt: number } | undefined;
		return (row?.cnt ?? 0) >= CONTINUITY_RECENT_MIN;
	})();

	const semanticSimilarity = (() => {
		if (!query) return false;
		const scoped = input.sourceProject !== null;
		const sql = scoped
			? `SELECT e.vector
			   FROM embeddings e
			   JOIN memories m ON e.source_id = m.id
			   WHERE e.source_type = 'memory'
			     AND m.agent_id = ?
			     AND m.id <> ?
			     AND m.is_deleted = 0
			     AND m.project = ?
			   ORDER BY m.created_at DESC
			   LIMIT ?`
			: `SELECT e.vector
			   FROM embeddings e
			   JOIN memories m ON e.source_id = m.id
			   WHERE e.source_type = 'memory'
			     AND m.agent_id = ?
			     AND m.id <> ?
			     AND m.is_deleted = 0
			   ORDER BY m.created_at DESC
			   LIMIT ?`;

		const rows = scoped
			? (db
					.prepare(sql)
					.all(input.agentId, input.sourceMemoryId, input.sourceProject, RECENT_SIMILARITY_LIMIT) as ReadonlyArray<{
					vector: Buffer;
				}>)
			: (db.prepare(sql).all(input.agentId, input.sourceMemoryId, RECENT_SIMILARITY_LIMIT) as ReadonlyArray<{
					vector: Buffer;
				}>);
		if (rows.length === 0) return false;

		let max = 0;
		for (const row of rows) {
			const score = clampUnit(cosineSimilarity(query, toF32(row.vector)));
			if (score > max) max = score;
		}
		return max >= CONTINUITY_SIMILARITY_THRESHOLD;
	})();

	return {
		sameDirectory,
		recentStores,
		semanticSimilarity,
	};
}

export function assessWriteGate(db: ReadDb, cfg: WriteGateConfig, input: WriteGateInput): WriteGateResult {
	const baseThreshold = clampUnit(cfg.threshold);
	if (!cfg.enabled) {
		return {
			pass: true,
			bypassed: true,
			reason: "gate_disabled",
			surprise: null,
			maxSimilarity: null,
			threshold: baseThreshold,
			continuityApplied: false,
			signals: { sameDirectory: false, recentStores: false, semanticSimilarity: false },
		};
	}

	if (input.factType === "decision" || isDecisionContent(input.content)) {
		return {
			pass: true,
			bypassed: true,
			reason: "decision_bypass",
			surprise: null,
			maxSimilarity: null,
			threshold: baseThreshold,
			continuityApplied: false,
			signals: { sameDirectory: false, recentStores: false, semanticSimilarity: false },
		};
	}

	if (isConstraintContent(input.content)) {
		return {
			pass: true,
			bypassed: true,
			reason: "constraint_bypass",
			surprise: null,
			maxSimilarity: null,
			threshold: baseThreshold,
			continuityApplied: false,
			signals: { sameDirectory: false, recentStores: false, semanticSimilarity: false },
		};
	}

	if (isErrorContent(input.content)) {
		return {
			pass: true,
			bypassed: true,
			reason: "error_bypass",
			surprise: null,
			maxSimilarity: null,
			threshold: baseThreshold,
			continuityApplied: false,
			signals: { sameDirectory: false, recentStores: false, semanticSimilarity: false },
		};
	}

	if (!input.vector || input.vector.length === 0) {
		return {
			pass: true,
			bypassed: true,
			reason: "missing_embedding",
			surprise: null,
			maxSimilarity: null,
			threshold: baseThreshold,
			continuityApplied: false,
			signals: { sameDirectory: false, recentStores: false, semanticSimilarity: false },
		};
	}

	const query = new Float32Array(input.vector);
	const signals = computeContinuitySignals(db, input, query);
	const continuityApplied = signals.sameDirectory && signals.recentStores && signals.semanticSimilarity;
	const effectiveThreshold = clampUnit(baseThreshold - (continuityApplied ? clampUnit(cfg.continuityDiscount) : 0));
	const maxSimilarity = findMaxSimilarity(db, query, input);
	const surprise = clampUnit(1 - (maxSimilarity ?? 0));
	if (surprise < effectiveThreshold) {
		return {
			pass: false,
			bypassed: false,
			reason: "low_surprisal",
			surprise,
			maxSimilarity,
			threshold: effectiveThreshold,
			continuityApplied,
			signals,
		};
	}

	return {
		pass: true,
		bypassed: false,
		reason: "passed",
		surprise,
		maxSimilarity,
		threshold: effectiveThreshold,
		continuityApplied,
		signals,
	};
}

import { createHash } from "node:crypto";
import type { DependencyType } from "@signet/core";
import type { DbAccessor, WriteDb } from "./db-accessor";
import { recordAgentFeedbackInner } from "./session-memories";

export interface FeedbackPath {
	readonly entityIds: ReadonlyArray<string>;
	readonly aspectIds: ReadonlyArray<string>;
	readonly dependencyIds: ReadonlyArray<string>;
}

export interface FeedbackReward {
	readonly forwardCitation: number;
	readonly updateAfterRetrieval: number;
	readonly downstreamCreation: number;
	readonly deadEnd: number;
}

export interface PathFeedbackResult {
	readonly accepted: number;
	readonly propagated: number;
	readonly cooccurrenceUpdated: number;
	readonly dependenciesUpdated: number;
}

interface PathFeedbackConfig {
	readonly aspectDelta: number;
	readonly edgeDelta: number;
	readonly confidenceDelta: number;
	readonly qAlpha: number;
	readonly minEdgeStrength: number;
	readonly minConfidence: number;
	readonly npmiThreshold: number;
	readonly minCoSessions: number;
	readonly autoEdgeCap: number;
	readonly maxAspectWeight: number;
	readonly minAspectWeight: number;
}

const DEFAULT_CFG: PathFeedbackConfig = {
	aspectDelta: 0.02,
	edgeDelta: 0.04,
	confidenceDelta: 0.05,
	qAlpha: 0.1,
	minEdgeStrength: 0.1,
	minConfidence: 0.2,
	npmiThreshold: 0.15,
	minCoSessions: 3,
	autoEdgeCap: 20,
	maxAspectWeight: 1,
	minAspectWeight: 0.1,
};

function toRecord(raw: unknown): Record<string, unknown> | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	return raw as Record<string, unknown>;
}

function toUniqueIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizePath(raw: unknown): FeedbackPath | null {
	const rec = toRecord(raw);
	if (!rec) return null;
	const entityIds = toUniqueIds(rec.entity_ids ?? rec.entityIds);
	const aspectIds = toUniqueIds(rec.aspect_ids ?? rec.aspectIds);
	const dependencyIds = toUniqueIds(rec.dependency_ids ?? rec.dependencyIds);
	if (entityIds.length === 0 && aspectIds.length === 0 && dependencyIds.length === 0) return null;
	return { entityIds, aspectIds, dependencyIds };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function toFraction(raw: unknown): number {
	if (typeof raw === "boolean") return raw ? 1 : 0;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
	return clamp(raw, 0, 1);
}

function normalizeReward(raw: unknown): FeedbackReward {
	const rec = toRecord(raw);
	if (!rec) {
		return {
			forwardCitation: 0,
			updateAfterRetrieval: 0,
			downstreamCreation: 0,
			deadEnd: 0,
		};
	}
	return {
		forwardCitation: toFraction(rec.forward_citation ?? rec.forwardCitation),
		updateAfterRetrieval: toFraction(rec.update_after_retrieval ?? rec.updateAfterRetrieval),
		downstreamCreation: toFraction(rec.downstream_creation ?? rec.downstreamCreation),
		deadEnd: toFraction(rec.dead_end ?? rec.deadEnd),
	};
}

function rewardScore(reward: FeedbackReward): number {
	return (
		reward.forwardCitation * 1.0 +
		reward.updateAfterRetrieval * 0.5 +
		reward.downstreamCreation * 0.6 -
		reward.deadEnd * 0.15
	);
}

function pathHash(path: FeedbackPath): string {
	const digest = createHash("sha1");
	digest.update(
		JSON.stringify({
			entity_ids: path.entityIds,
			aspect_ids: path.aspectIds,
			dependency_ids: path.dependencyIds,
		}),
	);
	return digest.digest("hex");
}

function reasonConfidence(reason: string | null): number {
	if (reason === "user-asserted") return 1.0;
	if (reason === "multi-memory") return 0.9;
	if (reason === "single-memory") return 0.7;
	if (reason === "pattern-matched") return 0.5;
	if (reason === "inferred") return 0.4;
	if (reason === "llm-uncertain") return 0.3;
	return 0.7;
}

function nextReason(reason: string | null, rating: number): string | null {
	if (rating > 0) {
		if (reason === null) return "single-memory";
		if (reason === "llm-uncertain") return "single-memory";
		if (reason === "single-memory") return "pattern-matched";
		if (reason === "pattern-matched") return "multi-memory";
		return reason;
	}
	if (rating < 0) {
		if (reason === null) return "llm-uncertain";
		if (reason === "multi-memory") return "pattern-matched";
		if (reason === "pattern-matched") return "single-memory";
		if (reason === "single-memory") return "llm-uncertain";
		return reason;
	}
	return reason;
}

function inferPath(db: WriteDb, memoryId: string, agentId: string): FeedbackPath | null {
	const rows = db
		.prepare(
			`SELECT asp.entity_id, ea.aspect_id
			 FROM entity_attributes ea
			 JOIN entity_aspects asp ON asp.id = ea.aspect_id
			 WHERE ea.memory_id = ?
			   AND ea.agent_id = ?
			   AND ea.status = 'active'
			 ORDER BY ea.importance DESC
			 LIMIT 5`,
		)
		.all(memoryId, agentId) as Array<{ entity_id: string; aspect_id: string }>;
	if (rows.length === 0) return null;
	return {
		entityIds: [...new Set(rows.map((row) => row.entity_id))],
		aspectIds: [...new Set(rows.map((row) => row.aspect_id))],
		dependencyIds: [],
	};
}

function loadSessionData(
	db: WriteDb,
	sessionKey: string,
	agentId: string,
	memoryIds: ReadonlyArray<string>,
): {
	readonly sessionIds: Set<string>;
	readonly storedById: Map<string, FeedbackPath>;
} {
	if (memoryIds.length === 0) {
		return {
			sessionIds: new Set(),
			storedById: new Map(),
		};
	}
	const ph = memoryIds.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT memory_id, path_json
			 FROM session_memories
			 WHERE session_key = ?
			   AND agent_id = ?
			   AND memory_id IN (${ph})`,
		)
		.all(sessionKey, agentId, ...memoryIds) as Array<{ memory_id: string; path_json: string | null }>;
	const sessionIds = new Set<string>();
	const storedById = new Map<string, FeedbackPath>();
	for (const row of rows) {
		sessionIds.add(row.memory_id);
		if (typeof row.path_json !== "string" || row.path_json.length === 0) continue;
		let raw: unknown = null;
		try {
			raw = JSON.parse(row.path_json);
		} catch {
			raw = null;
		}
		const parsed = normalizePath(raw);
		if (!parsed) continue;
		storedById.set(row.memory_id, parsed);
	}
	return { sessionIds, storedById };
}

function parsePathMap(raw: unknown): Map<string, FeedbackPath> {
	const rec = toRecord(raw);
	if (!rec) return new Map();
	const map = new Map<string, FeedbackPath>();
	for (const [id, value] of Object.entries(rec)) {
		if (id.length === 0) continue;
		const path = normalizePath(value);
		if (!path) continue;
		map.set(id, path);
	}
	return map;
}

function parseRewardMap(raw: unknown): Map<string, FeedbackReward> {
	const rec = toRecord(raw);
	if (!rec) return new Map();
	const map = new Map<string, FeedbackReward>();
	for (const [id, value] of Object.entries(rec)) {
		if (id.length === 0) continue;
		map.set(id, normalizeReward(value));
	}
	return map;
}

function updateAspects(
	db: WriteDb,
	agentId: string,
	path: FeedbackPath,
	rating: number,
	cfg: PathFeedbackConfig,
	ts: string,
): void {
	if (rating === 0 || path.aspectIds.length === 0) return;
	const delta = cfg.aspectDelta * Math.abs(rating) * (rating > 0 ? 1 : -1);
	const stmt = db.prepare(
		`UPDATE entity_aspects
		 SET weight = MIN(?, MAX(?, weight + ?)),
		     updated_at = ?
		 WHERE id = ?
		   AND agent_id = ?`,
	);
	for (const aspectId of path.aspectIds) {
		stmt.run(cfg.maxAspectWeight, cfg.minAspectWeight, delta, ts, aspectId, agentId);
	}
}

function updateDependencies(
	db: WriteDb,
	agentId: string,
	path: FeedbackPath,
	rating: number,
	cfg: PathFeedbackConfig,
	ts: string,
): number {
	if (rating === 0 || path.dependencyIds.length === 0) return 0;
	const select = db.prepare(
		`SELECT id, source_entity_id, target_entity_id, dependency_type,
		        strength, confidence, reason
		 FROM entity_dependencies
		 WHERE id = ?
		   AND agent_id = ?
		 LIMIT 1`,
	);
	const update = db.prepare(
		`UPDATE entity_dependencies
		 SET strength = ?,
		     confidence = ?,
		     reason = ?,
		     updated_at = ?
		 WHERE id = ?
		   AND agent_id = ?`,
	);
	let count = 0;
	for (const depId of path.dependencyIds) {
		const row = select.get(depId, agentId) as
			| {
					id: string;
					source_entity_id: string;
					target_entity_id: string;
					dependency_type: DependencyType;
					strength: number;
					confidence: number;
					reason: string | null;
			  }
			| undefined;
		if (!row) continue;
		const mag = Math.abs(rating);
		const next = nextReason(row.reason, rating);
		const base = reasonConfidence(next);
		const strength =
			rating > 0
				? clamp(row.strength + cfg.edgeDelta * mag, cfg.minEdgeStrength, 1)
				: clamp(row.strength - cfg.edgeDelta * mag, cfg.minEdgeStrength, 1);
		const confidence =
			rating > 0
				? clamp(Math.max(row.confidence + cfg.confidenceDelta * mag, base), cfg.minConfidence, 1)
				: clamp(Math.min(row.confidence - cfg.confidenceDelta * mag, base), cfg.minConfidence, 1);
		update.run(strength, confidence, next, ts, depId, agentId);
		count++;
	}
	return count;
}

function upsertPathStats(
	db: WriteDb,
	agentId: string,
	hash: string,
	path: FeedbackPath,
	rating: number,
	reward: number,
	cfg: PathFeedbackConfig,
	ts: string,
): void {
	const cat = rating > 0 ? "positive" : rating < 0 ? "negative" : "neutral";
	const pathJson = JSON.stringify({
		entity_ids: path.entityIds,
		aspect_ids: path.aspectIds,
		dependency_ids: path.dependencyIds,
	});
	db.prepare(
		`INSERT INTO path_feedback_stats
		 (agent_id, path_hash, path_json, q_value, sample_count,
		  positive_count, negative_count, neutral_count, updated_at, created_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
		 ON CONFLICT(agent_id, path_hash) DO UPDATE SET
		  path_json = excluded.path_json,
		  q_value = path_feedback_stats.q_value + (? - path_feedback_stats.q_value) * ?,
		  sample_count = path_feedback_stats.sample_count + 1,
		  positive_count = path_feedback_stats.positive_count + ?,
		  negative_count = path_feedback_stats.negative_count + ?,
		  neutral_count = path_feedback_stats.neutral_count + ?,
		  updated_at = excluded.updated_at`,
	).run(
		agentId,
		hash,
		pathJson,
		reward,
		cat === "positive" ? 1 : 0,
		cat === "negative" ? 1 : 0,
		cat === "neutral" ? 1 : 0,
		ts,
		ts,
		reward,
		cfg.qAlpha,
		cat === "positive" ? 1 : 0,
		cat === "negative" ? 1 : 0,
		cat === "neutral" ? 1 : 0,
	);
}

function sessionCount(db: WriteDb, agentId: string): number {
	const row = db.prepare("SELECT COUNT(*) AS cnt FROM path_feedback_sessions WHERE agent_id = ?").get(agentId) as
		| { cnt: number }
		| undefined;
	return Number(row?.cnt ?? 0);
}

function updateEntityStats(
	db: WriteDb,
	agentId: string,
	sessionKey: string,
	entityIds: ReadonlyArray<string>,
	ts: string,
): void {
	const stmt = db.prepare(
		`INSERT INTO entity_retrieval_stats
		 (agent_id, entity_id, session_count, last_session_key, updated_at, created_at)
		 VALUES (?, ?, 1, ?, ?, ?)
		 ON CONFLICT(agent_id, entity_id) DO UPDATE SET
		  session_count = CASE
		    WHEN entity_retrieval_stats.last_session_key = excluded.last_session_key
		      THEN entity_retrieval_stats.session_count
		    ELSE entity_retrieval_stats.session_count + 1
		  END,
		  last_session_key = excluded.last_session_key,
		  updated_at = excluded.updated_at`,
	);
	for (const entityId of entityIds) {
		stmt.run(agentId, entityId, sessionKey, ts, ts);
	}
}

function updatePairStats(
	db: WriteDb,
	agentId: string,
	sessionKey: string,
	pairs: ReadonlyArray<readonly [string, string]>,
	ts: string,
): void {
	const stmt = db.prepare(
		`INSERT INTO entity_cooccurrence
		 (agent_id, source_entity_id, target_entity_id, session_count, last_session_key, updated_at, created_at)
		 VALUES (?, ?, ?, 1, ?, ?, ?)
		 ON CONFLICT(agent_id, source_entity_id, target_entity_id) DO UPDATE SET
		  session_count = CASE
		    WHEN entity_cooccurrence.last_session_key = excluded.last_session_key
		      THEN entity_cooccurrence.session_count
		    ELSE entity_cooccurrence.session_count + 1
		  END,
		  last_session_key = excluded.last_session_key,
		  updated_at = excluded.updated_at`,
	);
	for (const [source, target] of pairs) {
		stmt.run(agentId, source, target, sessionKey, ts, ts);
	}
}

function countAutoEdges(db: WriteDb, agentId: string, source: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS cnt
			 FROM entity_dependencies
			 WHERE agent_id = ?
			   AND source_entity_id = ?
			   AND dependency_type = 'related_to'
			   AND reason = 'pattern-matched'`,
		)
		.get(agentId, source) as { cnt: number } | undefined;
	return Number(row?.cnt ?? 0);
}

function canonicalPair(a: string, b: string): readonly [string, string] {
	return a < b ? [a, b] : [b, a];
}

function maybePromoteDirected(
	db: WriteDb,
	agentId: string,
	pairSource: string,
	pairTarget: string,
	edgeSource: string,
	edgeTarget: string,
	total: number,
	cfg: PathFeedbackConfig,
	ts: string,
): boolean {
	if (total <= 1) return false;
	const pair = db
		.prepare(
			`SELECT session_count
			 FROM entity_cooccurrence
			 WHERE agent_id = ?
			   AND source_entity_id = ?
			   AND target_entity_id = ?`,
		)
		.get(agentId, pairSource, pairTarget) as { session_count: number } | undefined;
	const src = db
		.prepare(
			`SELECT session_count
			 FROM entity_retrieval_stats
			 WHERE agent_id = ?
			   AND entity_id = ?`,
		)
		.get(agentId, edgeSource) as { session_count: number } | undefined;
	const tgt = db
		.prepare(
			`SELECT session_count
			 FROM entity_retrieval_stats
			 WHERE agent_id = ?
			   AND entity_id = ?`,
		)
		.get(agentId, edgeTarget) as { session_count: number } | undefined;
	const co = Number(pair?.session_count ?? 0);
	const sx = Number(src?.session_count ?? 0);
	const sy = Number(tgt?.session_count ?? 0);
	if (co < cfg.minCoSessions || sx === 0 || sy === 0) return false;

	const pxy = co / total;
	const px = sx / total;
	const py = sy / total;
	if (pxy <= 0 || px <= 0 || py <= 0) return false;
	const npmi = pxy >= 1 ? 1 : Math.log(pxy / (px * py)) / -Math.log(pxy);
	if (!Number.isFinite(npmi) || npmi < cfg.npmiThreshold) return false;

	const existing = db
		.prepare(
			`SELECT id, strength, confidence
			 FROM entity_dependencies
			 WHERE agent_id = ?
			   AND source_entity_id = ?
			   AND target_entity_id = ?
			   AND dependency_type = 'related_to'
			 LIMIT 1`,
		)
		.get(agentId, edgeSource, edgeTarget) as { id: string; strength: number; confidence: number } | undefined;
	const strength = clamp(0.3 + npmi * 0.5, 0.3, 0.9);
	if (!existing) {
		if (countAutoEdges(db, agentId, edgeSource) >= cfg.autoEdgeCap) return false;
		const id = crypto.randomUUID();
		db.prepare(
			`INSERT INTO entity_dependencies
			 (id, source_entity_id, target_entity_id, agent_id, aspect_id,
			  dependency_type, strength, confidence, reason, created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, 'related_to', ?, 0.5, 'pattern-matched', ?, ?)`,
		).run(id, edgeSource, edgeTarget, agentId, strength, ts, ts);
		return true;
	}
	db.prepare(
		`UPDATE entity_dependencies
		 SET strength = ?,
		     confidence = ?,
		     reason = 'pattern-matched',
		     updated_at = ?
		 WHERE id = ?
		   AND agent_id = ?`,
	).run(Math.max(existing.strength, strength), Math.max(existing.confidence, 0.5), ts, existing.id, agentId);
	return true;
}

function maybePromotePair(
	db: WriteDb,
	agentId: string,
	source: string,
	target: string,
	total: number,
	cfg: PathFeedbackConfig,
	ts: string,
): number {
	const [pairSource, pairTarget] = canonicalPair(source, target);
	let count = 0;
	if (maybePromoteDirected(db, agentId, pairSource, pairTarget, source, target, total, cfg, ts)) {
		count++;
	}
	if (maybePromoteDirected(db, agentId, pairSource, pairTarget, target, source, total, cfg, ts)) {
		count++;
	}
	return count;
}

export function recordPathFeedback(
	accessor: DbAccessor,
	input: {
		readonly sessionKey: string;
		readonly agentId: string;
		readonly ratings: Readonly<Record<string, number>>;
		readonly paths?: unknown;
		readonly rewards?: unknown;
		readonly maxAspectWeight?: number;
		readonly minAspectWeight?: number;
	},
): PathFeedbackResult {
	const pathById = parsePathMap(input.paths);
	const rewardById = parseRewardMap(input.rewards);
	const cfg: PathFeedbackConfig = {
		...DEFAULT_CFG,
		maxAspectWeight: input.maxAspectWeight ?? DEFAULT_CFG.maxAspectWeight,
		minAspectWeight: input.minAspectWeight ?? DEFAULT_CFG.minAspectWeight,
	};

	return accessor.withWriteTx((db) => {
		recordAgentFeedbackInner(db, input.sessionKey, input.ratings, input.agentId);
		const ts = new Date().toISOString();
		const ids = Object.keys(input.ratings);
		const sessionData = loadSessionData(db, input.sessionKey, input.agentId, ids);
		const sessionIds = sessionData.sessionIds;
		const storedById = sessionData.storedById;
		db.prepare(
			`INSERT OR IGNORE INTO path_feedback_sessions (agent_id, session_key, created_at)
			 VALUES (?, ?, ?)`,
		).run(input.agentId, input.sessionKey, ts);

		let accepted = 0;
		let propagated = 0;
		let dependenciesUpdated = 0;
		const entitySet = new Set<string>();

		for (const [memoryId, ratingRaw] of Object.entries(input.ratings)) {
			if (!sessionIds.has(memoryId)) continue;
			accepted++;
			const rating = clamp(ratingRaw, -1, 1);
			const path = pathById.get(memoryId) ?? storedById.get(memoryId) ?? inferPath(db, memoryId, input.agentId);
			if (!path) continue;
			const reward = rewardById.get(memoryId) ?? normalizeReward(null);
			const score = rewardScore(reward);
			const hash = pathHash(path);
			const pathJson = JSON.stringify({
				entity_ids: path.entityIds,
				aspect_ids: path.aspectIds,
				dependency_ids: path.dependencyIds,
			});

			db.prepare(
				`INSERT INTO path_feedback_events
				 (id, agent_id, session_key, memory_id, path_hash, path_json, rating,
				  reward, reward_forward, reward_update, reward_downstream, reward_dead_end, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				crypto.randomUUID(),
				input.agentId,
				input.sessionKey,
				memoryId,
				hash,
				pathJson,
				rating,
				score,
				reward.forwardCitation,
				reward.updateAfterRetrieval,
				reward.downstreamCreation,
				reward.deadEnd,
				ts,
			);
			upsertPathStats(db, input.agentId, hash, path, rating, score, cfg, ts);
			updateAspects(db, input.agentId, path, rating, cfg, ts);
			dependenciesUpdated += updateDependencies(db, input.agentId, path, rating, cfg, ts);
			propagated++;

			if (rating > 0) {
				for (const entityId of path.entityIds) entitySet.add(entityId);
			}
		}

		const entities = [...entitySet];
		if (entities.length > 0) {
			updateEntityStats(db, input.agentId, input.sessionKey, entities, ts);
		}
		const pairs: Array<readonly [string, string]> = [];
		for (let i = 0; i < entities.length; i++) {
			for (let j = i + 1; j < entities.length; j++) {
				const a = entities[i];
				const b = entities[j];
				if (!a || !b) continue;
				pairs.push(a < b ? [a, b] : [b, a]);
			}
		}
		if (pairs.length > 0) {
			updatePairStats(db, input.agentId, input.sessionKey, pairs, ts);
		}
		const total = sessionCount(db, input.agentId);
		let cooccurrenceUpdated = 0;
		for (const [source, target] of pairs) {
			const promoted = maybePromotePair(db, input.agentId, source, target, total, cfg, ts);
			if (promoted > 0) {
				cooccurrenceUpdated++;
				dependenciesUpdated += promoted;
			}
		}

		return { accepted, propagated, cooccurrenceUpdated, dependenciesUpdated };
	});
}

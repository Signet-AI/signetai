import type { DbAccessor } from "./db-accessor";

export interface RecordComparisonParams {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly predictorNdcg: number;
	readonly baselineNdcg: number;
	readonly predictorWon: boolean;
	readonly margin: number;
	readonly alpha: number;
	readonly emaUpdated: boolean;
	readonly focalEntityId?: string;
	readonly focalEntityName?: string;
	readonly project?: string;
	readonly candidateCount: number;
	readonly traversalCount: number;
	readonly constraintCount: number;
	readonly scorerConfidence?: number;
	readonly successRate?: number;
	readonly predictorTopIds?: ReadonlyArray<string>;
	readonly baselineTopIds?: ReadonlyArray<string>;
	readonly relevanceScores?: Readonly<Record<string, number>>;
	readonly ftsOverlapScore?: number;
}

export interface PredictorComparisonRow {
	readonly id: string;
	readonly sessionKey: string;
	readonly agentId: string;
	readonly predictorNdcg: number;
	readonly baselineNdcg: number;
	readonly predictorWon: boolean;
	readonly margin: number;
	readonly alpha: number;
	readonly emaUpdated: boolean;
	readonly focalEntityId: string | null;
	readonly focalEntityName: string | null;
	readonly project: string | null;
	readonly candidateCount: number;
	readonly traversalCount: number;
	readonly constraintCount: number;
	readonly scorerConfidence: number;
	readonly successRate: number;
	readonly predictorTopIds: ReadonlyArray<string>;
	readonly baselineTopIds: ReadonlyArray<string>;
	readonly relevanceScores: Readonly<Record<string, number>>;
	readonly ftsOverlapScore: number | null;
	readonly createdAt: string;
}

export interface PredictorTrainingRunRow {
	readonly id: string;
	readonly agentId: string;
	readonly modelVersion: number;
	readonly loss: number;
	readonly sampleCount: number;
	readonly durationMs: number;
	readonly canaryNdcg: number | null;
	readonly canaryNdcgDelta: number | null;
	readonly canaryScoreVariance: number | null;
	readonly canaryTopkChurn: number | null;
	readonly createdAt: string;
}

function safeParseJsonArray(val: unknown): ReadonlyArray<string> {
	if (typeof val !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(val);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function safeParseJsonRecord(val: unknown): Readonly<Record<string, number>> {
	if (typeof val !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(val);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const result: Record<string, number> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "number") result[k] = v;
		}
		return result;
	} catch {
		return {};
	}
}

function mapComparisonRow(row: Record<string, unknown>): PredictorComparisonRow {
	return {
		id: String(row.id),
		sessionKey: String(row.session_key),
		agentId: String(row.agent_id),
		predictorNdcg: Number(row.predictor_ndcg),
		baselineNdcg: Number(row.baseline_ndcg),
		predictorWon: Number(row.predictor_won) === 1,
		margin: Number(row.margin),
		alpha: Number(row.alpha),
		emaUpdated: Number(row.ema_updated) === 1,
		focalEntityId: typeof row.focal_entity_id === "string" ? row.focal_entity_id : null,
		focalEntityName: typeof row.focal_entity_name === "string" ? row.focal_entity_name : null,
		project: typeof row.project === "string" ? row.project : null,
		candidateCount: Number(row.candidate_count),
		traversalCount: Number(row.traversal_count),
		constraintCount: Number(row.constraint_count),
		scorerConfidence: Number(row.scorer_confidence ?? 0),
		successRate: Number(row.success_rate ?? 0.5),
		predictorTopIds: safeParseJsonArray(row.predictor_top_ids),
		baselineTopIds: safeParseJsonArray(row.baseline_top_ids),
		relevanceScores: safeParseJsonRecord(row.relevance_scores),
		ftsOverlapScore: typeof row.fts_overlap_score === "number" ? row.fts_overlap_score : null,
		createdAt: String(row.created_at),
	};
}

function mapTrainingRow(row: Record<string, unknown>): PredictorTrainingRunRow {
	return {
		id: String(row.id),
		agentId: String(row.agent_id),
		modelVersion: Number(row.model_version),
		loss: Number(row.loss),
		sampleCount: Number(row.sample_count),
		durationMs: Number(row.duration_ms),
		canaryNdcg: typeof row.canary_ndcg === "number" ? Number(row.canary_ndcg) : null,
		canaryNdcgDelta: typeof row.canary_ndcg_delta === "number" ? Number(row.canary_ndcg_delta) : null,
		canaryScoreVariance: typeof row.canary_score_variance === "number" ? Number(row.canary_score_variance) : null,
		canaryTopkChurn: typeof row.canary_topk_churn === "number" ? Number(row.canary_topk_churn) : null,
		createdAt: String(row.created_at),
	};
}

export function recordComparison(accessor: DbAccessor, params: RecordComparisonParams): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO predictor_comparisons
			 (id, session_key, agent_id, predictor_ndcg, baseline_ndcg,
			  predictor_won, margin, alpha, ema_updated, focal_entity_id,
			  focal_entity_name, project, candidate_count, traversal_count,
			  constraint_count, scorer_confidence, success_rate,
			  predictor_top_ids, baseline_top_ids, relevance_scores,
			  fts_overlap_score, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			crypto.randomUUID(),
			params.sessionKey,
			params.agentId,
			params.predictorNdcg,
			params.baselineNdcg,
			params.predictorWon ? 1 : 0,
			params.margin,
			params.alpha,
			params.emaUpdated ? 1 : 0,
			params.focalEntityId ?? null,
			params.focalEntityName ?? null,
			params.project ?? null,
			params.candidateCount,
			params.traversalCount,
			params.constraintCount,
			params.scorerConfidence ?? 0,
			params.successRate ?? 0.5,
			JSON.stringify(params.predictorTopIds ?? []),
			JSON.stringify(params.baselineTopIds ?? []),
			JSON.stringify(params.relevanceScores ?? {}),
			params.ftsOverlapScore ?? null,
			new Date().toISOString(),
		);
	});
}

export function listComparisons(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly project?: string;
		readonly entityId?: string;
		readonly since?: string;
		readonly until?: string;
		readonly limit: number;
		readonly offset: number;
	},
): {
	readonly total: number;
	readonly rows: ReadonlyArray<PredictorComparisonRow>;
} {
	return accessor.withReadDb((db) => {
		const conditions = ["agent_id = ?"];
		const args: unknown[] = [params.agentId];

		if (params.project) {
			conditions.push("project = ?");
			args.push(params.project);
		}
		if (params.entityId) {
			conditions.push("focal_entity_id = ?");
			args.push(params.entityId);
		}
		if (params.since) {
			conditions.push("created_at >= ?");
			args.push(params.since);
		}
		if (params.until) {
			conditions.push("created_at <= ?");
			args.push(params.until);
		}

		const whereClause = conditions.join(" AND ");
		const totalRow = db
			.prepare(`SELECT COUNT(*) as total FROM predictor_comparisons WHERE ${whereClause}`)
			.get(...args) as { total: number };
		const rows = db
			.prepare(
				`SELECT * FROM predictor_comparisons
				 WHERE ${whereClause}
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, params.limit, params.offset) as ReadonlyArray<Record<string, unknown>>;

		return {
			total: totalRow.total,
			rows: rows.map(mapComparisonRow),
		};
	});
}

export function getComparisonsByProject(
	accessor: DbAccessor,
	agentId: string,
	since?: string,
): ReadonlyArray<{
	readonly project: string;
	readonly wins: number;
	readonly losses: number;
	readonly winRate: number;
	readonly avgMargin: number;
}> {
	return accessor.withReadDb((db) => {
		const args: unknown[] = [agentId];
		const sinceClause = since ? " AND created_at >= ?" : "";
		if (since) args.push(since);
		const rows = db
			.prepare(
				`SELECT
					project,
					SUM(CASE predictor_won WHEN 1 THEN 1 ELSE 0 END) as wins,
					SUM(CASE predictor_won WHEN 0 THEN 1 ELSE 0 END) as losses,
					AVG(CAST(predictor_won AS REAL)) as win_rate,
					AVG(margin) as avg_margin
				 FROM predictor_comparisons
				 WHERE agent_id = ?
				   AND project IS NOT NULL${sinceClause}
				 GROUP BY project
				 ORDER BY wins DESC, avg_margin DESC`,
			)
			.all(...args) as ReadonlyArray<Record<string, unknown>>;
		return rows.map((row) => ({
			project: String(row.project),
			wins: Number(row.wins),
			losses: Number(row.losses),
			winRate: Number(row.win_rate ?? 0),
			avgMargin: Number(row.avg_margin ?? 0),
		}));
	});
}

export function getComparisonsByEntity(
	accessor: DbAccessor,
	agentId: string,
	since?: string,
): ReadonlyArray<{
	readonly entityId: string;
	readonly entityName: string;
	readonly wins: number;
	readonly losses: number;
	readonly winRate: number;
	readonly avgMargin: number;
}> {
	return accessor.withReadDb((db) => {
		const args: unknown[] = [agentId];
		const sinceClause = since ? " AND created_at >= ?" : "";
		if (since) args.push(since);
		const rows = db
			.prepare(
				`SELECT
					focal_entity_id,
					COALESCE(MAX(focal_entity_name), focal_entity_id) as focal_entity_name,
					SUM(CASE predictor_won WHEN 1 THEN 1 ELSE 0 END) as wins,
					SUM(CASE predictor_won WHEN 0 THEN 1 ELSE 0 END) as losses,
					AVG(CAST(predictor_won AS REAL)) as win_rate,
					AVG(margin) as avg_margin
				 FROM predictor_comparisons
				 WHERE agent_id = ?
				   AND focal_entity_id IS NOT NULL${sinceClause}
				 GROUP BY focal_entity_id
				 ORDER BY wins DESC, avg_margin DESC`,
			)
			.all(...args) as ReadonlyArray<Record<string, unknown>>;
		return rows.map((row) => ({
			entityId: String(row.focal_entity_id),
			entityName: String(row.focal_entity_name),
			wins: Number(row.wins),
			losses: Number(row.losses),
			winRate: Number(row.win_rate ?? 0),
			avgMargin: Number(row.avg_margin ?? 0),
		}));
	});
}

export function countComparisonsSince(accessor: DbAccessor, agentId: string, since: string | null): number {
	return accessor.withReadDb((db) => {
		if (since === null) {
			const row = db.prepare("SELECT COUNT(*) as n FROM predictor_comparisons WHERE agent_id = ?").get(agentId) as {
				n: number;
			};
			return row.n;
		}
		const row = db
			.prepare("SELECT COUNT(*) as n FROM predictor_comparisons WHERE agent_id = ? AND created_at > ?")
			.get(agentId, since) as { n: number };
		return row.n;
	});
}

export function getRecentComparisons(
	accessor: DbAccessor,
	agentId: string,
	limit: number,
): ReadonlyArray<PredictorComparisonRow> {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM predictor_comparisons
				 WHERE agent_id = ?
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(agentId, limit) as ReadonlyArray<Record<string, unknown>>;
		return rows.map(mapComparisonRow);
	});
}

export function recordTrainingRun(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly modelVersion: number;
		readonly loss: number;
		readonly sampleCount: number;
		readonly durationMs: number;
		readonly canaryNdcg?: number;
		readonly canaryNdcgDelta?: number;
		readonly canaryScoreVariance?: number;
		readonly canaryTopkChurn?: number;
	},
): void {
	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO predictor_training_log
			 (id, agent_id, model_version, loss, sample_count, duration_ms,
			  canary_ndcg, canary_ndcg_delta, canary_score_variance,
			  canary_topk_churn, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			crypto.randomUUID(),
			params.agentId,
			params.modelVersion,
			params.loss,
			params.sampleCount,
			params.durationMs,
			params.canaryNdcg ?? null,
			params.canaryNdcgDelta ?? null,
			params.canaryScoreVariance ?? null,
			params.canaryTopkChurn ?? null,
			new Date().toISOString(),
		);
	});
}

export function listTrainingRuns(
	accessor: DbAccessor,
	agentId: string,
	limit: number,
): ReadonlyArray<PredictorTrainingRunRow> {
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM predictor_training_log
				 WHERE agent_id = ?
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(agentId, limit) as ReadonlyArray<Record<string, unknown>>;
		return rows.map(mapTrainingRow);
	});
}

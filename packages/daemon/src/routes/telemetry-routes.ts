import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { ErrorStage } from "../analytics.js";
import { getDbAccessor } from "../db-accessor.js";
import { getDiagnostics } from "../diagnostics.js";
import { type LogCategory, type LogEntry, logger } from "../logger.js";
import { loadMemoryConfig } from "../memory-config.js";
import { resolvePredictorCheckpointPath } from "../predictor-client.js";
import {
	getComparisonsByEntity,
	getComparisonsByProject,
	listComparisons,
	listTrainingRuns,
} from "../predictor-comparisons.js";
import { getCheckpointsByProject, getCheckpointsBySession, redactCheckpointRow } from "../session-checkpoints.js";
import type { TelemetryEventType } from "../telemetry.js";
import { type TimelineSources, buildTimeline } from "../timeline.js";
import {
	AGENTS_DIR,
	CURRENT_VERSION,
	analyticsCollector,
	buildPredictorHealthParams,
	getUpdateState,
	invalidateDiagnosticsCache,
	predictorClientRef,
	providerTracker,
	telemetryRef,
} from "./state.js";

export function registerTelemetryRoutes(app: Hono): void {
	app.get("/api/analytics/usage", (c) => {
		return c.json(analyticsCollector.getUsage());
	});

	app.get("/api/analytics/errors", (c) => {
		const stage = c.req.query("stage") as ErrorStage | undefined;
		const since = c.req.query("since") ?? undefined;
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
		return c.json({
			errors: analyticsCollector.getErrors({ stage, since, limit }),
			summary: analyticsCollector.getErrorSummary(),
		});
	});

	app.get("/api/analytics/latency", (c) => {
		return c.json(analyticsCollector.getLatency());
	});

	app.get("/api/analytics/logs", (c) => {
		const limit = Number.parseInt(c.req.query("limit") || "100", 10);
		const level = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
		const category = c.req.query("category") as LogCategory | undefined;
		const sinceRaw = c.req.query("since");
		const since = sinceRaw ? new Date(sinceRaw) : undefined;
		const logs = logger.getRecent({ limit, level, category, since });
		return c.json({ logs, count: logs.length });
	});

	app.get("/api/analytics/memory-safety", (c) => {
		const mutationHealth = getDbAccessor().withReadDb((db) =>
			getDiagnostics(db, providerTracker, getUpdateState(), buildPredictorHealthParams()),
		);
		const recentMutationErrors = analyticsCollector.getErrors({
			stage: "mutation",
			limit: 50,
		});
		return c.json({
			mutation: mutationHealth.mutation,
			recentErrors: recentMutationErrors,
			errorSummary: analyticsCollector.getErrorSummary(),
		});
	});

	app.get("/api/analytics/continuity", (c) => {
		const project = c.req.query("project");
		const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);

		const scores = getDbAccessor().withReadDb((db) => {
			if (project) {
				return db
					.prepare(
						`SELECT id, session_key, project, harness, score,
					        memories_recalled, memories_used, novel_context_count,
					        reasoning, created_at
					 FROM session_scores
					 WHERE project = ?
					 ORDER BY created_at DESC
					 LIMIT ?`,
					)
					.all(project, limit) as Array<Record<string, unknown>>;
			}
			return db
				.prepare(
					`SELECT id, session_key, project, harness, score,
					        memories_recalled, memories_used, novel_context_count,
					        reasoning, created_at
					 FROM session_scores
					 ORDER BY created_at DESC
					 LIMIT ?`,
				)
				.all(limit) as Array<Record<string, unknown>>;
		});

		const scoreValues = scores.map((s) => s.score as number).reverse();
		const trend = scoreValues.length >= 2 ? scoreValues[scoreValues.length - 1] - scoreValues[0] : 0;
		const avg = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0;

		return c.json({
			scores,
			summary: {
				count: scores.length,
				average: Math.round(avg * 100) / 100,
				trend: Math.round(trend * 100) / 100,
				latest: scores[0]?.score ?? null,
			},
		});
	});

	app.get("/api/analytics/continuity/latest", (c) => {
		const scores = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT project, score, created_at
					 FROM session_scores
					 WHERE id IN (
					   SELECT id FROM session_scores s2
					   WHERE s2.project = session_scores.project
					   ORDER BY s2.created_at DESC
					   LIMIT 1
					 )
					 ORDER BY created_at DESC`,
					)
					.all() as Array<{
					project: string | null;
					score: number;
					created_at: string;
				}>,
		);

		return c.json({ scores });
	});

	app.get("/api/predictor/comparisons/by-project", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const since = c.req.query("since") ?? undefined;
		return c.json({
			items: getComparisonsByProject(getDbAccessor(), agentId, since),
		});
	});

	app.get("/api/predictor/comparisons/by-entity", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const since = c.req.query("since") ?? undefined;
		return c.json({
			items: getComparisonsByEntity(getDbAccessor(), agentId, since),
		});
	});

	app.get("/api/predictor/comparisons", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const limitParam = Number.parseInt(c.req.query("limit") ?? "50", 10);
		const offsetParam = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
		const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

		const result = listComparisons(getDbAccessor(), {
			agentId,
			project: c.req.query("project") ?? undefined,
			entityId: c.req.query("entity_id") ?? undefined,
			since: c.req.query("since") ?? undefined,
			until: c.req.query("until") ?? undefined,
			limit,
			offset,
		});

		return c.json({
			total: result.total,
			limit,
			offset,
			items: result.rows,
		});
	});

	app.get("/api/predictor/training", (c) => {
		const agentId = c.req.query("agent_id") ?? "default";
		const limitParam = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;

		return c.json({
			items: listTrainingRuns(getDbAccessor(), agentId, limit),
		});
	});

	app.get("/api/predictor/training-pairs-count", (c) => {
		const count = getDbAccessor().withReadDb(
			(db) => (db.prepare("SELECT COUNT(*) as c FROM predictor_training_pairs").get() as { c: number }).c,
		);
		return c.json({ count });
	});

	app.post("/api/predictor/train", async (c) => {
		const cfg = loadMemoryConfig(AGENTS_DIR);
		const predictorCfg = cfg.pipelineV2.predictor;
		if (!predictorCfg?.enabled) {
			return c.json({ error: "Predictor is not enabled" }, 400);
		}

		const client = predictorClientRef;
		if (!client || !client.isAlive()) {
			return c.json({ error: "Predictor sidecar is not running" }, 503);
		}

		let body: Record<string, unknown> = {};
		try {
			body = await c.req.json();
		} catch {
			/* no body */
		}
		const limit = typeof body.limit === "number" ? body.limit : 5000;
		const epochs = typeof body.epochs === "number" ? body.epochs : 3;

		const dbPath = join(AGENTS_DIR, "memory", "memories.db");
		const checkpointPath = resolvePredictorCheckpointPath(predictorCfg);
		const result = await client.trainFromDb({
			db_path: dbPath,
			checkpoint_path: checkpointPath,
			limit,
			epochs,
		});
		if (!result) {
			return c.json({ error: "Training did not return a result" }, 500);
		}

		const checkpointSaved = result.checkpoint_saved || (await client.saveCheckpoint(checkpointPath));

		const agentId = "default";
		const { recordTrainingRun } = await import("../predictor-comparisons.js");
		const { updatePredictorState } = await import("../predictor-state.js");
		recordTrainingRun(getDbAccessor(), {
			agentId,
			modelVersion: result.step,
			loss: result.loss,
			sampleCount: result.samples_used,
			durationMs: result.duration_ms,
			canaryScoreVariance: result.canary_score_variance,
			canaryTopkChurn: result.canary_topk_stability,
		});
		updatePredictorState(agentId, { lastTrainingAt: new Date().toISOString() });
		invalidateDiagnosticsCache();

		return c.json({
			...result,
			checkpoint_path: checkpointPath,
			checkpoint_saved: checkpointSaved,
		});
	});

	app.get("/api/telemetry/events", (c) => {
		if (!telemetryRef) {
			return c.json({ events: [], enabled: false });
		}
		const event = c.req.query("event") as TelemetryEventType | undefined;
		const since = c.req.query("since");
		const until = c.req.query("until");
		const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
		const events = telemetryRef.query({ event, since, until, limit });
		return c.json({ events, enabled: true });
	});

	app.get("/api/telemetry/stats", (c) => {
		if (!telemetryRef) {
			return c.json({ enabled: false });
		}
		const since = c.req.query("since");
		const events = telemetryRef.query({ since, limit: 10000 });

		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCost = 0;
		let llmCalls = 0;
		let llmErrors = 0;
		let pipelineErrors = 0;
		const latencies: number[] = [];

		for (const e of events) {
			if (e.event === "llm.generate") {
				llmCalls++;
				if (typeof e.properties.inputTokens === "number") totalInputTokens += e.properties.inputTokens;
				if (typeof e.properties.outputTokens === "number") totalOutputTokens += e.properties.outputTokens;
				if (typeof e.properties.totalCost === "number") totalCost += e.properties.totalCost;
				if (e.properties.success === false) llmErrors++;
				if (typeof e.properties.durationMs === "number") latencies.push(e.properties.durationMs);
			}
			if (e.event === "pipeline.error") pipelineErrors++;
		}

		latencies.sort((a, b) => a - b);
		const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
		const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

		return c.json({
			enabled: true,
			totalEvents: events.length,
			llm: { calls: llmCalls, errors: llmErrors, totalInputTokens, totalOutputTokens, totalCost, p50, p95 },
			pipelineErrors,
		});
	});

	app.get("/api/telemetry/export", (c) => {
		if (!telemetryRef) {
			return c.text("telemetry not enabled", 404);
		}
		const since = c.req.query("since");
		const limit = Number.parseInt(c.req.query("limit") ?? "10000", 10);
		const events = telemetryRef.query({ since, limit });

		const lines = events.map((e) => JSON.stringify(e)).join("\n");
		return c.text(lines, 200, { "Content-Type": "application/x-ndjson" });
	});

	app.get("/api/telemetry/training-export", async (c) => {
		const { exportTrainingPairs } = await import("../predictor-training-pairs.js");
		const agentId = c.req.query("agent_id") ?? "default";
		const since = c.req.query("since");
		const rawLimit = Number.parseInt(c.req.query("limit") ?? "1000", 10);
		const limit = Math.min(Math.max(1, rawLimit), 10000);
		const format = c.req.query("format") ?? "ndjson";

		const pairs = exportTrainingPairs(getDbAccessor(), agentId, { since, limit });

		if (format === "csv") {
			const header = [
				"id",
				"agent_id",
				"session_key",
				"memory_id",
				"recency_days",
				"access_count",
				"importance",
				"decay_factor",
				"embedding_similarity",
				"entity_slot",
				"aspect_slot",
				"is_constraint",
				"structural_density",
				"fts_hit_count",
				"agent_relevance_score",
				"continuity_score",
				"fts_overlap_score",
				"combined_label",
				"was_injected",
				"predictor_rank",
				"baseline_rank",
				"created_at",
			].join(",");

			function csvEscape(value: unknown): string {
				const str = value === null || value === undefined ? "" : String(value);
				if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
					return `"${str.replace(/"/g, '""')}"`;
				}
				return str;
			}

			const rows = pairs.map((p) =>
				[
					p.id,
					p.agentId,
					p.sessionKey,
					p.memoryId,
					p.features.recencyDays,
					p.features.accessCount,
					p.features.importance,
					p.features.decayFactor,
					p.features.embeddingSimilarity ?? "",
					p.features.entitySlot ?? "",
					p.features.aspectSlot ?? "",
					p.features.isConstraint ? 1 : 0,
					p.features.structuralDensity ?? "",
					p.features.ftsHitCount,
					p.label.agentRelevanceScore ?? "",
					p.label.continuityScore ?? "",
					p.label.ftsOverlapScore ?? "",
					p.label.combined,
					p.wasInjected ? 1 : 0,
					p.predictorRank ?? "",
					p.baselineRank ?? "",
					p.createdAt,
				]
					.map(csvEscape)
					.join(","),
			);

			return c.text([header, ...rows].join("\n"), 200, {
				"Content-Type": "text/csv",
			});
		}

		const ndjsonLines = pairs.map((p) => JSON.stringify(p)).join("\n");
		return c.text(ndjsonLines, 200, { "Content-Type": "application/x-ndjson" });
	});

	app.get("/api/timeline/:id", (c) => {
		const entityId = c.req.param("id");
		const timeline = getDbAccessor().withReadDb((db) =>
			buildTimeline(
				{
					db,
					getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
					getRecentErrors: (opts) => analyticsCollector.getErrors({ limit: opts?.limit }),
				},
				entityId,
			),
		);
		return c.json(timeline);
	});

	app.get("/api/timeline/:id/export", (c) => {
		const entityId = c.req.param("id");
		const timeline = getDbAccessor().withReadDb((db) => {
			const sources: TimelineSources = {
				db,
				getRecentLogs: (opts) => logger.getRecent({ limit: opts.limit }),
				getRecentErrors: (opts) => analyticsCollector.getErrors({ limit: opts?.limit }),
			};
			return buildTimeline(sources, entityId);
		});
		return c.json({
			meta: {
				version: CURRENT_VERSION,
				exportedAt: new Date().toISOString(),
				entityId,
			},
			timeline,
		});
	});

	app.get("/api/checkpoints", (c) => {
		const project = c.req.query("project");
		const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

		if (!project) {
			return c.json({ error: "project query parameter required" }, 400);
		}

		let projectNormalized = project;
		try {
			projectNormalized = realpathSync(project);
		} catch {
			// Use raw path if realpath fails
		}

		const rows = getCheckpointsByProject(getDbAccessor(), projectNormalized, Math.min(limit, 100));
		const redacted = rows.map(redactCheckpointRow);
		return c.json({ checkpoints: redacted, count: redacted.length });
	});

	app.get("/api/checkpoints/:sessionKey", (c) => {
		const sessionKey = c.req.param("sessionKey");
		const rows = getCheckpointsBySession(getDbAccessor(), sessionKey);
		const redacted = rows.map(redactCheckpointRow);
		return c.json({ checkpoints: redacted, count: redacted.length });
	});
}

import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { ErrorStage } from "../analytics.js";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor.js";
import { getDiagnostics } from "../diagnostics.js";
import { type LogCategory, type LogEntry, logger } from "../logger.js";
import { listMemorySearchTelemetry } from "../memory-search-telemetry.js";
import { getCheckpointsByProject, getCheckpointsBySession, redactCheckpointRow } from "../session-checkpoints.js";
import type { TelemetryEventType } from "../telemetry.js";
import { type TimelineSources, buildTimeline } from "../timeline.js";
import {
	CURRENT_VERSION,
	analyticsCollector,
	authConfig,
	getDiagnosticsOptions,
	getUpdateState,
	providerTracker,
	telemetryRef,
} from "./state.js";
import { resolveScopedAgentId, resolveScopedProject } from "./utils.js";

export function registerTelemetryRoutes(app: Hono): void {
	app.use("/api/analytics", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});
	app.use("/api/analytics/*", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});
	app.use("/api/telemetry/*", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});
	app.use("/api/timeline/*", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});

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
			getDiagnostics(db, providerTracker, getUpdateState(), undefined, getDiagnosticsOptions()),
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

	app.get("/api/telemetry/memory-search", (c) => {
		const agent = resolveScopedAgentId(c, c.req.query("agent_id") ?? c.req.query("agentId"));
		if (agent.error) return c.json({ error: agent.error }, 403);
		const project = resolveScopedProject(c, c.req.query("project"));
		if (project.error) return c.json({ error: project.error }, 403);

		const limitRaw = Number.parseInt(c.req.query("limit") ?? "100", 10);
		const offsetRaw = Number.parseInt(c.req.query("offset") ?? "0", 10);
		const noHitsRaw = c.req.query("no_hits");
		const items = listMemorySearchTelemetry(getDbAccessor(), {
			agentId: agent.agentId,
			project: project.project,
			sessionKey: c.req.query("session_key") ?? c.req.query("sessionKey"),
			route: c.req.query("route"),
			since: c.req.query("since"),
			until: c.req.query("until"),
			noHits:
				noHitsRaw === "1" || noHitsRaw === "true"
					? true
					: noHitsRaw === "0" || noHitsRaw === "false"
						? false
						: undefined,
			limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100,
			offset: Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0,
		});
		return c.json({ items, count: items.length });
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

	app.get("/api/telemetry/memory-search/export", (c) => {
		const agent = resolveScopedAgentId(c, c.req.query("agent_id") ?? c.req.query("agentId"));
		if (agent.error) return c.json({ error: agent.error }, 403);
		const project = resolveScopedProject(c, c.req.query("project"));
		if (project.error) return c.json({ error: project.error }, 403);

		const limitRaw = Number.parseInt(c.req.query("limit") ?? "10000", 10);
		const noHitsRaw = c.req.query("no_hits");
		const items = listMemorySearchTelemetry(getDbAccessor(), {
			agentId: agent.agentId,
			project: project.project,
			sessionKey: c.req.query("session_key") ?? c.req.query("sessionKey"),
			route: c.req.query("route"),
			since: c.req.query("since"),
			until: c.req.query("until"),
			noHits:
				noHitsRaw === "1" || noHitsRaw === "true"
					? true
					: noHitsRaw === "0" || noHitsRaw === "false"
						? false
						: undefined,
			limit: Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 10000) : 10000,
			offset: 0,
		});
		return c.text(items.map((item) => JSON.stringify(item)).join("\n"), 200, {
			"Content-Type": "application/x-ndjson",
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

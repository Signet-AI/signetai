import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { AccountingSummaryProvenance } from "@signet/core";
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

interface AccountingCoverageTotals {
	calls: number;
	tokens: number;
	cost: number;
}

type AccountingCoverage = Record<AccountingSummaryProvenance, AccountingCoverageTotals>;

export function emptyAccountingCoverage(): AccountingCoverage {
	return {
		provider_reported: { calls: 0, tokens: 0, cost: 0 },
		locally_estimated: { calls: 0, tokens: 0, cost: 0 },
		configured_rate: { calls: 0, tokens: 0, cost: 0 },
		local_zero_cost: { calls: 0, tokens: 0, cost: 0 },
		unavailable: { calls: 0, tokens: 0, cost: 0 },
		mixed: { calls: 0, tokens: 0, cost: 0 },
	};
}

export function addAccountingCoverage(
	coverage: AccountingCoverage,
	value: unknown,
	tokens: number | null,
	cost: number | null,
): void {
	const provenance: AccountingSummaryProvenance =
		value === "provider_reported" ||
		value === "locally_estimated" ||
		value === "configured_rate" ||
		value === "local_zero_cost" ||
		value === "mixed"
			? value
			: "unavailable";
	const totals = coverage[provenance];
	totals.calls++;
	if (typeof tokens === "number" && Number.isFinite(tokens)) totals.tokens += tokens;
	if (typeof cost === "number" && Number.isFinite(cost)) totals.cost += cost;
}

function numberProperty(properties: Readonly<Record<string, unknown>>, key: string): number | null {
	const value = properties[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function totalTokens(
	properties: Readonly<Record<string, unknown>>,
	totalKey: string,
	inputKey: string,
	outputKey: string,
): number | null {
	const total = numberProperty(properties, totalKey);
	if (total !== null) return total;
	const input = numberProperty(properties, inputKey);
	const output = numberProperty(properties, outputKey);
	return input === null && output === null ? null : (input ?? 0) + (output ?? 0);
}

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
		const pipelineErrorsByStage = new Map<string, number>();
		const pipelineErrorsByCode = new Map<string, number>();
		let embeddingCalls = 0;
		let embeddingTokens = 0;
		let embeddingCost = 0;
		const embeddingBySource = new Map<string, { tokens: number; cost: number }>();
		let dreamingCalls = 0;
		let dreamingInput = 0;
		let dreamingOutput = 0;
		let dreamingCacheRead = 0;
		let dreamingCacheWrite = 0;
		let dreamingCost = 0;
		let dreamingArtifacts = 0;
		let dreamingMemoriesCreated = 0;
		let dreamingMemoriesUpdated = 0;
		let dreamingMemoriesSuperseded = 0;
		let dreamingMemoriesRetired = 0;
		let dreamingClaimsChanged = 0;
		let dreamingRelationshipsChanged = 0;
		let dreamingProvenanceLinksChanged = 0;
		let dreamingToolCalls = 0;
		let dreamingDurationMs = 0;
		const dreamingOutcomes = new Map<string, number>();
		const dreamingOutcomeCodes = new Map<string, number>();
		const dreamingByMode = new Map<
			string,
			{
				calls: number;
				tokensInput: number;
				tokensOutput: number;
				cost: number;
				artifactsConsidered: number;
				memoriesCreated: number;
				memoriesUpdated: number;
				memoriesSuperseded: number;
				memoriesRetired: number;
				claimsChanged: number;
				relationshipsChanged: number;
				provenanceLinksChanged: number;
				toolCalls: number;
				durationMs: number;
			}
		>();
		let recallCalls = 0;
		let recallAttempts = 0;
		let recallReturned = 0;
		let recallDelivered = 0;
		const recallOutcomesBySurface = new Map<string, { attempted: number; returned: number; delivered: number }>();
		const recallLatencies: number[] = [];
		const recallByType = new Map<string, number>();
		let sessionEnds = 0;
		let sessionInput = 0;
		let sessionOutput = 0;
		let sessionCacheRead = 0;
		let sessionCacheWrite = 0;
		let sessionCost = 0;
		const llmCoverage = emptyAccountingCoverage();
		const embeddingCoverage = emptyAccountingCoverage();
		const dreamingCoverage = emptyAccountingCoverage();
		const sessionCoverage = emptyAccountingCoverage();
		const latencies: number[] = [];

		for (const e of events) {
			if (e.event === "llm.generate") {
				llmCalls++;
				if (typeof e.properties.inputTokens === "number") totalInputTokens += e.properties.inputTokens;
				if (typeof e.properties.outputTokens === "number") totalOutputTokens += e.properties.outputTokens;
				if (typeof e.properties.totalCost === "number") totalCost += e.properties.totalCost;
				addAccountingCoverage(
					llmCoverage,
					e.properties.accountingProvenance,
					totalTokens(e.properties, "totalTokens", "inputTokens", "outputTokens"),
					numberProperty(e.properties, "totalCost"),
				);
				if (e.properties.success === false) llmErrors++;
				if (typeof e.properties.latencyMs === "number") latencies.push(e.properties.latencyMs);
			}
			if (e.event === "pipeline.embedding") {
				embeddingCalls++;
				const tokens = typeof e.properties.tokens === "number" ? e.properties.tokens : 0;
				const cost = typeof e.properties.cost === "number" ? e.properties.cost : 0;
				embeddingTokens += tokens;
				embeddingCost += cost;
				addAccountingCoverage(
					embeddingCoverage,
					e.properties.accountingProvenance,
					tokens,
					numberProperty(e.properties, "cost"),
				);
				const sourceKind = typeof e.properties.sourceKind === "string" ? e.properties.sourceKind : "other";
				const source = embeddingBySource.get(sourceKind) ?? { tokens: 0, cost: 0 };
				source.tokens += tokens;
				source.cost += cost;
				embeddingBySource.set(sourceKind, source);
			}
			if (e.event === "dreaming.pass") {
				dreamingCalls++;
				if (typeof e.properties.tokensInput === "number") dreamingInput += e.properties.tokensInput;
				if (typeof e.properties.tokensOutput === "number") dreamingOutput += e.properties.tokensOutput;
				if (typeof e.properties.tokensCacheRead === "number") dreamingCacheRead += e.properties.tokensCacheRead;
				if (typeof e.properties.tokensCacheWrite === "number") dreamingCacheWrite += e.properties.tokensCacheWrite;
				if (typeof e.properties.cost === "number") dreamingCost += e.properties.cost;
				addAccountingCoverage(
					dreamingCoverage,
					e.properties.accountingProvenance,
					totalTokens(e.properties, "tokensTotal", "tokensInput", "tokensOutput"),
					numberProperty(e.properties, "cost"),
				);
				const effectNumberProperty = (name: string): number =>
					typeof e.properties[name] === "number" && Number.isFinite(e.properties[name]) ? e.properties[name] : 0;
				const outcome = typeof e.properties.outcome === "string" ? e.properties.outcome : "unknown";
				const outcomeCode = typeof e.properties.outcomeCode === "string" ? e.properties.outcomeCode : "unknown";
				dreamingOutcomes.set(outcome, (dreamingOutcomes.get(outcome) ?? 0) + 1);
				dreamingOutcomeCodes.set(outcomeCode, (dreamingOutcomeCodes.get(outcomeCode) ?? 0) + 1);
				dreamingArtifacts += effectNumberProperty("artifactsConsidered");
				dreamingMemoriesCreated += effectNumberProperty("memoriesCreated");
				dreamingMemoriesUpdated += effectNumberProperty("memoriesUpdated");
				dreamingMemoriesSuperseded += effectNumberProperty("memoriesSuperseded");
				dreamingMemoriesRetired += effectNumberProperty("memoriesRetired");
				dreamingClaimsChanged += effectNumberProperty("claimsChanged");
				dreamingRelationshipsChanged += effectNumberProperty("relationshipsChanged");
				dreamingProvenanceLinksChanged += effectNumberProperty("provenanceLinksChanged");
				dreamingToolCalls += effectNumberProperty("toolCalls");
				dreamingDurationMs += effectNumberProperty("durationMs");

				const mode = typeof e.properties.mode === "string" ? e.properties.mode : "unknown";
				const byMode = dreamingByMode.get(mode) ?? {
					calls: 0,
					tokensInput: 0,
					tokensOutput: 0,
					cost: 0,
					artifactsConsidered: 0,
					memoriesCreated: 0,
					memoriesUpdated: 0,
					memoriesSuperseded: 0,
					memoriesRetired: 0,
					claimsChanged: 0,
					relationshipsChanged: 0,
					provenanceLinksChanged: 0,
					toolCalls: 0,
					durationMs: 0,
				};
				byMode.calls++;
				byMode.tokensInput += effectNumberProperty("tokensInput");
				byMode.tokensOutput += effectNumberProperty("tokensOutput");
				byMode.cost += effectNumberProperty("cost");
				byMode.artifactsConsidered += effectNumberProperty("artifactsConsidered");
				byMode.memoriesCreated += effectNumberProperty("memoriesCreated");
				byMode.memoriesUpdated += effectNumberProperty("memoriesUpdated");
				byMode.memoriesSuperseded += effectNumberProperty("memoriesSuperseded");
				byMode.memoriesRetired += effectNumberProperty("memoriesRetired");
				byMode.claimsChanged += effectNumberProperty("claimsChanged");
				byMode.relationshipsChanged += effectNumberProperty("relationshipsChanged");
				byMode.provenanceLinksChanged += effectNumberProperty("provenanceLinksChanged");
				byMode.toolCalls += effectNumberProperty("toolCalls");
				byMode.durationMs += effectNumberProperty("durationMs");
				dreamingByMode.set(mode, byMode);
			}
			if (e.event === "pipeline.error") {
				pipelineErrors++;
				if (typeof e.properties.stage === "string") {
					pipelineErrorsByStage.set(e.properties.stage, (pipelineErrorsByStage.get(e.properties.stage) ?? 0) + 1);
				}
				if (typeof e.properties.code === "string") {
					pipelineErrorsByCode.set(e.properties.code, (pipelineErrorsByCode.get(e.properties.code) ?? 0) + 1);
				}
			}
			if (e.event === "session.end") {
				sessionEnds++;
				if (typeof e.properties.tokensInput === "number") sessionInput += e.properties.tokensInput;
				if (typeof e.properties.tokensOutput === "number") sessionOutput += e.properties.tokensOutput;
				if (typeof e.properties.tokensCacheRead === "number") sessionCacheRead += e.properties.tokensCacheRead;
				if (typeof e.properties.tokensCacheWrite === "number") sessionCacheWrite += e.properties.tokensCacheWrite;
				if (typeof e.properties.cost === "number") sessionCost += e.properties.cost;
				addAccountingCoverage(
					sessionCoverage,
					e.properties.accountingProvenance,
					totalTokens(e.properties, "tokensTotal", "tokensInput", "tokensOutput"),
					numberProperty(e.properties, "cost"),
				);
			}
			if (e.event === "recall.performed") {
				recallCalls++;
				if (typeof e.properties.latencyMs === "number") recallLatencies.push(e.properties.latencyMs);
				if (typeof e.properties.type === "string") {
					recallByType.set(e.properties.type, (recallByType.get(e.properties.type) ?? 0) + 1);
				}
			}
			if (e.event === "recall.attempted") {
				recallAttempts++;
				const surface = typeof e.properties.surface === "string" ? e.properties.surface : "other";
				const totals = recallOutcomesBySurface.get(surface) ?? { attempted: 0, returned: 0, delivered: 0 };
				totals.attempted++;
				recallOutcomesBySurface.set(surface, totals);
			}
			if (e.event === "recall.outcome") {
				const surface = typeof e.properties.surface === "string" ? e.properties.surface : "other";
				const delivery = e.properties.deliveryState;
				const returned = delivery === "returned";
				const delivered = delivery === "injected" || delivery === "consumed";
				if (returned) recallReturned++;
				if (delivered) recallDelivered++;
				const totals = recallOutcomesBySurface.get(surface) ?? { attempted: 0, returned: 0, delivered: 0 };
				if (returned) totals.returned++;
				if (delivered) totals.delivered++;
				recallOutcomesBySurface.set(surface, totals);
			}
		}

		latencies.sort((a, b) => a - b);
		const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
		const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
		recallLatencies.sort((a, b) => a - b);
		const recallP50 = recallLatencies[Math.floor(recallLatencies.length * 0.5)] ?? 0;
		const recallP95 = recallLatencies[Math.floor(recallLatencies.length * 0.95)] ?? 0;

		return c.json({
			enabled: true,
			totalEvents: events.length,
			llm: {
				calls: llmCalls,
				errors: llmErrors,
				totalInputTokens,
				totalOutputTokens,
				totalCost,
				p50,
				p95,
				coverage: llmCoverage,
			},
			embedding: {
				calls: embeddingCalls,
				totalTokens: embeddingTokens,
				cost: embeddingCost,
				bySource: [...embeddingBySource.entries()]
					.map(([source, totals]) => ({ source, tokens: totals.tokens, cost: totals.cost }))
					.sort((a, b) => b.tokens - a.tokens),
				coverage: embeddingCoverage,
			},
			dreaming: {
				calls: dreamingCalls,
				tokensInput: dreamingInput,
				tokensOutput: dreamingOutput,
				tokensCacheRead: dreamingCacheRead,
				tokensCacheWrite: dreamingCacheWrite,
				cost: dreamingCost,
				coverage: dreamingCoverage,
				artifactsConsidered: dreamingArtifacts,
				memoriesCreated: dreamingMemoriesCreated,
				memoriesUpdated: dreamingMemoriesUpdated,
				memoriesSuperseded: dreamingMemoriesSuperseded,
				memoriesRetired: dreamingMemoriesRetired,
				claimsChanged: dreamingClaimsChanged,
				relationshipsChanged: dreamingRelationshipsChanged,
				provenanceLinksChanged: dreamingProvenanceLinksChanged,
				toolCalls: dreamingToolCalls,
				durationMs: dreamingDurationMs,
				outcomes: [...dreamingOutcomes.entries()]
					.map(([outcome, calls]) => ({ outcome, calls }))
					.sort((a, b) => a.outcome.localeCompare(b.outcome)),
				outcomeCodes: [...dreamingOutcomeCodes.entries()]
					.map(([code, calls]) => ({ code, calls }))
					.sort((a, b) => a.code.localeCompare(b.code)),
				byMode: [...dreamingByMode.entries()]
					.map(([mode, totals]) => ({ mode, ...totals }))
					.sort((a, b) => a.mode.localeCompare(b.mode)),
			},
			recall: {
				calls: recallCalls,
				outcomes: {
					attempted: recallAttempts,
					returned: recallReturned,
					delivered: recallDelivered,
					bySurface: [...recallOutcomesBySurface.entries()]
						.map(([surface, totals]) => ({ surface, ...totals }))
						.sort((a, b) => a.surface.localeCompare(b.surface)),
				},
				p50: recallP50,
				p95: recallP95,
				byType: [...recallByType.entries()]
					.map(([type, calls]) => ({ type, calls }))
					.sort((a, b) => a.type.localeCompare(b.type)),
			},
			sessions: {
				ended: sessionEnds,
				tokensInput: sessionInput,
				tokensOutput: sessionOutput,
				tokensCacheRead: sessionCacheRead,
				tokensCacheWrite: sessionCacheWrite,
				cost: sessionCost,
				coverage: sessionCoverage,
			},
			pipelineErrors,
			pipelineErrorsByStage: Object.fromEntries(pipelineErrorsByStage),
			pipelineErrorsByCode: Object.fromEntries(pipelineErrorsByCode),
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

import type { Hono } from "hono";
import { requirePermission } from "../auth";
import type { ReadDb } from "../db-accessor.js";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { resolveScopedAgent } from "../request-scope.js";
import { authConfig } from "./state.js";

export interface SkillStats {
	readonly skillName: string;
	readonly count: number;
	readonly successCount: number;
	readonly avgLatencyMs: number;
}

export interface SkillAnalyticsSummary {
	readonly totalCalls: number;
	readonly successRate: number;
	readonly topSkills: readonly SkillStats[];
	readonly latency: { readonly p50: number; readonly p95: number };
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

function computePercentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)] ?? 0;
}

function isIsoInstant(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
}

export function querySkillAnalytics(
	db: ReadDb,
	input: {
		readonly agentId: string;
		readonly since?: string;
		readonly limit: number;
	},
): SkillAnalyticsSummary {
	const conditions: string[] = ["si.agent_id = ?"];
	const params: unknown[] = [input.agentId];
	if (input.since) {
		conditions.push("si.created_at >= datetime(?)");
		params.push(input.since);
	}
	const where = conditions.join(" AND ");

	const totals = db
		.prepare(
			`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN si.success = 1 THEN 1 ELSE 0 END), 0) as successes
			 FROM skill_invocations si
			 WHERE ${where}`,
		)
		.get(...params) as { total: number; successes: number } | undefined;

	const totalCalls = totals?.total ?? 0;
	const successRate = totalCalls > 0 ? (totals?.successes ?? 0) / totalCalls : 0;

	const topSkills = db
		.prepare(
			`SELECT COALESCE(e.name, si.skill_name) as skillName,
			        COUNT(*) as count,
			        SUM(CASE WHEN si.success = 1 THEN 1 ELSE 0 END) as successCount,
			        CAST(AVG(si.latency_ms) AS INTEGER) as avgLatencyMs
			 FROM skill_invocations si
			 LEFT JOIN entities e
			   ON e.agent_id = si.agent_id
			  AND lower(e.name) = si.skill_name
			 WHERE ${where}
			 GROUP BY COALESCE(e.name, si.skill_name)
			 ORDER BY count DESC, skillName ASC
			 LIMIT ?`,
		)
		.all(...params, input.limit) as SkillStats[];

	const latencies = db
		.prepare(`SELECT si.latency_ms FROM skill_invocations si WHERE ${where} ORDER BY si.latency_ms`)
		.all(...params) as readonly { latency_ms: number }[];

	const sorted = latencies.map((row) => row.latency_ms);

	return {
		totalCalls,
		successRate: Math.round(successRate * 1000) / 1000,
		topSkills,
		latency: {
			p50: computePercentile(sorted, 50),
			p95: computePercentile(sorted, 95),
		},
	};
}

export function mountSkillAnalyticsRoutes(app: Hono): void {
	app.use("/api/skills/analytics", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});
	app.use("/api/skills/analytics/*", async (c, next) => {
		return requirePermission("analytics", authConfig)(c, next);
	});

	app.get("/api/skills/analytics", (c) => {
		const scoped = resolveScopedAgent(c.get("auth")?.claims ?? null, authConfig.mode, c.req.query("agent_id"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);

		const since = c.req.query("since");
		if (since && !isIsoInstant(since)) {
			return c.json({ error: "since must be an ISO 8601 UTC timestamp" }, 400);
		}

		const limit = clampPositiveInt(c.req.query("limit"), 10, 1, 100);

		try {
			const result = getDbAccessor().withReadDb((db) =>
				querySkillAnalytics(db, {
					agentId: scoped.agentId,
					since,
					limit,
				}),
			);
			return c.json(result);
		} catch (error) {
			logger.error("skills", "Failed to query skill analytics", error instanceof Error ? error : undefined);
			return c.json({ error: "Failed to query skill analytics" }, 500);
		}
	});
}

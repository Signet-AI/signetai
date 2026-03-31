/**
 * Skill invocation analytics API.
 *
 * Queries the skill_invocations table to surface per-skill usage
 * statistics. All queries scope by agent_id using auth-aware resolution.
 * Mirrors the mcp-analytics.ts pattern.
 */

import type { Hono } from "hono";
import type { AuthMode } from "../auth/index.js";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { resolveScopedAgent } from "../request-scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillStats {
	readonly skillName: string;
	readonly count: number;
	readonly successCount: number;
	readonly avgLatencyMs: number;
}

interface AnalyticsSummary {
	readonly totalCalls: number;
	readonly successRate: number;
	readonly topSkills: readonly SkillStats[];
	readonly latency: { readonly p50: number; readonly p95: number };
}

// ---------------------------------------------------------------------------
// Builtin runtime skills (hidden from user-facing analytics)
// ---------------------------------------------------------------------------

const BUILTIN_SKILLS = new Set(["remember", "recall", "memory-debug", "onboarding", "signet"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

export function mountSkillAnalyticsRoutes(app: Hono, authMode: AuthMode = "local"): void {
	// GET /api/skills/analytics — aggregated stats across all skills
	app.get("/api/skills/analytics", (c) => {
		const scoped = resolveScopedAgent(c.get("auth")?.claims ?? null, authMode, c.req.query("agent_id"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const skill = c.req.query("skill")?.toLowerCase();
		const since = c.req.query("since");
		const limit = clampPositiveInt(c.req.query("limit"), 10, 1, 100);

		try {
			const result = getDbAccessor().withReadDb((db) => {
				const conditions: string[] = ["agent_id = ?"];
				const params: unknown[] = [agentId];
				// Exclude builtin runtime skills
				const builtinPlaceholders = [...BUILTIN_SKILLS].map(() => "?").join(", ");
				conditions.push(`LOWER(skill_name) NOT IN (${builtinPlaceholders})`);
				params.push(...BUILTIN_SKILLS);
				if (skill) {
					conditions.push("LOWER(skill_name) = ?");
					params.push(skill);
				}
				if (since) {
					conditions.push("created_at >= datetime(?)");
					params.push(since);
				}
				const where = conditions.join(" AND ");

				// Total calls + success rate
				const totals = db
					.prepare(
						`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes
					 FROM skill_invocations WHERE ${where}`,
					)
					.get(...params) as { total: number; successes: number } | undefined;

				const totalCalls = totals?.total ?? 0;
				const successRate = totalCalls > 0 ? (totals?.successes ?? 0) / totalCalls : 0;

				// Top skills
				const topSkills = db
					.prepare(
						`SELECT skill_name as skillName, COUNT(*) as count,
					        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
					        CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
					 FROM skill_invocations WHERE ${where}
					 GROUP BY skill_name ORDER BY count DESC LIMIT ?`,
					)
					.all(...params, limit) as SkillStats[];

				// Latency percentiles
				const latencies = db
					.prepare(`SELECT latency_ms FROM skill_invocations WHERE ${where} ORDER BY latency_ms`)
					.all(...params) as readonly { latency_ms: number }[];

				const sorted = latencies.map((r) => r.latency_ms);
				const p50 = computePercentile(sorted, 50);
				const p95 = computePercentile(sorted, 95);

				return {
					totalCalls,
					successRate: Math.round(successRate * 1000) / 1000,
					topSkills,
					latency: { p50, p95 },
				} satisfies AnalyticsSummary;
			});

			return c.json(result);
		} catch (error) {
			logger.error("skill-analytics", "Failed to query analytics", error instanceof Error ? error : undefined);
			return c.json({ error: "Failed to query analytics" }, 500);
		}
	});
}

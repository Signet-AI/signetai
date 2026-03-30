/**
 * Skill invocation analytics API.
 *
 * Queries the skill_invocations table to surface per-skill usage
 * statistics. All queries scope by agent_id using auth-aware resolution.
 */

import type { Hono } from "hono";
import type { AuthMode } from "../auth/index.js";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { resolveScopedAgent } from "../request-scope.js";

interface SkillStats {
	readonly skillName: string;
	readonly count: number;
	readonly successCount: number;
	readonly avgLatencyMs: number;
}

interface AnalyticsSummary {
	readonly totalInvocations: number;
	readonly successRate: number;
	readonly topSkills: readonly SkillStats[];
	readonly latency: { readonly p50: number; readonly p95: number };
}

interface SkillAnalytics {
	readonly skillName: string;
	readonly totalInvocations: number;
	readonly successRate: number;
	readonly sources: readonly { readonly source: string; readonly count: number }[];
	readonly timeline: readonly { readonly date: string; readonly count: number }[];
	readonly latency: { readonly p50: number; readonly p95: number };
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isValidIsoDate(value: string): boolean {
	if (!ISO_DATE_RE.test(value)) return false;
	const d = new Date(value);
	return !Number.isNaN(d.getTime());
}

function computePercentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)] ?? 0;
}

export function mountSkillAnalyticsRoutes(app: Hono, authMode: AuthMode = "local"): void {
	app.get("/api/skills/analytics", (c) => {
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			authMode,
			c.req.query("agent_id"),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const skill = c.req.query("skill")?.toLowerCase();
		const sinceRaw = c.req.query("since");
		if (sinceRaw && !isValidIsoDate(sinceRaw)) {
			return c.json({ error: "Invalid 'since' parameter — expected ISO 8601 date" }, 400);
		}
		const since = sinceRaw;
		const limit = clampPositiveInt(c.req.query("limit"), 10, 1, 100);

		try {
			const result = getDbAccessor().withReadDb((db) => {
				const conditions: string[] = ["agent_id = ?"];
				const params: unknown[] = [agentId];
				if (skill) {
					conditions.push("skill_name = ?");
					params.push(skill);
				}
				if (since) {
					conditions.push("created_at >= datetime(?)");
					params.push(since);
				}
				const where = conditions.join(" AND ");

				const totals = db
					.prepare(
						`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes
					 FROM skill_invocations WHERE ${where}`,
					)
					.get(...params) as { total: number; successes: number } | undefined;

				const totalInvocations = totals?.total ?? 0;
				const successRate = totalInvocations > 0 ? (totals?.successes ?? 0) / totalInvocations : 0;

				const topSkills = db
					.prepare(
						`SELECT skill_name as skillName, COUNT(*) as count,
					        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successCount,
					        CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
					 FROM skill_invocations WHERE ${where}
					 GROUP BY skill_name ORDER BY count DESC LIMIT ?`,
					)
					.all(...params, limit) as SkillStats[];

				const latencies = db
					.prepare(`SELECT latency_ms FROM skill_invocations WHERE ${where} ORDER BY latency_ms`)
					.all(...params) as readonly { latency_ms: number }[];

				const sorted = latencies.map((r) => r.latency_ms);

				return {
					totalInvocations,
					successRate: Math.round(successRate * 1000) / 1000,
					topSkills,
					latency: { p50: computePercentile(sorted, 50), p95: computePercentile(sorted, 95) },
				} satisfies AnalyticsSummary;
			});

			return c.json(result);
		} catch (error) {
			logger.error("skill-analytics", "Failed to query analytics", error instanceof Error ? error : undefined);
			return c.json({ error: "Failed to query analytics" }, 500);
		}
	});

	app.get("/api/skills/analytics/:skill", (c) => {
		const skillName = c.req.param("skill").toLowerCase();
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			authMode,
			c.req.query("agent_id"),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const sinceRaw = c.req.query("since");
		if (sinceRaw && !isValidIsoDate(sinceRaw)) {
			return c.json({ error: "Invalid 'since' parameter — expected ISO 8601 date" }, 400);
		}
		const since = sinceRaw;

		try {
			const result = getDbAccessor().withReadDb((db) => {
				const conditions: string[] = ["agent_id = ?", "skill_name = ?"];
				const params: unknown[] = [agentId, skillName];
				if (since) {
					conditions.push("created_at >= datetime(?)");
					params.push(since);
				}
				const where = conditions.join(" AND ");

				const totals = db
					.prepare(
						`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes
					 FROM skill_invocations WHERE ${where}`,
					)
					.get(...params) as { total: number; successes: number } | undefined;

				const totalInvocations = totals?.total ?? 0;
				const successRate = totalInvocations > 0 ? (totals?.successes ?? 0) / totalInvocations : 0;

				const sources = db
					.prepare(
						`SELECT source, COUNT(*) as count FROM skill_invocations WHERE ${where} GROUP BY source ORDER BY count DESC`,
					)
					.all(...params) as { source: string; count: number }[];

				const timelineCutoff = since ? "datetime(?)" : "datetime('now', '-7 days')";
				const timelineParams = since ? [...params, since] : [...params];
				const sparse = db
					.prepare(
						`SELECT DATE(created_at) as date, COUNT(*) as count
					 FROM skill_invocations WHERE ${where} AND created_at >= ${timelineCutoff}
					 GROUP BY DATE(created_at) ORDER BY date`,
					)
					.all(...timelineParams) as { date: string; count: number }[];

				// Zero-fill from cutoff to today
				const counts = new Map(sparse.map((r) => [r.date, r.count]));
				const timeline: { date: string; count: number }[] = [];
				const start = since ? new Date(since) : new Date(Date.now() - 6 * 86_400_000);
				const today = new Date();
				for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
					const key = d.toISOString().slice(0, 10);
					timeline.push({ date: key, count: counts.get(key) ?? 0 });
				}

				const latencies = db
					.prepare(`SELECT latency_ms FROM skill_invocations WHERE ${where} ORDER BY latency_ms`)
					.all(...params) as readonly { latency_ms: number }[];
				const sorted = latencies.map((r) => r.latency_ms);

				return {
					skillName,
					totalInvocations,
					successRate: Math.round(successRate * 1000) / 1000,
					sources,
					timeline,
					latency: { p50: computePercentile(sorted, 50), p95: computePercentile(sorted, 95) },
				} satisfies SkillAnalytics;
			});

			return c.json(result);
		} catch (error) {
			logger.error("skill-analytics", "Failed to query skill analytics", error instanceof Error ? error : undefined);
			return c.json({ error: "Failed to query skill analytics" }, 500);
		}
	});
}

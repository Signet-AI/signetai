/**
 * MCP invocation analytics API.
 *
 * Queries the mcp_invocations table to surface per-server, per-tool,
 * and per-agent usage statistics. All queries scope by agent_id
 * using auth-aware resolution (resolveScopedAgent).
 */

import type { Hono } from "hono";
import type { AuthMode } from "../auth/index.js";
import { getDbAccessor } from "../db-accessor.js";
import { logger } from "../logger.js";
import { resolveScopedAgent } from "../request-scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolStats {
	readonly toolName: string;
	readonly count: number;
	readonly successCount: number;
	readonly avgLatencyMs: number;
}

interface ServerStats {
	readonly serverId: string;
	readonly count: number;
	readonly successCount: number;
	readonly avgLatencyMs: number;
}

interface AnalyticsSummary {
	readonly totalCalls: number;
	readonly successRate: number;
	readonly topServers: readonly ServerStats[];
	readonly topTools: readonly ToolStats[];
	readonly latency: { readonly p50: number; readonly p95: number };
}

interface ServerAnalytics {
	readonly serverId: string;
	readonly totalCalls: number;
	readonly successRate: number;
	readonly tools: readonly ToolStats[];
	readonly timeline: readonly { readonly date: string; readonly count: number }[];
}

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

export function mountMcpAnalyticsRoutes(app: Hono, authMode: AuthMode = "local"): void {
	// GET /api/mcp/analytics — aggregated stats across all servers
	app.get("/api/mcp/analytics", (c) => {
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			authMode,
			c.req.query("agent_id"),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const server = c.req.query("server");
		const since = c.req.query("since");
		const limit = clampPositiveInt(c.req.query("limit"), 10, 1, 100);

		try {
			const result = getDbAccessor().withReadDb((db) => {
				// Build WHERE clause
				const conditions: string[] = ["agent_id = ?"];
				const params: unknown[] = [agentId];
				if (server) {
					conditions.push("server_id = ?");
					params.push(server);
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
					 FROM mcp_invocations WHERE ${where}`,
					)
					.get(...params) as { total: number; successes: number } | undefined;

				const totalCalls = totals?.total ?? 0;
				const successRate = totalCalls > 0 ? (totals?.successes ?? 0) / totalCalls : 0;

				// Top servers
				const topServers = db
					.prepare(
						`SELECT server_id as serverId, COUNT(*) as count,
					        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
					        CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
					 FROM mcp_invocations WHERE ${where}
					 GROUP BY server_id ORDER BY count DESC LIMIT ?`,
					)
					.all(...params, limit) as ServerStats[];

				// Top tools
				const topTools = db
					.prepare(
						`SELECT tool_name as toolName, COUNT(*) as count,
					        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
					        CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
					 FROM mcp_invocations WHERE ${where}
					 GROUP BY tool_name ORDER BY count DESC LIMIT ?`,
					)
					.all(...params, limit) as ToolStats[];

				// Latency percentiles
				const latencies = db
					.prepare(`SELECT latency_ms FROM mcp_invocations WHERE ${where} ORDER BY latency_ms`)
					.all(...params) as readonly { latency_ms: number }[];

				const sorted = latencies.map((r) => r.latency_ms);
				const p50 = computePercentile(sorted, 50);
				const p95 = computePercentile(sorted, 95);

				return {
					totalCalls,
					successRate: Math.round(successRate * 1000) / 1000,
					topServers,
					topTools,
					latency: { p50, p95 },
				} satisfies AnalyticsSummary;
			});

			return c.json(result);
		} catch (error) {
			logger.error("mcp-analytics", "Failed to query analytics", error instanceof Error ? error : undefined);
			return c.json({ error: "Failed to query analytics" }, 500);
		}
	});

	// GET /api/mcp/analytics/:server — per-server breakdown
	app.get("/api/mcp/analytics/:server", (c) => {
		const serverId = c.req.param("server");
		const scoped = resolveScopedAgent(
			c.get("auth")?.claims ?? null,
			authMode,
			c.req.query("agent_id"),
		);
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const since = c.req.query("since");

		try {
			const result = getDbAccessor().withReadDb((db) => {
				const conditions: string[] = ["agent_id = ?", "server_id = ?"];
				const params: unknown[] = [agentId, serverId];
				if (since) {
					conditions.push("created_at >= datetime(?)");
					params.push(since);
				}
				const where = conditions.join(" AND ");

				// Total + success rate
				const totals = db
					.prepare(
						`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successes
					 FROM mcp_invocations WHERE ${where}`,
					)
					.get(...params) as { total: number; successes: number } | undefined;

				const totalCalls = totals?.total ?? 0;
				const successRate = totalCalls > 0 ? (totals?.successes ?? 0) / totalCalls : 0;

				// Per-tool breakdown
				const tools = db
					.prepare(
						`SELECT tool_name as toolName, COUNT(*) as count,
					        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
					        CAST(AVG(latency_ms) AS INTEGER) as avgLatencyMs
					 FROM mcp_invocations WHERE ${where}
					 GROUP BY tool_name ORDER BY count DESC`,
					)
					.all(...params) as ToolStats[];

				// 7-day timeline (daily buckets, zero-filled)
				const timelineCutoff = since ? "datetime(?)" : "datetime('now', '-7 days')";
				const timelineParams = since ? [...params, since] : [...params];
				const sparse = db
					.prepare(
						`SELECT DATE(created_at) as date, COUNT(*) as count
					 FROM mcp_invocations WHERE ${where} AND created_at >= ${timelineCutoff}
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

				return {
					serverId,
					totalCalls,
					successRate: Math.round(successRate * 1000) / 1000,
					tools,
					timeline,
				} satisfies ServerAnalytics;
			});

			return c.json(result);
		} catch (error) {
			logger.error("mcp-analytics", "Failed to query server analytics", error instanceof Error ? error : undefined);
			return c.json({ error: "Failed to query server analytics" }, 500);
		}
	});
}

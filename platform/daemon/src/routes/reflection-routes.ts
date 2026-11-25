import { resolveReadAgent } from "../auth/agent-access";
import { jsonBody } from "../request-body";
import { randomUUID } from "node:crypto";
import { resolveDefaultBasePath } from "@signet/core";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { generateDailyBriefInsights, todayDateInTimeZone } from "../pipeline/reflection-worker";
import { resolveScopedAgentId } from "./utils";
import { dbOwnerReflectionAnswer, dbOwnerQuery } from "../db-owner-runtime";
import { authConfig } from "./state";

const DEFAULT_REFLECTION_LIMIT = 30;
const MAX_REFLECTION_LIMIT = 100;
const MAX_REFLECTION_ANSWER_CHARS = 10_000;

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

type ReflectionRouteDeps = {
	readonly agentsDir?: string;
	readonly getDbAccessor?: typeof getDbAccessor;
	readonly getInferenceProvider?: typeof getInferenceProvider;
};

function parseReflectionLimit(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_REFLECTION_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REFLECTION_LIMIT;
	return Math.min(parsed, MAX_REFLECTION_LIMIT);
}

function parseGenerateCount(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, 6);
}

interface ReflectionRow {
	id: string;
	agent_id: string;
	date: string;
	summary: string;
	patterns: string;
	question: string | null;
	answer: string | null;
	answer_memory_id: string | null;
	memory_ids: string;
	summary_ids: string;
	model: string | null;
	created_at: string;
	answered_at: string | null;
}

function formatReflection(r: ReflectionRow) {
	return {
		id: r.id,
		date: r.date,
		summary: r.summary,
		patterns: JSON.parse(r.patterns),
		question: r.question,
		answer: r.answer,
		answerMemoryId: r.answer_memory_id,
		createdAt: r.created_at,
		answeredAt: r.answered_at,
	};
}

export function registerReflectionRoutes(app: Hono, deps: ReflectionRouteDeps = {}): void {
	const resolveDbAccessor = deps.getDbAccessor ?? getDbAccessor;

	app.use("/api/reflections", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/reflections/*", async (c, next) => {
		return requirePermission("recall", authConfig)(c, next);
	});
	app.use("/api/reflections/generate", async (c, next) => {
		return requirePermission("admin", authConfig)(c, next);
	});
	app.use("/api/reflections/:id/answer", async (c, next) => {
		return requirePermission("modify", authConfig)(c, next);
	});

	app.get("/api/reflections/today", (c) => {
		const scoped = resolveScopedAgentId(c, c.req.query("agentId"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const pipelineCfg = loadMemoryConfig(deps.agentsDir ?? getAgentsDir()).pipelineV2;
		const date = todayDateInTimeZone(pipelineCfg.reflections.timezone);
		const limit = parseReflectionLimit(c.req.query("limit"));

		try {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			const rows = resolveDbAccessor().withReadDb((db: import("../db-accessor").ReadDb) => {
				return db
					.prepare("SELECT * FROM daily_reflections WHERE agent_id = ? AND date = ? ORDER BY created_at DESC LIMIT ?")
					.all(agentId, date, limit) as ReflectionRow[];
			}, "routes/reflection-routes.ts:100");

			const reflections = rows.map(formatReflection);
			return c.json({ reflection: reflections[0] ?? null, reflections });
		} catch (e) {
			logger.error("reflections", "Failed to fetch today's reflection", e instanceof Error ? e : undefined);
			return c.json({ error: "Failed to fetch reflection" }, 500);
		}
	});

	app.get("/api/reflections", (c) => {
		const scoped = resolveScopedAgentId(c, c.req.query("agentId"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const limit = parseReflectionLimit(c.req.query("limit"));

		try {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			const rows = resolveDbAccessor().withReadDb((db: import("../db-accessor").ReadDb) => {
				return db
					.prepare(
						`SELECT id, date, summary, patterns, question, answer,
                        answer_memory_id, created_at, answered_at
                 FROM daily_reflections
                 WHERE agent_id = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
					)
					.all(agentId, limit) as ReflectionRow[];
			}, "routes/reflection-routes.ts:122");

			return c.json({ reflections: rows.map(formatReflection) });
		} catch (e) {
			logger.error("reflections", "Failed to list reflections", e instanceof Error ? e : undefined);
			return c.json({ error: "Failed to list reflections" }, 500);
		}
	});

	app.post("/api/reflections/generate", async (c) => {
		const scoped = resolveScopedAgentId(c, c.req.query("agentId"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;
		const date = new Date().toISOString().slice(0, 10);

		const pipelineCfg = loadMemoryConfig(deps.agentsDir ?? getAgentsDir()).pipelineV2;
		const cfg = pipelineCfg.reflections;
		if (!cfg?.enabled) {
			return c.json({ error: "Reflections are disabled in pipeline config" }, 400);
		}
		const count = parseGenerateCount(c.req.query("count"), cfg.count);

		let ids: string[];
		try {
			ids = await generateDailyBriefInsights(agentId, cfg, count, {
				getDbAccessor: resolveDbAccessor,
				getInferenceProvider: deps.getInferenceProvider ?? getInferenceProvider,
				logger,
			});
		} catch (e) {
			logger.error("reflections", "Daily brief generation failed", e instanceof Error ? e : undefined);
			return c.json({ error: "LLM generation failed" }, 500);
		}

		if (ids.length === 0) {
			return c.json({
				reflections: [],
				generated: 0,
				message: "No source material or fresh non-duplicate question found",
			});
		}

		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		const rows = resolveDbAccessor().withReadDb((db: import("../db-accessor").ReadDb) => {
			return db
				.prepare(
					`SELECT * FROM daily_reflections WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`,
				)
				.all(...ids) as ReflectionRow[];
		}, "routes/reflection-routes.ts:176");

		logger.info("reflections", "Generated daily brief questions", { agentId, date, count: rows.length });
		const reflections = rows.map(formatReflection);
		return c.json({ reflection: reflections[0] ?? null, reflections, generated: reflections.length });
	});

	app.post("/api/reflections/:id/answer", async (c) => {
		const id = c.req.param("id");
		const scoped = resolveScopedAgentId(c, c.req.query("agentId"));
		if (scoped.error) return c.json({ error: scoped.error }, 403);
		const agentId = scoped.agentId;

		let body: { answer?: string };
		try {
			body = await jsonBody(c)();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.answer || typeof body.answer !== "string" || body.answer.trim().length === 0) {
			return c.json({ error: "answer is required" }, 400);
		}

		const answer = body.answer.trim();
		if (answer.length > MAX_REFLECTION_ANSWER_CHARS) {
			return c.json({ error: `answer exceeds ${MAX_REFLECTION_ANSWER_CHARS} characters` }, 413);
		}

		try {
			const readTarget = c.get("organization")
				? resolveReadAgent(c.get("principal"), c.get("requestedOrganizationAgent"))
				: { ok: true as const, value: agentId };
			if (!readTarget.ok) return c.json({ error: readTarget.error.reason }, 403);
			const sourceAgentId = readTarget.value;
			const existing = await dbOwnerQuery<ReflectionRow | null>(
				{
					sql: "SELECT * FROM daily_reflections WHERE id=? AND agent_id IN (?,?)",
					params: [id, sourceAgentId, agentId],
					result: "get",
				},
				{ operation: "reflection.get-for-answer", lane: "read", deadlineMs: 3000 },
			);

			if (!existing) {
				return c.json({ error: "Reflection not found" }, 404);
			}
			if (existing.answer) {
				return c.json({ error: "Already answered" }, 409);
			}

			const now = new Date().toISOString();
			const memoryId = randomUUID();

			const claimed = await dbOwnerReflectionAnswer(
				{ id, sourceAgentId: existing.agent_id, agentId, memoryId, answer, now, author: c.get("author") },
				resolveDbAccessor(),
			);

			if (!claimed) {
				return c.json({ error: "Already answered" }, 409);
			}

			logger.info("reflections", "Reflection answered", { id, agentId, memoryId });

			return c.json({ success: true, memoryId });
		} catch (e) {
			logger.error("reflections", "Failed to save answer", e instanceof Error ? e : undefined);
			return c.json({ error: "Failed to save answer" }, 500);
		}
	});
}

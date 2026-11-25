import { registerPublicReadResponse, publicReadValue } from "../public-read-response";
import { randomUUID } from "node:crypto";
import { resolveDefaultBasePath } from "@signet/core";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor";
import { dbOwnerReflectionAnswer } from "../db-owner-runtime";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { generateDailyBriefInsights, todayDateInTimeZone } from "../pipeline/reflection-worker";
import { readReflection, readReflections, type ReflectionRow } from "../reflection-owner";
import { jsonBody } from "../request-body";
import { resolveRouteReadScope } from "./read-scope";
import { authConfig } from "./state";
import { resolveScopedAgentId } from "./utils";

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
	registerPublicReadResponse(app, "/api/reflections/*");
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

	app.get("/api/reflections/today", async (c) => {
		const scope = await resolveRouteReadScope(c, c.req.query("agentId"));
		const pipelineCfg = loadMemoryConfig(deps.agentsDir ?? getAgentsDir()).pipelineV2;
		const date = todayDateInTimeZone(pipelineCfg.reflections.timezone);
		const limit = parseReflectionLimit(c.req.query("limit"));

		try {
			const rows = await readReflections(scope, { date, limit });

			const reflections = rows.map(formatReflection);
			return c.json({ reflection: reflections[0] ?? null, reflections });
		} catch (e) {
			logger.error("reflections", "Failed to fetch today's reflection", e instanceof Error ? e : undefined);
			return c.json({ error: "Failed to fetch reflection" }, 500);
		}
	});

	app.get("/api/reflections", async (c) => {
		const scope = await resolveRouteReadScope(c, c.req.query("agentId"));
		const limit = parseReflectionLimit(c.req.query("limit"));

		try {
			const rows = await readReflections(scope, { limit });

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

		const rows = await readReflections(await resolveRouteReadScope(c, c.req.query("agentId")), { ids, limit: 100 });

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
			const existing = await readReflection(await resolveRouteReadScope(c, c.req.query("agentId")), id);

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

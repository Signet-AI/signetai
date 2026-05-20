import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { getDbAccessor } from "../db-accessor";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { generateDailyBriefInsights } from "../pipeline/reflection-worker";
import { txIngestEnvelope } from "../transactions";
import { authConfig } from "./state";

const DEFAULT_REFLECTION_LIMIT = 30;
const MAX_REFLECTION_LIMIT = 100;
const MAX_REFLECTION_ANSWER_CHARS = 10_000;

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
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

function parseGenerateCount(raw: string | undefined): number {
	if (raw === undefined) return 3;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 3;
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
		const agentId = c.req.query("agentId") ?? "default";
		const date = new Date().toISOString().slice(0, 10);
		const limit = parseReflectionLimit(c.req.query("limit"));

		try {
			const rows = resolveDbAccessor().withReadDb((db) => {
				return db
					.prepare("SELECT * FROM daily_reflections WHERE agent_id = ? AND date = ? ORDER BY created_at DESC LIMIT ?")
					.all(agentId, date, limit) as ReflectionRow[];
			});

			const reflections = rows.map(formatReflection);
			return c.json({ reflection: reflections[0] ?? null, reflections });
		} catch (e) {
			logger.error("reflections", "Failed to fetch today's reflection", e instanceof Error ? e : undefined);
			return c.json({ error: "Failed to fetch reflection" }, 500);
		}
	});

	app.get("/api/reflections", (c) => {
		const agentId = c.req.query("agentId") ?? "default";
		const limit = parseReflectionLimit(c.req.query("limit"));

		try {
			const rows = resolveDbAccessor().withReadDb((db) => {
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
			});

			return c.json({ reflections: rows.map(formatReflection) });
		} catch (e) {
			logger.error("reflections", "Failed to list reflections", e instanceof Error ? e : undefined);
			return c.json({ error: "Failed to list reflections" }, 500);
		}
	});

	app.post("/api/reflections/generate", async (c) => {
		const agentId = c.req.query("agentId") ?? "default";
		const count = parseGenerateCount(c.req.query("count"));
		const date = new Date().toISOString().slice(0, 10);

		const pipelineCfg = loadMemoryConfig(deps.agentsDir ?? getAgentsDir()).pipelineV2;
		const cfg = pipelineCfg.reflections;
		if (!cfg?.enabled) {
			return c.json({ error: "Reflections are disabled in pipeline config" }, 400);
		}

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
				message: "No source material or fresh non-duplicate insight found",
			});
		}

		const rows = resolveDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT * FROM daily_reflections WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC`,
				)
				.all(...ids) as ReflectionRow[];
		});

		logger.info("reflections", "Generated daily brief insights", { agentId, date, count: rows.length });
		const reflections = rows.map(formatReflection);
		return c.json({ reflection: reflections[0] ?? null, reflections, generated: reflections.length });
	});

	app.post("/api/reflections/:id/answer", async (c) => {
		const id = c.req.param("id");
		const agentId = c.req.query("agentId") ?? "default";

		let body: { answer?: string };
		try {
			body = await c.req.json();
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
			const existing = resolveDbAccessor().withReadDb((db) => {
				return db.prepare("SELECT * FROM daily_reflections WHERE id = ? AND agent_id = ?").get(id, agentId) as
					| ReflectionRow
					| undefined;
			});

			if (!existing) {
				return c.json({ error: "Reflection not found" }, 404);
			}
			if (existing.answer) {
				return c.json({ error: "Already answered" }, 409);
			}

			const now = new Date().toISOString();
			const memoryId = randomUUID();

			let claimed = false;
			resolveDbAccessor().withWriteTx((db) => {
				const result = db
					.prepare(
						`UPDATE daily_reflections
						 SET answer = ?, answer_memory_id = ?, answered_at = ?
						 WHERE id = ? AND agent_id = ? AND answer IS NULL`,
					)
					.run(answer, memoryId, now, id, agentId);

				if (result.changes === 0) return;
				claimed = true;

				txIngestEnvelope(db, {
					id: memoryId,
					content: answer,
					contentHash: `reflection-a-${id}`,
					who: agentId,
					why: "daily-reflection-answer",
					project: null,
					importance: 0.6,
					type: "reflection",
					tags: "reflection,answered",
					pinned: 0,
					sourceType: "reflection-answer",
					sourceId: id,
					agentId,
					createdAt: now,
				});
			});

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

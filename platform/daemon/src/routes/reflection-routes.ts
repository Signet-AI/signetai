import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { getDbAccessor } from "../db-accessor";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";
import {
	buildReflectionPrompt,
	parseReflectionResponse,
} from "../pipeline/reflection-worker";
import { loadPipelineConfig } from "../memory-config";
import { txIngestEnvelope } from "../transactions";

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

export function registerReflectionRoutes(app: Hono): void {
	app.get("/api/reflections/today", (c) => {
		const agentId = c.req.query("agentId") ?? "default";
		const date = new Date().toISOString().slice(0, 10);

		try {
			const row = getDbAccessor().withReadDb((db) => {
				return db
					.prepare(
						"SELECT * FROM daily_reflections WHERE agent_id = ? AND date = ?",
					)
					.get(agentId, date) as ReflectionRow | undefined;
			});

			if (!row) {
				return c.json({ reflection: null });
			}

			return c.json({ reflection: formatReflection(row) });
		} catch (e) {
			logger.error("reflections", "Failed to fetch today's reflection", {
				error: e instanceof Error ? e.message : String(e),
			});
			return c.json({ error: "Failed to fetch reflection" }, 500);
		}
	});

	app.get("/api/reflections", (c) => {
		const agentId = c.req.query("agentId") ?? "default";
		const limit = Math.min(Number(c.req.query("limit")) || 30, 100);

		try {
			const rows = getDbAccessor().withReadDb((db) => {
				return db
					.prepare(
						`SELECT id, date, summary, patterns, question, answer,
                        answer_memory_id, created_at, answered_at
                 FROM daily_reflections
                 WHERE agent_id = ?
                 ORDER BY date DESC
                 LIMIT ?`,
					)
					.all(agentId, limit) as ReflectionRow[];
			});

			return c.json({ reflections: rows.map(formatReflection) });
		} catch (e) {
			logger.error("reflections", "Failed to list reflections", {
				error: e instanceof Error ? e.message : String(e),
			});
			return c.json({ error: "Failed to list reflections" }, 500);
		}
	});

	app.post("/api/reflections/generate", async (c) => {
		const agentId = c.req.query("agentId") ?? "default";
		const date = new Date().toISOString().slice(0, 10);

		const existing = getDbAccessor().withReadDb((db) => {
			return db
				.prepare("SELECT id FROM daily_reflections WHERE agent_id = ? AND date = ?")
				.get(agentId, date) as { id: string } | undefined;
		});
		if (existing) {
			return c.json({ error: "Reflection already exists for today" }, 409);
		}

		const pipelineCfg = loadPipelineConfig();
		const cfg = pipelineCfg.reflections;
		if (!cfg?.enabled) {
			return c.json({ error: "Reflections are disabled in pipeline config" }, 400);
		}

		const cutoff = new Date(Date.now() - cfg.timeWindowHours * 60 * 60 * 1000).toISOString();

		const memories = getDbAccessor().withReadDb((db) => {
			return (db
				.prepare(
					`SELECT content, type, tags, created_at FROM memories
             WHERE agent_id = ? AND created_at >= ? AND is_deleted = 0
             ORDER BY created_at DESC LIMIT ?`,
				)
				.all(agentId, cutoff, cfg.maxMemories) as {
				content: string;
				type: string;
				tags: string;
				created_at: string;
			}[]).map((r) => ({
				content: r.content,
				type: r.type,
				tags: r.tags ?? "",
				createdAt: r.created_at,
			}));
		});

		const summaries = getDbAccessor().withReadDb((db) => {
			return (db
				.prepare(
					`SELECT content, created_at FROM session_summaries
             WHERE agent_id = ? AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`,
				)
				.all(agentId, cutoff, cfg.maxSummaries) as {
				content: string;
				created_at: string;
			}[]).map((r) => ({ content: r.content, createdAt: r.created_at }));
		});

		if (memories.length === 0 && summaries.length === 0) {
			return c.json({ error: "No memories or summaries in the time window" }, 400);
		}

		const prompt = buildReflectionPrompt(memories, summaries);
		let raw: string;
		try {
			const provider = getInferenceProvider("default");
			raw = await provider.generate(prompt, {
				timeoutMs: cfg.timeout,
				maxTokens: cfg.maxTokens,
			});
		} catch (e) {
			logger.error("reflections", "Manual generation failed", {
				error: e instanceof Error ? e.message : String(e),
			});
			return c.json({ error: "LLM generation failed" }, 500);
		}

		const { summary, patterns, question } = parseReflectionResponse(raw);
		const id = randomUUID();
		const now = new Date().toISOString();

		getDbAccessor().withWriteTx((db) => {
			db.exec(
				`INSERT INTO daily_reflections (id, agent_id, date, summary, patterns, question, memory_ids, summary_ids, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				agentId,
				date,
				summary,
				JSON.stringify(patterns),
				question ?? null,
				JSON.stringify(memories.map((m) => m.content.slice(0, 40))),
				JSON.stringify(summaries.map((s) => s.createdAt)),
				cfg.model,
				now,
			);
		});

		logger.info("reflections", "Manually generated daily reflection", { id, agentId, date });

		const row = getDbAccessor().withReadDb((db) => {
			return db
				.prepare("SELECT * FROM daily_reflections WHERE id = ?")
				.get(id) as ReflectionRow;
		});

		return c.json({ reflection: formatReflection(row) });
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

		try {
			const existing = getDbAccessor().withReadDb((db) => {
				return db
					.prepare("SELECT * FROM daily_reflections WHERE id = ? AND agent_id = ?")
					.get(id, agentId) as ReflectionRow | undefined;
			});

			if (!existing) {
				return c.json({ error: "Reflection not found" }, 404);
			}
			if (existing.answer) {
				return c.json({ error: "Already answered" }, 409);
			}

			const now = new Date().toISOString();
			const memoryId = randomUUID();

			getDbAccessor().withWriteTx((db) => {
				db.exec(
					`UPDATE daily_reflections
           SET answer = ?, answer_memory_id = ?, answered_at = ?
           WHERE id = ? AND agent_id = ?`,
					body.answer.trim(),
					memoryId,
					now,
					id,
					agentId,
				);

				txIngestEnvelope(db, {
					id: memoryId,
					content: body.answer.trim(),
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
					createdAt: now,
				});
			});

			logger.info("reflections", "Reflection answered", { id, agentId, memoryId });

			return c.json({ success: true, memoryId });
		} catch (e) {
			logger.error("reflections", "Failed to save answer", {
				error: e instanceof Error ? e.message : String(e),
			});
			return c.json({ error: "Failed to save answer" }, 500);
		}
	});
}

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PipelineReflectionsConfig } from "@signet/core";
import { getDbAccessor } from "../db-accessor";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";
import { txIngestEnvelope } from "../transactions";

type ReflectionDeps = {
	readonly getDbAccessor: typeof getDbAccessor;
	readonly getInferenceProvider: typeof getInferenceProvider;
	readonly logger: typeof logger;
};

const DEFAULT_DEPS: ReflectionDeps = {
	getDbAccessor,
	getInferenceProvider,
	logger,
};

const POLL_INTERVAL_MS = 300_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function getLastReflectionPath(agentId: string): string {
	const key = agentId === "default" ? "default" : encodeURIComponent(agentId);
	return join(getAgentsDir(), ".daemon", `last-reflection.${key}.json`);
}

function readLastReflectionTime(agentId: string): string | null {
	try {
		const path = getLastReflectionPath(agentId);
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		return typeof data.lastDate === "string" ? data.lastDate : null;
	} catch {
		return null;
	}
}

function writeLastReflectionTime(agentId: string, date: string): void {
	try {
		const dir = join(getAgentsDir(), ".daemon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(getLastReflectionPath(agentId), JSON.stringify({ lastDate: date }));
	} catch (e) {
		logger.warn("reflections", "Failed to persist reflection timestamp", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

function todayDate(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

function isDailyReflectionUniqueConflict(e: unknown): boolean {
	const message = e instanceof Error ? e.message : String(e);
	return message.toLowerCase().includes("unique") && message.includes("daily_reflections");
}

function scheduledTimeFor(schedule: string, now = new Date()): Date | null {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") return null;
	const minute = Number(parts[0]);
	const hour = Number(parts[1]);
	if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
		return null;
	}
	const scheduled = new Date(now);
	scheduled.setHours(hour, minute, 0, 0);
	return scheduled;
}

export function nextReflectionDelayMs(schedule: string, lastDate: string | null, now = new Date()): number {
	const scheduled = scheduledTimeFor(schedule, now);
	if (!scheduled) return POLL_INTERVAL_MS;

	const date = todayDate(now);
	if (lastDate === date) return Math.max(0, scheduled.getTime() + DAY_MS - now.getTime());
	if (now.getTime() < scheduled.getTime()) return Math.max(0, scheduled.getTime() - now.getTime());
	return POLL_INTERVAL_MS;
}

export function buildReflectionPrompt(
	memories: { content: string; type: string; tags: string; createdAt: string }[],
	summaries: { content: string; createdAt: string }[],
): string {
	const lines: string[] = [
		"You are a thoughtful assistant reviewing the last 24 hours of activity.",
		"Your task is to produce a daily reflection in the following format:",
		"",
		"SUMMARY: <2-3 sentence narrative of what the user worked on>",
		"PATTERNS: <comma-separated list of themes or patterns noticed>",
		"QUESTION: <optional - a specific question that only makes sense because you were watching. If nothing worth asking, omit this line>",
		"",
		"Keep the summary concrete and specific. The question should be about something the user",
		"might want to act on or think about. If nothing stands out, just provide the summary.",
		"",
		"Recent memories:",
	];

	for (const m of memories) {
		const date = m.createdAt.slice(0, 10);
		lines.push(`  [${date}] (${m.type}) ${m.tags ? `[${m.tags}] ` : ""}${m.content}`);
	}

	if (summaries.length > 0) {
		lines.push("", "Recent session summaries:");
		for (const s of summaries) {
			lines.push(`  [${s.createdAt.slice(0, 10)}] ${s.content.slice(0, 500)}`);
		}
	}

	return lines.join("\n");
}

export function parseReflectionResponse(text: string): { summary: string; patterns: string[]; question?: string } {
	const summary = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/)?.[1]?.trim() ?? text.slice(0, 500);
	const patternsRaw = text.match(/PATTERNS:\s*(.+?)(?:\n|$)/)?.[1]?.trim() ?? "";
	const patterns = patternsRaw
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	const question = text.match(/QUESTION:\s*(.+?)(?:\n|$)/)?.[1]?.trim();

	return { summary, patterns, question };
}

export interface ReflectionWorkerHandle {
	stop(): void;
	readonly running: boolean;
	triggerNow(agentId?: string): Promise<void>;
}

export function startReflectionWorker(
	config: PipelineReflectionsConfig,
	deps: ReflectionDeps = DEFAULT_DEPS,
): ReflectionWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let running = false;
	let generating = false;

	async function runReflection(agentId: string): Promise<void> {
		const date = todayDate();
		const existing = deps.getDbAccessor().withReadDb((db) => {
			const row = db.prepare("SELECT id FROM daily_reflections WHERE agent_id = ? AND date = ?").get(agentId, date) as
				| { id: string }
				| undefined;
			return row?.id ?? null;
		});
		if (existing) {
			writeLastReflectionTime(agentId, date);
			return;
		}

		const cutoff = new Date(Date.now() - config.timeWindowHours * 60 * 60 * 1000).toISOString();

		const memories = deps.getDbAccessor().withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT id, content, type, tags, created_at FROM memories
           WHERE agent_id = ? AND created_at >= ? AND is_deleted = 0
           ORDER BY created_at DESC LIMIT ?`,
				)
				.all(agentId, cutoff, config.maxMemories) as {
				id: string;
				content: string;
				type: string;
				tags: string;
				created_at: string;
			}[];
			return rows.map((r) => ({
				id: r.id,
				content: r.content,
				type: r.type,
				tags: r.tags ?? "",
				createdAt: r.created_at,
			}));
		});

		const summaries = deps.getDbAccessor().withReadDb((db) => {
			const rows = db
				.prepare(
					`SELECT id, content, created_at FROM session_summaries
           WHERE agent_id = ? AND created_at >= ?
           ORDER BY created_at DESC LIMIT ?`,
				)
				.all(agentId, cutoff, config.maxSummaries) as {
				id: string;
				content: string;
				created_at: string;
			}[];
			return rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.created_at }));
		});

		if (memories.length === 0 && summaries.length === 0) {
			deps.logger.debug("reflections", "No memories or summaries to reflect on", { agentId, date });
			return;
		}

		const prompt = buildReflectionPrompt(memories, summaries);

		let raw: string;
		try {
			const provider = deps.getInferenceProvider("default");
			raw = await provider.generate(prompt, {
				timeoutMs: config.timeout,
				maxTokens: config.maxTokens,
			});
		} catch (e) {
			deps.logger.warn("reflections", "Generation failed", {
				error: e instanceof Error ? e.message : String(e),
				agentId,
			});
			return;
		}

		const { summary, patterns, question } = parseReflectionResponse(raw);

		const id = randomUUID();
		const memoryIds = JSON.stringify(memories.map((m) => m.id));
		const summaryIds = JSON.stringify(summaries.map((s) => s.id));
		const now = new Date().toISOString();

		try {
			deps.getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`INSERT INTO daily_reflections
					 (id, agent_id, date, summary, patterns, question, memory_ids, summary_ids, model, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					id,
					agentId,
					date,
					summary,
					JSON.stringify(patterns),
					question ?? null,
					memoryIds,
					summaryIds,
					config.model,
					now,
				);

				if (question) {
					txIngestEnvelope(db, {
						id: randomUUID(),
						content: `Daily reflection question: ${question}`,
						contentHash: `reflection-q-${id}`,
						who: "system",
						why: "daily-reflection-question",
						project: null,
						importance: 0.5,
						type: "reflection",
						tags: "reflection,unanswered",
						pinned: 0,
						sourceType: "reflection-question",
						sourceId: id,
						agentId,
						createdAt: now,
					});
				}
			});
		} catch (e) {
			if (isDailyReflectionUniqueConflict(e)) {
				deps.logger.debug("reflections", "Reflection already generated before worker insert", { agentId, date });
				writeLastReflectionTime(agentId, date);
				return;
			}
			throw e;
		}

		writeLastReflectionTime(agentId, date);

		deps.logger.info("reflections", "Generated daily reflection", {
			agentId,
			date,
			hasQuestion: !!question,
			patterns: patterns.length,
		});
	}

	function listActiveAgentIds(): string[] {
		const cutoff = new Date(Date.now() - config.timeWindowHours * 60 * 60 * 1000).toISOString();
		const rows = deps.getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT DISTINCT agent_id FROM memories
					 WHERE created_at >= ? AND is_deleted = 0
					 UNION
					 SELECT DISTINCT agent_id FROM session_summaries
					 WHERE created_at >= ?`,
				)
				.all(cutoff, cutoff) as { agent_id: string | null }[];
		});
		const agentIds = rows.map((row) => row.agent_id).filter((agentId): agentId is string => !!agentId);
		return agentIds.length > 0 ? agentIds : ["default"];
	}

	async function runDueAgents(): Promise<void> {
		const date = todayDate();
		for (const agentId of listActiveAgentIds()) {
			const lastDate = readLastReflectionTime(agentId);
			if (lastDate !== date && nextReflectionDelayMs(config.schedule, lastDate) === POLL_INTERVAL_MS) {
				await runReflection(agentId);
			}
		}
	}

	function nextWorkerDelayMs(): number {
		return Math.min(
			...listActiveAgentIds().map((agentId) => nextReflectionDelayMs(config.schedule, readLastReflectionTime(agentId))),
		);
	}

	async function tick(): Promise<void> {
		if (stopped || generating) return;
		generating = true;
		try {
			await runDueAgents();
		} finally {
			generating = false;
			if (!stopped) {
				timer = setTimeout(tick, nextWorkerDelayMs());
			}
		}
	}

	function start(): void {
		if (running) return;
		running = true;
		timer = setTimeout(tick, nextWorkerDelayMs());
	}

	function stop(): void {
		stopped = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		running = false;
	}

	start();

	return {
		stop,
		get running() {
			return running;
		},
		async triggerNow(agentId?: string) {
			if (agentId) {
				await runReflection(agentId);
				return;
			}
			await runDueAgents();
		},
	};
}

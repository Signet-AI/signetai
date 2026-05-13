import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PipelineReflectionsConfig } from "@signet/core";
import { getDbAccessor } from "../db-accessor";
import { getInferenceProvider } from "../llm";
import { logger } from "../logger";

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

type ReflectionMemory = { id?: string; content: string; type: string; tags: string; createdAt: string };
type ReflectionSummary = {
	id?: string;
	content: string;
	createdAt: string;
	latestAt?: string | null;
	sessionKey?: string | null;
};
type ReflectionTranscript = { sessionKey: string; content: string; createdAt: string; project?: string | null };
type ReflectionGraphFact = { entity: string; kind: string; detail: string; updatedAt?: string | null };
type ExistingReflection = { id: string; question: string | null; summary: string; createdAt: string };

export type DailyBriefInsight = {
	readonly summary: string;
	readonly question?: string;
	readonly patterns: string[];
};

export type ReflectionSourceContext = {
	readonly memories: ReflectionMemory[];
	readonly summaries: ReflectionSummary[];
	readonly transcripts: ReflectionTranscript[];
	readonly graphFacts: ReflectionGraphFact[];
	readonly existingReflections: ExistingReflection[];
};

function normalizeInsight(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function trimLine(text: string, max = 260): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1).trim()}…` : single;
}

export function buildReflectionPrompt(context: ReflectionSourceContext, count = 3): string {
	const lines: string[] = [
		"You are Signet's Daily Brief generator.",
		"Reason over recent transcripts, memory, and the knowledge graph like a helpful assistant searching its memory for what is unclear or worth resolving.",
		"Generate fresh, concrete, non-redundant insights for the dashboard. Do not write a daily report. Do not summarize the last 24 hours.",
		`Return exactly ${count} items. Each item should be one short useful question or observation, ideally one sentence and never more than two.`,
		"Prefer open loops, contradictions, unresolved decisions, repeated blockers, or connections the user has not explicitly closed.",
		"Avoid repeating existing brief items. Avoid generic productivity advice.",
		"",
		"Output only lines in this format:",
		"INSIGHT: <short useful question or insight>",
		"FOCUS: <2-5 comma-separated concrete tags>",
		"",
	];

	if (context.existingReflections.length > 0) {
		lines.push("Existing brief items to avoid repeating:");
		for (const r of context.existingReflections.slice(0, 12)) {
			lines.push(`  [${r.createdAt.slice(0, 10)}] ${trimLine(r.question ?? r.summary, 220)}`);
		}
		lines.push("");
	}

	if (context.transcripts.length > 0) {
		lines.push("Recent transcript excerpts:");
		for (const t of context.transcripts) {
			const project = t.project ? ` project=${t.project}` : "";
			lines.push(`  [${t.createdAt.slice(0, 10)}${project}] ${trimLine(t.content, 900)}`);
		}
		lines.push("");
	}

	if (context.summaries.length > 0) {
		lines.push("Recent session summaries:");
		for (const s of context.summaries) {
			lines.push(`  [${s.createdAt.slice(0, 10)}] ${trimLine(s.content, 650)}`);
		}
		lines.push("");
	}

	if (context.memories.length > 0) {
		lines.push("Relevant memories:");
		for (const m of context.memories) {
			const date = m.createdAt.slice(0, 10);
			lines.push(`  [${date}] (${m.type}) ${m.tags ? `[${m.tags}] ` : ""}${trimLine(m.content, 500)}`);
		}
		lines.push("");
	}

	if (context.graphFacts.length > 0) {
		lines.push("Knowledge graph facts:");
		for (const g of context.graphFacts) {
			lines.push(`  ${g.entity} (${g.kind}): ${trimLine(g.detail, 360)}`);
		}
	}

	return lines.join("\n");
}

export function parseReflectionResponse(text: string): { summary: string; patterns: string[]; question?: string } {
	const insight = parseDailyBriefInsights(text, 1)[0];
	if (insight) return { summary: insight.summary, patterns: insight.patterns, question: insight.question };
	const summary = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/)?.[1]?.trim() ?? text.slice(0, 500);
	const patternsRaw = text.match(/PATTERNS:\s*(.+?)(?:\n|$)/)?.[1]?.trim() ?? "";
	const patterns = patternsRaw
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	const question = text.match(/QUESTION:\s*(.+?)(?:\n|$)/)?.[1]?.trim();

	return { summary, patterns, question };
}

export function parseDailyBriefInsights(text: string, limit = 3): DailyBriefInsight[] {
	const insights: DailyBriefInsight[] = [];
	let pending: string | null = null;
	let patterns: string[] = [];

	function flush(): void {
		if (!pending) return;
		const summary = trimLine(pending, 420);
		insights.push({ summary, question: summary.includes("?") ? summary : undefined, patterns });
		pending = null;
		patterns = [];
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const insight = line.match(/^(?:[-*]\s*)?(?:INSIGHT|QUESTION|BRIEF)\s*:\s*(.+)$/i)?.[1];
		if (insight) {
			flush();
			pending = insight.trim();
			continue;
		}
		const focus = line.match(/^(?:FOCUS|PATTERNS|TAGS)\s*:\s*(.+)$/i)?.[1];
		if (focus && pending) {
			patterns = focus
				.split(",")
				.map((p) => p.trim())
				.filter(Boolean)
				.slice(0, 5);
		}
	}
	flush();

	if (insights.length === 0) {
		const fallback = trimLine(text, 420);
		if (fallback)
			insights.push({ summary: fallback, question: fallback.includes("?") ? fallback : undefined, patterns: [] });
	}

	const seen = new Set<string>();
	return insights
		.filter((item) => {
			const key = normalizeInsight(item.question ?? item.summary);
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, limit);
}

export function collectReflectionContext(
	agentId: string,
	config: PipelineReflectionsConfig,
	deps: Pick<ReflectionDeps, "getDbAccessor"> = DEFAULT_DEPS,
): ReflectionSourceContext {
	const maxMemories = Math.max(config.maxMemories, 24);
	const maxSummaries = Math.max(config.maxSummaries, 12);
	const cutoff = new Date(Date.now() - Math.max(config.timeWindowHours, 1) * 60 * 60 * 1000).toISOString();
	const dbAccessor = deps.getDbAccessor();

	const memories = dbAccessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id, content, type, tags, created_at FROM memories
				 WHERE agent_id = ? AND is_deleted = 0 AND (created_at >= ? OR pinned = 1)
				 ORDER BY pinned DESC, importance DESC, created_at DESC LIMIT ?`,
			)
			.all(agentId, cutoff, maxMemories) as {
			id: string;
			content: string;
			type: string;
			tags: string | null;
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

	const summaries = dbAccessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id, content, created_at, latest_at, session_key FROM session_summaries
				 WHERE agent_id = ? AND COALESCE(latest_at, created_at) >= ?
				 ORDER BY COALESCE(latest_at, created_at) DESC LIMIT ?`,
			)
			.all(agentId, cutoff, maxSummaries) as {
			id: string;
			content: string;
			created_at: string;
			latest_at: string | null;
			session_key: string | null;
		}[];
		return rows.map((r) => ({
			id: r.id,
			content: r.content,
			createdAt: r.created_at,
			latestAt: r.latest_at,
			sessionKey: r.session_key,
		}));
	});

	const transcripts = dbAccessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT session_key, content, project, created_at FROM session_transcripts
				 WHERE agent_id = ? AND COALESCE(updated_at, created_at) >= ?
				 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 4`,
			)
			.all(agentId, cutoff) as { session_key: string; content: string; project: string | null; created_at: string }[];
		return rows.map((r) => ({
			sessionKey: r.session_key,
			content: r.content,
			project: r.project,
			createdAt: r.created_at,
		}));
	});

	const graphFacts = dbAccessor.withReadDb((db) => {
		const attributes = db
			.prepare(
				`SELECT e.name AS entity, e.entity_type AS kind, ea.name AS aspect, attr.content AS content, attr.updated_at AS updated_at
				 FROM entity_attributes attr
				 LEFT JOIN entity_aspects ea ON ea.id = attr.aspect_id
				 LEFT JOIN entities e ON e.id = ea.entity_id
				 WHERE attr.agent_id = ? AND attr.status = 'active' AND e.name IS NOT NULL
				   AND COALESCE(attr.updated_at, attr.created_at) >= ?
				 ORDER BY attr.importance DESC, attr.updated_at DESC LIMIT 28`,
			)
			.all(agentId, cutoff) as {
			entity: string;
			kind: string;
			aspect: string | null;
			content: string;
			updated_at: string | null;
		}[];
		return attributes.map((r) => ({
			entity: r.entity,
			kind: r.kind,
			detail: `${r.aspect ? `${r.aspect}: ` : ""}${r.content}`,
			updatedAt: r.updated_at,
		}));
	});

	const existingReflections = dbAccessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id, question, summary, created_at FROM daily_reflections
             WHERE agent_id = ?
             ORDER BY created_at DESC LIMIT 24`,
			)
			.all(agentId) as { id: string; question: string | null; summary: string; created_at: string }[];
		return rows.map((r) => ({ id: r.id, question: r.question, summary: r.summary, createdAt: r.created_at }));
	});

	return { memories, summaries, transcripts, graphFacts, existingReflections };
}

export async function generateDailyBriefInsights(
	agentId: string,
	config: PipelineReflectionsConfig,
	count = 3,
	deps: ReflectionDeps = DEFAULT_DEPS,
): Promise<string[]> {
	const context = collectReflectionContext(agentId, config, deps);
	if (
		context.memories.length === 0 &&
		context.summaries.length === 0 &&
		context.transcripts.length === 0 &&
		context.graphFacts.length === 0
	) {
		return [];
	}

	const prompt = buildReflectionPrompt(context, count);
	const provider = deps.getInferenceProvider("default");
	const raw = await provider.generate(prompt, { timeoutMs: config.timeout, maxTokens: config.maxTokens });
	const existing = new Set(
		context.existingReflections.map((r) => normalizeInsight(r.question ?? r.summary)).filter(Boolean),
	);
	const insights = parseDailyBriefInsights(raw, Math.max(count * 2, count))
		.filter((insight) => {
			const key = normalizeInsight(insight.question ?? insight.summary);
			if (!key || existing.has(key)) return false;
			existing.add(key);
			return true;
		})
		.slice(0, count);

	if (insights.length === 0) return [];

	const now = new Date().toISOString();
	const date = todayDate();
	const memoryIds = JSON.stringify(context.memories.map((m) => m.id).filter(Boolean));
	const summaryIds = JSON.stringify(context.summaries.map((s) => s.id).filter(Boolean));
	const ids: string[] = [];

	deps.getDbAccessor().withWriteTx((db) => {
		for (const insight of insights) {
			const id = randomUUID();
			const contentKey = normalizeInsight(insight.question ?? insight.summary);
			const result = db
				.prepare(
					`INSERT OR IGNORE INTO daily_reflections
				 (id, agent_id, date, summary, patterns, question, content_key, memory_ids, summary_ids, model, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					agentId,
					date,
					insight.summary,
					JSON.stringify(insight.patterns),
					insight.question ?? null,
					contentKey,
					memoryIds,
					summaryIds,
					config.model,
					now,
				);
			if (result.changes > 0) ids.push(id);
		}
	});

	return ids;
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
		try {
			const ids = await generateDailyBriefInsights(agentId, config, 1, deps);
			if (ids.length === 0) {
				deps.logger.debug("reflections", "No source material or fresh insight to reflect on", { agentId });
				return;
			}
			writeLastReflectionTime(agentId, todayDate());
			deps.logger.info("reflections", "Generated daily brief insight", { agentId, count: ids.length });
		} catch (e) {
			deps.logger.warn("reflections", "Generation failed", {
				error: e instanceof Error ? e.message : String(e),
				agentId,
			});
		}
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

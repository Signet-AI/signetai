import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PipelineReflectionsConfig } from "@signet/core";
import { resolveDefaultBasePath } from "@signet/core";
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
const DAILY_BRIEF_MEMORY_BATCH_SIZE = 50;
/** Hard ceiling per brief, enforced at parse time and requested in the prompt. */
export const BRIEF_MAX_CHARS = 236;

function getAgentsDir(): string {
	return resolveDefaultBasePath();
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

// -- Timezone-aware calendar math -------------------------------------------
// The daily schedule fires in the user's detected timezone (daemon local time
// by default). Plain setHours() + toISOString() mixes local and UTC calendar
// days, so "today" and "6am" must be computed through Intl with the configured
// IANA timezone, DST included.

type ZonedParts = {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
};

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = zonedFormatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		zonedFormatterCache.set(timeZone, formatter);
	}
	return formatter;
}

function zonedParts(timeZone: string, instant: Date): ZonedParts {
	const values: Record<string, string> = {};
	for (const part of zonedFormatter(timeZone).formatToParts(instant)) {
		if (part.type !== "literal") values[part.type] = part.value;
	}
	return {
		year: Number(values.year),
		month: Number(values.month),
		day: Number(values.day),
		hour: Number(values.hour) % 24,
		minute: Number(values.minute),
		second: Number(values.second),
	};
}

/**
 * The instant whose wall clock in `timeZone` reads (y, m0, d) at hh:mm.
 * Refines the UTC offset by round-tripping through Intl, which converges in
 * two or three iterations and stays correct across DST boundaries.
 */
function zonedDateTime(
	timeZone: string,
	year: number,
	month0: number,
	day: number,
	hour: number,
	minute: number,
): Date {
	const targetAsUtc = Date.UTC(year, month0, day, hour, minute);
	let guess = targetAsUtc;
	for (let i = 0; i < 3; i += 1) {
		const parts = zonedParts(timeZone, new Date(guess));
		const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - guess;
		guess = targetAsUtc - offset;
	}
	return new Date(guess);
}

/** Calendar date (YYYY-MM-DD) of `now` in `timeZone`. */
export function todayDateInTimeZone(timeZone: string, now = new Date()): string {
	const parts = zonedParts(timeZone, now);
	return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Today's wall-clock occurrence of `M H * * *` in `timeZone`; null for non-daily schedules. */
function scheduledTimeFor(schedule: string, timeZone: string, now = new Date()): Date | null {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*" || parts[4] !== "*") return null;
	const minute = Number(parts[0]);
	const hour = Number(parts[1]);
	if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
		return null;
	}
	const local = zonedParts(timeZone, now);
	// Today's occurrence, even when already past: the delay logic uses the
	// pastness to decide "due now" (catch up after the slot was missed).
	return zonedDateTime(timeZone, local.year, local.month - 1, local.day, hour, minute);
}

export function nextReflectionDelayMs(
	schedule: string,
	timeZone: string,
	lastDate: string | null,
	now = new Date(),
): number {
	const scheduled = scheduledTimeFor(schedule, timeZone, now);
	if (!scheduled) return POLL_INTERVAL_MS;

	const date = todayDateInTimeZone(timeZone, now);
	if (lastDate === date) {
		// Already generated today: sleep until tomorrow's slot, computed in the
		// same timezone so DST transitions do not drift the wake-up by an hour.
		const local = zonedParts(timeZone, now);
		const scheduledParts = zonedParts(timeZone, scheduled);
		const tomorrow = zonedDateTime(
			timeZone,
			local.year,
			local.month - 1,
			local.day + 1,
			scheduledParts.hour,
			scheduledParts.minute,
		);
		return Math.max(0, tomorrow.getTime() - now.getTime());
	}
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

function isQuestionLedInsight(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
	if (normalized.endsWith("?")) return true;
	return /^(?:has|have|does|did|do|is|are|was|were|can|could|will|would|should|what|which|who|when|where|why|how)\b[^.!?]*\?/.test(
		normalized,
	);
}

export function buildReflectionPrompt(context: ReflectionSourceContext, count = 1): string {
	const plural = count === 1 ? "brief" : "briefs";
	const lines: string[] = [
		"You write the daily brief for a local memory tool. Below is a raw bundle of the user's recent saved memories, picked mechanically, not curated for a topic. Treat it as evidence, not a theme.",
		"",
		`Write ${count} ${plural}. Each brief is ONE short, plain observation, said the way you would to a smart friend who does not work in your field. They should get it on first read.`,
		"",
		"Good briefs look like one of these:",
		"- An old thought returned plainly: something the user wrote that is worth carrying today.",
		"- A real change worth noticing: what the user said, and what showed up after it.",
		"- A small practical correction: something concrete that is off or worth adjusting.",
		"A direct observation is enough. Do not force a pattern or a thesis.",
		"",
		"Rules:",
		"- Plain words, short sentences, one idea per brief.",
		"- Use concrete details from the memories: names, projects, places, dates, repeated phrases.",
		"- No jargon, no vague labels, no 'same mechanism' or 'same shape' connectors.",
		"- Do not perform a verdict on the user's life. No armchair psychology.",
		"- Do not invent facts, feelings, or motives. If the memories do not say it, leave it out.",
		"- Do not ask what Signet, an agent, or a tool should do.",
		"- No productivity planning unless the memories center on an active decision.",
		`- Hard limit: each brief is at most ${BRIEF_MAX_CHARS} characters.`,
		"",
		"Output only lines in this format:",
		"BRIEF: <the brief>",
		"",
	];

	if (context.existingReflections.length > 0) {
		lines.push("Existing brief items to avoid repeating:");
		for (const r of context.existingReflections.slice(0, 12)) {
			lines.push(`  [${r.createdAt.slice(0, 10)}] ${trimLine(r.summary, 220)}`);
			if (r.question && normalizeInsight(r.question) !== normalizeInsight(r.summary)) {
				lines.push(`  [${r.createdAt.slice(0, 10)}] ${trimLine(r.question, 220)}`);
			}
		}
		lines.push("");
	}

	lines.push("Recent saved memories:");
	for (const m of context.memories) {
		const date = m.createdAt.slice(0, 10);
		lines.push(`  [${date}] (${m.type}) ${m.tags ? `[${m.tags}] ` : ""}${trimLine(m.content, 500)}`);
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

export function parseDailyBriefInsights(text: string, limit = 1): DailyBriefInsight[] {
	const insights: DailyBriefInsight[] = [];
	let pending: string | null = null;
	let pendingIsQuestion = false;
	let patterns: string[] = [];

	function flush(): void {
		if (!pending) return;
		const summary = trimLine(pending, BRIEF_MAX_CHARS);
		if (summary) {
			const question = pendingIsQuestion || isQuestionLedInsight(summary) ? summary : undefined;
			insights.push({ summary, question, patterns });
		}
		pending = null;
		pendingIsQuestion = false;
		patterns = [];
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const entry = line.match(/^(?:[-*]\s*)?(?:ASK|QUESTION|BRIEF|GAP|INSIGHT|SUMMARY)\s*:\s*(.+)$/i);
		if (entry) {
			flush();
			pending = entry[1].trim();
			pendingIsQuestion = /^(?:[-*]\s*)?(?:ASK|QUESTION)\s*:/i.test(line);
			continue;
		}
		const focus = line.match(/^(?:[-*]\s*)?(?:FOCUS|PATTERNS|TAGS)\s*:\s*(.+)$/i)?.[1];
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
		const hasStructuredLabel =
			/^\s*(?:[-*]\s*)?(?:ASK|BRIEF|FOCUS|GAP|INSIGHT|PATTERNS|QUESTION|SUMMARY|TAGS)\s*:/im.test(text);
		const fallback = trimLine(text, BRIEF_MAX_CHARS);
		if (!hasStructuredLabel && fallback) {
			const question = isQuestionLedInsight(fallback) ? fallback : undefined;
			insights.push({ summary: fallback, question, patterns: [] });
		}
	}

	const seen = new Set<string>();
	return insights
		.filter((item) => {
			const key = normalizeInsight(item.summary);
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, limit);
}

export function collectReflectionContext(
	agentId: string,
	_config: PipelineReflectionsConfig,
	deps: Pick<ReflectionDeps, "getDbAccessor"> = DEFAULT_DEPS,
): ReflectionSourceContext {
	const dbAccessor = deps.getDbAccessor();

	const memories = dbAccessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id, content, type, tags, created_at FROM memories
				 WHERE agent_id = ? AND is_deleted = 0
				 ORDER BY created_at DESC LIMIT ?`,
			)
			.all(agentId, DAILY_BRIEF_MEMORY_BATCH_SIZE) as {
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

	return { memories, summaries: [], transcripts: [], graphFacts: [], existingReflections };
}

export async function generateDailyBriefInsights(
	agentId: string,
	config: PipelineReflectionsConfig,
	count = config.count,
	deps: ReflectionDeps = DEFAULT_DEPS,
): Promise<string[]> {
	const context = collectReflectionContext(agentId, config, deps);
	if (context.memories.length === 0) return [];

	const prompt = buildReflectionPrompt(context, count);
	const provider = deps.getInferenceProvider("default");
	const raw = await provider.generate(prompt, { timeoutMs: config.timeout, maxTokens: config.maxTokens });
	const existing = new Set(
		context.existingReflections
			.flatMap((r) => [r.summary, r.question ?? ""])
			.map((text) => normalizeInsight(text))
			.filter(Boolean),
	);
	const insights = parseDailyBriefInsights(raw, Math.max(count * 2, count))
		.filter((insight) => {
			const key = normalizeInsight(insight.summary);
			if (!key || existing.has(key)) return false;
			existing.add(key);
			return true;
		})
		.slice(0, count);

	if (insights.length === 0) return [];

	const now = new Date().toISOString();
	const date = todayDateInTimeZone(config.timezone);
	const memoryIds = JSON.stringify(context.memories.map((m) => m.id).filter(Boolean));
	const summaryIds = JSON.stringify(context.summaries.map((s) => s.id).filter(Boolean));
	const ids: string[] = [];

	deps.getDbAccessor().withWriteTx((db) => {
		for (const insight of insights) {
			const id = randomUUID();
			const contentKey = normalizeInsight(insight.summary);
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
			const ids = await generateDailyBriefInsights(agentId, config, config.count, deps);
			if (ids.length === 0) {
				deps.logger.debug("reflections", "No source material or fresh insight to reflect on", { agentId });
				return;
			}
			writeLastReflectionTime(agentId, todayDateInTimeZone(config.timezone));
			deps.logger.info("reflections", "Generated daily briefs", { agentId, count: ids.length });
		} catch (e) {
			deps.logger.warn("reflections", "Generation failed", {
				error: e instanceof Error ? e.message : String(e),
				agentId,
			});
		}
	}

	function listActiveAgentIds(): string[] {
		const rows = deps.getDbAccessor().withReadDb((db) => {
			return db
				.prepare(
					`SELECT DISTINCT agent_id FROM memories
					 WHERE is_deleted = 0`,
				)
				.all() as { agent_id: string | null }[];
		});
		const agentIds = rows.map((row) => row.agent_id).filter((agentId): agentId is string => !!agentId);
		return agentIds.length > 0 ? agentIds : ["default"];
	}

	async function runDueAgents(): Promise<void> {
		const date = todayDateInTimeZone(config.timezone);
		for (const agentId of listActiveAgentIds()) {
			const lastDate = readLastReflectionTime(agentId);
			if (lastDate !== date && nextReflectionDelayMs(config.schedule, config.timezone, lastDate) === POLL_INTERVAL_MS) {
				await runReflection(agentId);
			}
		}
	}

	function nextWorkerDelayMs(): number {
		return Math.min(
			...listActiveAgentIds().map((agentId) =>
				nextReflectionDelayMs(config.schedule, config.timezone, readLastReflectionTime(agentId)),
			),
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

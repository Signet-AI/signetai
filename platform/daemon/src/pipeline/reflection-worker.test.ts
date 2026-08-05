import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, PipelineReflectionsConfig } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { logger } from "../logger";
import { txIngestEnvelope } from "../transactions";
import {
	buildReflectionPrompt,
	collectReflectionContext,
	generateDailyBriefInsights,
	nextReflectionDelayMs,
	parseDailyBriefInsights,
	startReflectionWorker,
	todayDateInTimeZone,
} from "./reflection-worker";

let dir: string;
const previousSignetPath = process.env.SIGNET_PATH;

const config: PipelineReflectionsConfig = {
	enabled: true,
	timeWindowHours: 24,
	maxMemories: 10,
	maxSummaries: 10,
	schedule: "daily",
	timezone: "UTC",
	count: 3,
	timeout: 1000,
	maxTokens: 200,
	model: "test-model",
};

function provider(text: string): LlmProvider {
	return {
		name: "test-provider",
		async available(): Promise<boolean> {
			return true;
		},
		async generate(): Promise<string> {
			return text;
		},
	};
}

function seedMemory(
	agentId: string,
	opts: {
		readonly content?: string;
		readonly createdAt?: string;
		readonly pinned?: number;
		readonly hash?: string;
	} = {},
): string {
	const now = opts.createdAt ?? new Date().toISOString();
	const id = randomUUID();
	getDbAccessor().withWriteTx((db) => {
		txIngestEnvelope(db, {
			id,
			content: opts.content ?? "The reflection worker needs durable persistence.",
			contentHash: opts.hash ?? `worker-test-${agentId}`,
			who: "tester",
			why: "test-seed",
			project: null,
			importance: 0.5,
			type: "fact",
			tags: "test",
			pinned: opts.pinned ?? 0,
			sourceType: "test",
			sourceId: "reflection-worker.test",
			agentId,
			createdAt: now,
		});
	});
	return id;
}

function seedReflection(agentId: string, date = new Date().toISOString().slice(0, 10)): string {
	const id = randomUUID();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO daily_reflections
			 (id, agent_id, date, summary, patterns, question, memory_ids, summary_ids, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, agentId, date, "Existing reflection", "[]", null, "[]", "[]", new Date().toISOString());
	});
	return id;
}

beforeEach(() => {
	dir = join(tmpdir(), `signet-reflection-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "memory"), { recursive: true });
	process.env.SIGNET_PATH = dir;
	initDbAccessor(join(dir, "memory", "memories.db"));
});

afterEach(() => {
	closeDbAccessor();
	if (previousSignetPath === undefined) {
		process.env.SIGNET_PATH = undefined;
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("reflection worker", () => {
	it("uses cron-style daily schedule delays in the configured timezone", () => {
		// UTC: 6am slot, before and after the hour.
		expect(nextReflectionDelayMs("0 6 * * *", "UTC", null, new Date("2026-05-13T05:30:00.000Z"))).toBe(30 * 60 * 1000);
		expect(nextReflectionDelayMs("0 6 * * *", "UTC", null, new Date("2026-05-13T06:30:00.000Z"))).toBe(300_000);
		expect(nextReflectionDelayMs("0 6 * * *", "UTC", "2026-05-13", new Date("2026-05-13T06:30:00.000Z"))).toBe(
			23.5 * 60 * 60 * 1000,
		);
	});

	it("fires the daily slot at 6am in the user's timezone, not UTC", () => {
		// 2026-05-13T07:30Z is 01:30 MDT; 6am Denver is 12:00Z → 4.5h away.
		expect(nextReflectionDelayMs("0 6 * * *", "America/Denver", null, new Date("2026-05-13T07:30:00.000Z"))).toBe(
			4.5 * 60 * 60 * 1000,
		);
		// 23:30Z is 17:30 MDT — today's slot passed, so the worker is due now.
		expect(nextReflectionDelayMs("0 6 * * *", "America/Denver", null, new Date("2026-05-13T23:30:00.000Z"))).toBe(
			300_000,
		);
	});

	it("keeps the daily date boundary in the configured timezone", () => {
		// 2026-05-14T01:30Z is still May 13 in Denver (19:30 MDT).
		expect(todayDateInTimeZone("America/Denver", new Date("2026-05-14T01:30:00.000Z"))).toBe("2026-05-13");
		expect(todayDateInTimeZone("UTC", new Date("2026-05-14T01:30:00.000Z"))).toBe("2026-05-14");
	});

	it("stays DST-correct across offset changes", () => {
		// Denver is MDT (UTC-6) in June and MST (UTC-7) in December; 6am is
		// 12:00Z vs 13:00Z. A naive fixed-offset scheduler would be an hour off
		// on one side of the year.
		expect(nextReflectionDelayMs("0 6 * * *", "America/Denver", null, new Date("2026-12-13T12:30:00.000Z"))).toBe(
			30 * 60 * 1000,
		);
		expect(nextReflectionDelayMs("0 6 * * *", "America/Denver", null, new Date("2026-06-13T11:30:00.000Z"))).toBe(
			30 * 60 * 1000,
		);
	});

	it("does not mark the day complete when there is no source material", async () => {
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () => provider("SUMMARY: Should not run."),
			logger,
		});

		try {
			await worker.triggerNow();
		} finally {
			worker.stop();
		}

		expect(existsSync(join(dir, ".daemon", "last-reflection.default.json"))).toBe(false);
	});

	it("collects the last 50 saved memories as the daily brief source batch", () => {
		const ids: string[] = [];
		const base = Date.now() - 60_000;
		for (let i = 0; i < 55; i += 1) {
			ids.push(
				seedMemory("default", {
					content: `Saved memory ${i}`,
					createdAt: new Date(base + i * 1000).toISOString(),
					hash: `saved-memory-${i}`,
				}),
			);
		}

		const context = collectReflectionContext("default", config);

		expect(context.memories).toHaveLength(50);
		expect(context.memories.map((m) => m.id)).toEqual(ids.slice(5).reverse());
		expect(context.summaries).toEqual([]);
		expect(context.transcripts).toEqual([]);
		expect(context.graphFacts).toEqual([]);
	});

	it("builds a plain-language brief prompt over saved memories", () => {
		const prompt = buildReflectionPrompt(
			{
				memories: [
					{
						id: "memory-1",
						content: "Issue #868 likely involves compare/install catalog key routing.",
						type: "fact",
						tags: "issue868,backend",
						createdAt: "2026-06-28T00:00:00.000Z",
					},
				],
				summaries: [],
				transcripts: [],
				graphFacts: [],
				existingReflections: [],
			},
			3,
		);

		expect(prompt).toContain("raw bundle of the user's recent saved memories");
		expect(prompt).toContain("A direct observation is enough. Do not force a pattern or a thesis.");
		expect(prompt).toContain("Do not perform a verdict on the user's life. No armchair psychology.");
		expect(prompt).toContain("Do not ask what Signet, an agent, or a tool should do.");
		expect(prompt).toContain("each brief is at most 236 characters");
		expect(prompt).toContain("Recent saved memories:");
		expect(prompt).toContain("BRIEF: <the brief>");
		expect(prompt).toContain("Write 3 briefs");
	});

	it("parses daily brief questions and preserves legacy insight output", () => {
		const question =
			"Nicholai, you wrote that AI work should keep humility because it is still AI slop next to real art. Later, Ant fixing broken CI felt hug-worthy. How do those truths sit together now?";
		const insights = parseDailyBriefInsights(
			[
				`QUESTION: ${question}`,
				"INSIGHT: Rust parity test ports are the release bottleneck; group the remaining work by harness surface before opening more feature threads.",
				"FOCUS: rust-parity, release",
			].join("\n"),
			2,
		);

		expect(insights).toEqual([
			{
				summary: question,
				question,
				patterns: [],
			},
			{
				summary:
					"Rust parity test ports are the release bottleneck; group the remaining work by harness surface before opening more feature threads.",
				question: undefined,
				patterns: ["rust-parity", "release"],
			},
		]);
		expect(parseDailyBriefInsights("QUESTION: Has the backend path been verified?\nFOCUS: backend", 1)).toEqual([
			{
				summary: "Has the backend path been verified?",
				question: "Has the backend path been verified?",
				patterns: ["backend"],
			},
		]);
	});

	it("persists generated brief questions", async () => {
		const memoryId = seedMemory("default");
		const question = "Nicholai, you wrote one thing and later another related thing showed up. How does that feel now?";
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () => provider(`QUESTION: ${question}`),
			logger,
		});

		try {
			await worker.triggerNow();
		} finally {
			worker.stop();
		}

		const reflection = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT summary, question, model, memory_ids FROM daily_reflections WHERE agent_id = ?")
					.get("default") as {
					summary: string;
					question: string | null;
					model: string;
					memory_ids: string;
				},
		);
		expect(reflection).toEqual({
			summary: question,
			question,
			model: "test-model",
			memory_ids: JSON.stringify([memoryId]),
		});

		const questionCount = getDbAccessor().withReadDb(
			(db) =>
				(
					db.prepare("SELECT COUNT(*) AS count FROM memories WHERE source_type = ?").get("reflection-question") as {
						count: number;
					}
				).count,
		);
		expect(questionCount).toBe(0);
	});

	it("truncates any brief that exceeds the 236-character ceiling", () => {
		const longBrief = `BRIEF: ${"x".repeat(300)}`;
		const insights = parseDailyBriefInsights(longBrief, 1);
		expect(insights).toHaveLength(1);
		expect(insights[0].summary.length).toBeLessThanOrEqual(236);
		expect(insights[0].summary.endsWith("…")).toBe(true);

		const shortBrief = "BRIEF: You wrote that note and it still holds.";
		expect(parseDailyBriefInsights(shortBrief, 1)[0].summary).toBe("You wrote that note and it still holds.");
	});

	it("generates the configured daily count of briefs in one scheduled run", async () => {
		seedMemory("default");
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () =>
				provider(
					[
						"BRIEF: You shipped the fix and moved on.",
						"BRIEF: The Venice plates arrived in 02_incoming.",
						"BRIEF: That old note still reads true.",
					].join("\n"),
				),
			logger,
		});

		try {
			await worker.triggerNow();
		} finally {
			worker.stop();
		}

		const rows = getDbAccessor().withReadDb((db) => {
			return db.prepare("SELECT summary FROM daily_reflections WHERE agent_id = ? ORDER BY summary").all("default") as {
				summary: string;
			}[];
		});
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.summary)).toEqual([
			"That old note still reads true.",
			"The Venice plates arrived in 02_incoming.",
			"You shipped the fix and moved on.",
		]);
		expect(existsSync(join(dir, ".daemon", "last-reflection.default.json"))).toBe(true);
	});

	it("allows multiple same-day insights but de-duplicates repeated brief text", async () => {
		seedMemory("default");
		seedReflection("default");
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () => provider("INSIGHT: Existing reflection\nFOCUS: duplicate"),
			logger,
		});

		try {
			await worker.triggerNow();
		} finally {
			worker.stop();
		}

		const counts = getDbAccessor().withReadDb((db) => ({
			questions: (
				db.prepare("SELECT COUNT(*) AS count FROM memories WHERE source_type = ?").get("reflection-question") as {
					count: number;
				}
			).count,
			reflections: (
				db.prepare("SELECT COUNT(*) AS count FROM daily_reflections WHERE agent_id = ?").get("default") as {
					count: number;
				}
			).count,
		}));
		expect(counts).toEqual({ questions: 0, reflections: 1 });
	});

	it("deduplicates concurrent dashboard-open generations at insert time", async () => {
		seedMemory("default");
		let waiting = 0;
		let release: (() => void) | null = null;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const raceProvider: LlmProvider = {
			name: "race-provider",
			async available(): Promise<boolean> {
				return true;
			},
			async generate(): Promise<string> {
				waiting += 1;
				if (waiting === 2) release?.();
				await barrier;
				return "QUESTION: Duplicate dashboard-open generations should insert one row?";
			},
		};
		await Promise.all([
			generateDailyBriefInsights("default", config, 1, {
				getDbAccessor,
				getInferenceProvider: () => raceProvider,
				logger,
			}),
			generateDailyBriefInsights("default", config, 1, {
				getDbAccessor,
				getInferenceProvider: () => raceProvider,
				logger,
			}),
		]);

		const rows = getDbAccessor().withReadDb((db) => {
			return db.prepare("SELECT summary, content_key FROM daily_reflections WHERE agent_id = ?").all("default") as {
				summary: string;
				content_key: string;
			}[];
		});
		expect(rows).toEqual([
			{
				summary: "Duplicate dashboard-open generations should insert one row?",
				content_key: "duplicate dashboard open generations should insert one row",
			},
		]);
	});

	it("scheduled trigger reflects every active agent instead of hardcoding default", async () => {
		const memoryId = seedMemory("agent-c");
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () => provider("SUMMARY: Agent C reflection.\nPATTERNS: scoped\nQUESTION: Continue?"),
			logger,
		});

		try {
			await worker.triggerNow();
		} finally {
			worker.stop();
		}

		const rows = getDbAccessor().withReadDb((db) => {
			return db.prepare("SELECT agent_id, memory_ids FROM daily_reflections ORDER BY agent_id").all() as {
				agent_id: string;
				memory_ids: string;
			}[];
		});
		// The provider response carries two insights (SUMMARY + QUESTION), so
		// the configured count of 3 allows both rows — every one scoped to the
		// active agent, never "default".
		expect(rows).toEqual([
			{ agent_id: "agent-c", memory_ids: JSON.stringify([memoryId]) },
			{ agent_id: "agent-c", memory_ids: JSON.stringify([memoryId]) },
		]);
		expect(existsSync(join(dir, ".daemon", "last-reflection.agent-c.json"))).toBe(true);
	});
});

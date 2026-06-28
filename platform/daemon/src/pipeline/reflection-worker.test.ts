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
} from "./reflection-worker";

let dir: string;
const previousSignetPath = process.env.SIGNET_PATH;

const config: PipelineReflectionsConfig = {
	enabled: true,
	timeWindowHours: 24,
	maxMemories: 10,
	maxSummaries: 10,
	schedule: "daily",
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
	it("uses cron-style daily schedule delays", () => {
		expect(nextReflectionDelayMs("0 8 * * *", null, new Date(2026, 4, 13, 7, 30))).toBe(30 * 60 * 1000);
		expect(nextReflectionDelayMs("0 8 * * *", null, new Date(2026, 4, 13, 8, 30))).toBe(300_000);
		expect(nextReflectionDelayMs("0 8 * * *", "2026-05-13", new Date(2026, 4, 13, 8, 30))).toBe(23.5 * 60 * 60 * 1000);
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

	it("builds a memory-question prompt over saved memories", () => {
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
			1,
		);

		expect(prompt).toContain("mechanically selected bundle of recent user memories");
		expect(prompt).toContain("You wrote/said X, and later Y showed up. How does that fit/feel now?");
		expect(prompt).toContain("Do not ask what Signet, an agent, or a tool should do.");
		expect(prompt).toContain("Recent saved memories:");
		expect(prompt).toContain("QUESTION: <daily brief question>");
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
				db.prepare("SELECT summary, question, model, memory_ids FROM daily_reflections WHERE agent_id = ?").get("default") as {
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
		expect(rows).toEqual([{ agent_id: "agent-c", memory_ids: JSON.stringify([memoryId]) }]);
		expect(existsSync(join(dir, ".daemon", "last-reflection.agent-c.json"))).toBe(true);
	});
});

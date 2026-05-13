import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, PipelineReflectionsConfig } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { logger } from "../logger";
import { txIngestEnvelope } from "../transactions";
import { nextReflectionDelayMs, startReflectionWorker } from "./reflection-worker";

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

function seedMemory(agentId: string): string {
	const now = new Date().toISOString();
	const id = randomUUID();
	getDbAccessor().withWriteTx((db) => {
		txIngestEnvelope(db, {
			id,
			content: "The reflection worker needs durable persistence.",
			contentHash: `worker-test-${agentId}`,
			who: "tester",
			why: "test-seed",
			project: null,
			importance: 0.5,
			type: "fact",
			tags: "test",
			pinned: 0,
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

	it("persists generated reflections and scoped question memories", async () => {
		const memoryId = seedMemory("default");
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () =>
				provider("SUMMARY: Worker persisted.\nPATTERNS: persistence\nQUESTION: Should we keep it?"),
			logger,
		});

		try {
			await worker.triggerNow();
		} finally {
			worker.stop();
		}

		const reflection = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT summary, model, memory_ids FROM daily_reflections WHERE agent_id = ?").get("default") as {
					summary: string;
					model: string;
					memory_ids: string;
				},
		);
		expect(reflection).toEqual({
			summary: "Worker persisted.",
			model: "test-model",
			memory_ids: JSON.stringify([memoryId]),
		});

		const question = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT content, agent_id FROM memories WHERE source_type = ?").get("reflection-question") as {
					content: string;
					agent_id: string;
				},
		);
		expect(question).toEqual({
			content: "Daily reflection question: Should we keep it?",
			agent_id: "default",
		});
	});

	it("skips question ingestion when another writer wins the daily insert race", async () => {
		seedMemory("default");
		let inserted = false;
		const worker = startReflectionWorker(config, {
			getDbAccessor,
			getInferenceProvider: () => ({
				name: "racing-provider",
				async available(): Promise<boolean> {
					return true;
				},
				async generate(): Promise<string> {
					if (!inserted) {
						seedReflection("default");
						inserted = true;
					}
					return "SUMMARY: Lost race.\nPATTERNS: race\nQUESTION: Should not ingest?";
				},
			}),
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
		expect(existsSync(join(dir, ".daemon", "last-reflection.default.json"))).toBe(true);
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

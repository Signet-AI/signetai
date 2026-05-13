import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { closeInferenceProviderResolver, initInferenceProviderResolver } from "../llm";
import { txIngestEnvelope } from "../transactions";
import { registerReflectionRoutes } from "./reflection-routes";

let dir: string;
const previousSignetPath = process.env.SIGNET_PATH;

function makeProvider(text: string): LlmProvider {
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

function seedMemory(agentId: string, content = "Built daily reflections."): string {
	const now = new Date().toISOString();
	const id = randomUUID();
	getDbAccessor().withWriteTx((db) => {
		txIngestEnvelope(db, {
			id,
			content,
			contentHash: `test-${agentId}-${content}`,
			who: "tester",
			why: "test-seed",
			project: null,
			importance: 0.5,
			type: "fact",
			tags: "test",
			pinned: 0,
			sourceType: "test",
			sourceId: "reflection-routes.test",
			agentId,
			createdAt: now,
		});
	});
	return id;
}

function seedReflection(id: string, agentId: string, date = "2026-05-12"): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO daily_reflections
			 (id, agent_id, date, summary, patterns, question, memory_ids, summary_ids, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			agentId,
			date,
			"Reflection summary",
			JSON.stringify(["testing"]),
			"What did we learn?",
			"[]",
			"[]",
			new Date().toISOString(),
		);
	});
}

function app(): Hono {
	const next = new Hono();
	registerReflectionRoutes(next);
	return next;
}

beforeEach(() => {
	dir = join(tmpdir(), `signet-reflections-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "memory"), { recursive: true });
	process.env.SIGNET_PATH = dir;
	writeFileSync(
		join(dir, "agent.yaml"),
		`memory:
  pipelineV2:
    reflections:
      enabled: true
      timeWindowHours: 24
      maxMemories: 10
      maxSummaries: 10
      timeout: 1000
      maxTokens: 200
      model: test-model
`,
	);
	initDbAccessor(join(dir, "memory", "memories.db"));
	initInferenceProviderResolver(() =>
		makeProvider("SUMMARY: We fixed reflections.\nPATTERNS: persistence, scoping\nQUESTION: Keep it?"),
	);
});

afterEach(() => {
	closeInferenceProviderResolver();
	closeDbAccessor();
	if (previousSignetPath === undefined) {
		process.env.SIGNET_PATH = undefined;
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("reflection routes", () => {
	it("loads pipeline config from SIGNET_PATH and persists manual generation", async () => {
		const memoryId = seedMemory("agent-a");

		const res = await app().request("/api/reflections/generate?agentId=agent-a", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reflection.summary).toBe("We fixed reflections.");
		expect(body.reflection.patterns).toEqual(["persistence", "scoping"]);

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT agent_id, model, memory_ids FROM daily_reflections WHERE id = ?")
					.get(body.reflection.id) as {
					agent_id: string;
					model: string;
					memory_ids: string;
				},
		);
		expect(row).toEqual({ agent_id: "agent-a", model: "test-model", memory_ids: JSON.stringify([memoryId]) });
	});

	it("defaults invalid list limits instead of allowing unlimited history", async () => {
		for (let i = 0; i < 35; i += 1) {
			seedReflection(randomUUID(), "agent-list", `2026-04-${String(i + 1).padStart(2, "0")}`);
		}

		const res = await app().request("/api/reflections?agentId=agent-list&limit=-1");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reflections).toHaveLength(30);
	});

	it("rejects oversized reflection answers before persistence", async () => {
		const reflectionId = randomUUID();
		seedReflection(reflectionId, "agent-b");

		const res = await app().request(`/api/reflections/${reflectionId}/answer?agentId=agent-b`, {
			method: "POST",
			body: JSON.stringify({ answer: "x".repeat(10_001) }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(413);

		const state = getDbAccessor().withReadDb((db) => {
			return {
				answer: (
					db.prepare("SELECT answer FROM daily_reflections WHERE id = ?").get(reflectionId) as { answer: string | null }
				).answer,
				memories: (
					db
						.prepare("SELECT COUNT(*) AS count FROM memories WHERE source_type = ? AND source_id = ?")
						.get("reflection-answer", reflectionId) as { count: number }
				).count,
			};
		});
		expect(state).toEqual({ answer: null, memories: 0 });
	});

	it("stores answers under the reflection agent scope", async () => {
		const reflectionId = randomUUID();
		seedReflection(reflectionId, "agent-b");

		const res = await app().request(`/api/reflections/${reflectionId}/answer?agentId=agent-b`, {
			method: "POST",
			body: JSON.stringify({ answer: "  Ship the scoping fix.  " }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();

		const memory = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT content, agent_id FROM memories WHERE id = ?").get(body.memoryId) as {
					content: string;
					agent_id: string;
				},
		);
		expect(memory).toEqual({ content: "Ship the scoping fix.", agent_id: "agent-b" });
	});

	it("does not create duplicate answer memories after the answer is claimed", async () => {
		const reflectionId = randomUUID();
		seedReflection(reflectionId, "agent-b");

		const first = await app().request(`/api/reflections/${reflectionId}/answer?agentId=agent-b`, {
			method: "POST",
			body: JSON.stringify({ answer: "First answer." }),
			headers: { "content-type": "application/json" },
		});
		expect(first.status).toBe(200);

		const second = await app().request(`/api/reflections/${reflectionId}/answer?agentId=agent-b`, {
			method: "POST",
			body: JSON.stringify({ answer: "Second answer." }),
			headers: { "content-type": "application/json" },
		});
		expect(second.status).toBe(409);

		const state = getDbAccessor().withReadDb((db) => {
			return {
				answer: (
					db.prepare("SELECT answer FROM daily_reflections WHERE id = ?").get(reflectionId) as { answer: string }
				).answer,
				memories: (
					db
						.prepare("SELECT COUNT(*) AS count FROM memories WHERE source_type = ? AND source_id = ?")
						.get("reflection-answer", reflectionId) as { count: number }
				).count,
			};
		});
		expect(state).toEqual({ answer: "First answer.", memories: 1 });
	});
});

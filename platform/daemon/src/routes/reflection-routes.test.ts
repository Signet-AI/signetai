import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider } from "@signet/core";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import { localPrincipal } from "../auth/principal";
import { closeDbAccessor, type DbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { closeInferenceProviderResolver, initInferenceProviderResolver } from "../llm";
import { txIngestEnvelope } from "../transactions";
import { registerReflectionRoutes } from "./reflection-routes";

let dir: string;
let dbAccessor: DbAccessor;
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
	dbAccessor.withWriteTx((db) => {
		txIngestEnvelope(db, {
			author: { userId: null, credential: "system" },
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

function seedReflection(
	id: string,
	agentId: string,
	date = "2026-05-12",
	summary = "Reflection summary",
	createdAt = new Date().toISOString(),
): void {
	dbAccessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO daily_reflections
			 (id, agent_id, date, summary, patterns, question, memory_ids, summary_ids, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(id, agentId, date, summary, JSON.stringify(["testing"]), "What did we learn?", "[]", "[]", createdAt);
	});
}

function app(userId?: string): Hono {
	const next = new Hono();
	next.use("*", async (c, next) => {
		c.set("author", { userId: null, credential: "local" });
		if (userId) {
			const principal = { ...localPrincipal(), kind: "user" as const, userId };
			bindPrincipalAccess(principal, {
				agentModel: "single",
				personalAgentsSelfService: false,
				organizationAgentId: "default",
				personalAgentId: null,
				defaultReadAgentId: null,
				agents: [{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null }],
			});
			c.set("principal", principal);
			c.set("organization", await readOrganization());
		}
		await next();
	});
	registerReflectionRoutes(next, {
		agentsDir: dir,
		getDbAccessor: () => dbAccessor,
		getInferenceProvider: () =>
			makeProvider(
				"QUESTION: Nicholai, you wrote that daily reflections should be grounded in memory, and later the route persisted one from saved context. How does that fit now?",
			),
	});
	return next;
}

beforeEach(() => {
	closeDbAccessor();
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
	dbAccessor = getDbAccessor();
	initInferenceProviderResolver(() => makeProvider("unused test provider"));
});

afterEach(async () => {
	closeInferenceProviderResolver();
	await closeDbAccessor();
	if (previousSignetPath === undefined) {
		delete process.env.SIGNET_PATH;
	} else {
		process.env.SIGNET_PATH = previousSignetPath;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("reflection routes", () => {
	it("reflection reads do not observe hidden inserts, edits, or reclassification", async () => {
		const date = new Date().toISOString().slice(0, 10);
		seedReflection("public", "default", date, "Public reflection", `${date}T08:00:00.000Z`);
		dbAccessor.withWriteTx((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'); INSERT INTO classification_audience VALUES('cls_hr','user','carol'); INSERT INTO compartments(id,key) VALUES(1,'cls_hr'); INSERT INTO compartment_members VALUES(1,'cls_hr')",
			);
		});
		const paths = ["/api/reflections?limit=1", "/api/reflections/today?limit=1"];
		const reader = app("alice");
		const snapshot = async () =>
			Promise.all(
				paths.map(async (path) => {
					const response = await reader.request(path);
					expect(response.status).toBe(200);
					return response.text();
				}),
			);
		const before = await snapshot();
		dbAccessor.withWriteTx((db) => {
			db.prepare(
				"INSERT INTO daily_reflections(id,agent_id,date,summary,patterns,memory_ids,summary_ids,created_at,compartment_id) VALUES('hidden','default',?,'Hidden reflection','[]','[]','[]',?,1)",
			).run(date, `${date}T10:00:00.000Z`);
		});
		expect(await snapshot()).toEqual(before);
		dbAccessor.withWriteTx((db) =>
			db.exec("UPDATE daily_reflections SET summary='Hidden edited',question='Restricted question' WHERE id='hidden'"),
		);
		expect(await snapshot()).toEqual(before);
		const audience = await app("carol").request(paths[0]);
		expect((await audience.json()).reflections[0].summary).toBe("Hidden edited");
		seedReflection("reclassified", "default", date, "Now hidden", `${date}T09:00:00.000Z`);
		dbAccessor.withWriteTx((db) => db.exec("UPDATE daily_reflections SET compartment_id=1 WHERE id='reclassified'"));
		expect(await snapshot()).toEqual(before);
		const absent = await reader.request("/api/reflections/missing/answer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ answer: "answer" }),
		});
		const hidden = await reader.request("/api/reflections/hidden/answer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ answer: "answer" }),
		});
		expect(hidden.status).toBe(absent.status);
		expect(await hidden.text()).toBe(await absent.text());
	});

	it("loads pipeline config from SIGNET_PATH and persists manual generation", async () => {
		const memoryId = seedMemory("agent-a");

		const res = await app().request("/api/reflections/generate?agentId=agent-a", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reflection.summary).toBe(
			"Nicholai, you wrote that daily reflections should be grounded in memory, and later the route persisted one from saved context. How does that fit now?",
		);
		expect(body.reflection.question).toBe(body.reflection.summary);
		expect(body.reflection.patterns).toEqual([]);

		const row = dbAccessor.withReadDb(
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

	it("defaults an omitted generate count to the configured daily brief count", async () => {
		seedMemory("agent-count", "Brief source material.");
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    reflections:
      enabled: true
      count: 2
      timeWindowHours: 24
      maxMemories: 10
      maxSummaries: 10
      timeout: 1000
      maxTokens: 200
      model: test-model
`,
		);

		const briefApp = new Hono();
		registerReflectionRoutes(briefApp, {
			agentsDir: dir,
			getDbAccessor: () => dbAccessor,
			getInferenceProvider: () =>
				makeProvider(
					["BRIEF: You shipped the fix and moved on.", "BRIEF: The Venice plates arrived in 02_incoming."].join("\n"),
				),
		});

		const res = await briefApp.request("/api/reflections/generate?agentId=agent-count", { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.generated).toBe(2);
		expect(body.reflections).toHaveLength(2);
	});

	it("returns all same-day brief items from the today endpoint", async () => {
		const today = new Date().toISOString().slice(0, 10);
		seedReflection("older", "agent-today", today, "Older insight", `${today}T08:00:00.000Z`);
		seedReflection("newer", "agent-today", today, "Newer insight", `${today}T09:00:00.000Z`);

		const res = await app().request("/api/reflections/today?agentId=agent-today&limit=10");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reflection.summary).toBe("Newer insight");
		expect(body.reflections.map((reflection: { summary: string }) => reflection.summary)).toEqual([
			"Newer insight",
			"Older insight",
		]);
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

		const state = dbAccessor.withReadDb((db) => {
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

		const memory = dbAccessor.withReadDb(
			(db) =>
				db.prepare("SELECT content, agent_id, memory_kind FROM memories WHERE id = ?").get(body.memoryId) as {
					content: string;
					agent_id: string;
					memory_kind: string | null;
				},
		);
		expect(memory).toEqual({ content: "Ship the scoping fix.", agent_id: "agent-b", memory_kind: "episodic" });
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

		const state = dbAccessor.withReadDb((db) => {
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

/**
 * Live Ollama test for dependency-synthesis prompt quality.
 *
 * Override model with SIGNET_OLLAMA_TEST_MODEL, for example:
 * SIGNET_OLLAMA_TEST_MODEL=nemotron-3-nano:4b bun test dependency-synthesis.test.ts
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DEPENDENCY_TYPES } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { DEFAULT_PIPELINE_V2 } from "../memory-config";
import {
	buildSynthesisPrompt,
	durableExtractionProgressFreshnessMs,
	resolveExtractionProgressAt,
	runDependencySynthesisTick,
	shouldLoadDurableExtractionProgress,
	shouldRunDependencySynthesis,
} from "./dependency-synthesis";
import { stripFences, tryParseJson } from "./extraction";

const OLLAMA = "http://localhost:11434";
// Live Ollama tests only run when SIGNET_OLLAMA_TEST_MODEL is explicitly set.
// This prevents nondeterministic failures in CI or on machines where the model
// is installed but not under test.
const EXPLICIT_MODEL = process.env.SIGNET_OLLAMA_TEST_MODEL;
const MODEL = EXPLICIT_MODEL ?? "qwen3:4b";
const VALID = new Set<string>(DEPENDENCY_TYPES);
const dbs: Database[] = [];

afterEach(() => {
	while (dbs.length > 0) {
		dbs.pop()?.close();
	}
});

function makeDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	dbs.push(db);
	return db;
}

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function seedEntity(db: Database, id: string, agentId: string, name: string, mentions = 1): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'system', ?, ?, ?, ?)`,
	).run(id, name, name.trim().toLowerCase(), agentId, mentions, now, now);
}

function seedAspectAttribute(db: Database, id: string, entityId: string, agentId: string, content: string): void {
	const now = new Date().toISOString();
	const aspectId = `asp-${id}`;
	db.prepare(
		`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, 'general', 'general', 0.5, ?, ?)`,
	).run(aspectId, entityId, agentId, now, now);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'fact', ?, ?, 0.9, 0.5, 'active', ?, ?)`,
	).run(id, aspectId, agentId, content, content.toLowerCase(), now, now);
}

function seedCompletedExtractionJob(db: Database, id: string, agentId: string, completedAt: string): void {
	const now = new Date().toISOString();
	const memoryId = `mem-${id}`;
	db.prepare(
		`INSERT INTO memories (id, content, type, agent_id, created_at, updated_at, updated_by, vector_clock)
		 VALUES (?, 'completed extraction source', 'fact', ?, ?, ?, 'test', '{}')`,
	).run(memoryId, agentId, now, now);
	db.prepare(
		`INSERT INTO memory_jobs (id, memory_id, job_type, status, completed_at, created_at, updated_at)
		 VALUES (?, ?, 'extract', 'completed', ?, ?, ?)`,
	).run(id, memoryId, completedAt, now, now);
}

async function ollamaAvailable(): Promise<boolean> {
	try {
		const resp = await fetch(`${OLLAMA}/api/tags`);
		const data = (await resp.json()) as { models: Array<{ name: string }> };
		return data.models.some((m) => m.name === MODEL);
	} catch {
		return false;
	}
}

async function generate(prompt: string): Promise<string> {
	const resp = await fetch(`${OLLAMA}/api/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			prompt,
			stream: false,
			options: { temperature: 0.1 },
		}),
	});
	return ((await resp.json()) as { response: string }).response;
}

interface SynthDep {
	readonly target: string;
	readonly depType: string;
	readonly reason: string;
}

function extract(raw: string): readonly SynthDep[] {
	const parsed = tryParseJson(stripFences(raw));
	if (!Array.isArray(parsed)) return [];

	const out: SynthDep[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const obj = item as Record<string, unknown>;
		const target = typeof obj.target === "string" ? obj.target.trim() : "";
		const depType = typeof obj.dep_type === "string" ? obj.dep_type.trim() : "";
		const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
		if (target.length === 0 || !VALID.has(depType)) continue;
		out.push({ target, depType, reason });
	}
	return out;
}

const entity = {
	id: "ent-auth",
	name: "auth service",
	entityType: "system",
};

const facts = [
	"auth service uses Redis for rate limiting and ephemeral session state",
	"auth service is owned by the platform team",
	"auth service informs the audit log of every login attempt",
];

const candidates = [
	{ id: "ent-redis", name: "Redis", entityType: "system", mentions: 9 },
	{ id: "ent-platform", name: "platform team", entityType: "person", mentions: 7 },
	{ id: "ent-audit", name: "audit log", entityType: "system", mentions: 6 },
];

describe(`${MODEL} dependency synthesis`, () => {
	test("pauses when extraction progress is older than the configured stall window", () => {
		const now = 10_000;
		expect(shouldRunDependencySynthesis(now, 3_999, 6_000)).toBe(false);
		expect(shouldRunDependencySynthesis(now, 4_000, 6_000)).toBe(true);
	});

	test("keeps running when the stall gate is disabled or progress is unknown", () => {
		const now = 10_000;
		expect(shouldRunDependencySynthesis(now, 1_000, 0)).toBe(true);
		expect(shouldRunDependencySynthesis(now, undefined, 6_000)).toBe(true);
		expect(shouldRunDependencySynthesis(now, 0, 6_000)).toBe(true);
	});

	test("uses durable extraction progress when worker progress is unavailable", () => {
		expect(resolveExtractionProgressAt(undefined, 5_000)).toBe(5_000);
		expect(resolveExtractionProgressAt(6_000, 5_000)).toBe(6_000);
		expect(resolveExtractionProgressAt(0, undefined)).toBeUndefined();
	});

	test("skips durable progress reads while worker progress is fresh", () => {
		const now = 10_000;
		expect(shouldLoadDurableExtractionProgress(now, 9_000, 2_000)).toBe(false);
		expect(shouldLoadDurableExtractionProgress(now, 7_999, 2_000)).toBe(true);
		expect(shouldLoadDurableExtractionProgress(now, undefined, 2_000)).toBe(true);
	});

	test("caps durable progress freshness by the stall window", () => {
		expect(durableExtractionProgressFreshnessMs(3_600_000, 60_000)).toBe(30_000);
		expect(durableExtractionProgressFreshnessMs(10_000, 60_000)).toBe(10_000);
		expect(durableExtractionProgressFreshnessMs(10_000, 1)).toBe(1);
	});

	test("uses DB-backed extraction progress to skip stale synthesis and resume when recent", async () => {
		const db = makeDb();
		const accessor = makeAccessor(db);
		seedEntity(db, "agent-b-src", "agent-b", "agent b source");
		seedEntity(db, "agent-b-target", "agent-b", "agent b target", 5);
		seedAspectAttribute(db, "agent-b-fact", "agent-b-src", "agent-b", "agent b source uses agent b target");
		seedCompletedExtractionJob(db, "job-stale", "agent-b", new Date(Date.now() - 120_000).toISOString());

		let calls = 0;
		const deps = {
			accessor,
			agentId: "agent-b",
			provider: {
				name: "test",
				available: async () => true,
				generate: async () => {
					calls += 1;
					return JSON.stringify([{ target: "agent b target", dep_type: "uses", reason: "source uses target" }]);
				},
			},
			pipelineCfg: {
				...DEFAULT_PIPELINE_V2,
				structural: {
					...DEFAULT_PIPELINE_V2.structural,
					dependencyBatchSize: 1,
					synthesisMaxStallMs: 60_000,
				},
			},
		};

		await runDependencySynthesisTick(deps);
		expect(calls).toBe(0);
		expect(db.prepare("SELECT COUNT(*) AS n FROM entity_dependencies").get()).toEqual({ n: 0 });

		db.prepare("UPDATE memory_jobs SET completed_at = ? WHERE id = 'job-stale'").run(
			new Date().toISOString().replace("Z", "+00:00"),
		);
		await runDependencySynthesisTick(deps);
		expect(calls).toBe(1);
		expect(db.prepare("SELECT source_entity_id, target_entity_id FROM entity_dependencies").get()).toEqual({
			source_entity_id: "agent-b-src",
			target_entity_id: "agent-b-target",
		});
	});

	test("synthesizes dependencies only within the requested agent scope", async () => {
		const db = makeDb();
		const accessor = makeAccessor(db);
		seedEntity(db, "default-src", "default", "default source");
		seedEntity(db, "default-target", "default", "shared target", 5);
		seedAspectAttribute(db, "default-fact", "default-src", "default", "default source uses shared target");
		seedEntity(db, "agent-b-src", "agent-b", "agent b source");
		seedEntity(db, "agent-b-target", "agent-b", "agent b shared target", 5);
		db.prepare("UPDATE entities SET canonical_name = 'shared target' WHERE id = 'agent-b-target'").run();
		seedAspectAttribute(db, "agent-b-fact", "agent-b-src", "agent-b", "agent b source uses shared target");

		await runDependencySynthesisTick({
			accessor,
			agentId: "agent-b",
			provider: {
				name: "test",
				available: async () => true,
				generate: async () =>
					JSON.stringify([{ target: "shared target", dep_type: "uses", reason: "source uses target" }]),
			},
			pipelineCfg: {
				...DEFAULT_PIPELINE_V2,
				structural: {
					...DEFAULT_PIPELINE_V2.structural,
					dependencyBatchSize: 2,
					synthesisMaxStallMs: 0,
				},
			},
		});

		const defaultRow = db.prepare("SELECT last_synthesized_at FROM entities WHERE id = 'default-src'").get() as {
			last_synthesized_at: string | null;
		};
		const agentBRow = db.prepare("SELECT last_synthesized_at FROM entities WHERE id = 'agent-b-src'").get() as {
			last_synthesized_at: string | null;
		};
		const deps = db
			.prepare("SELECT agent_id, source_entity_id, target_entity_id FROM entity_dependencies ORDER BY agent_id")
			.all() as Array<{ agent_id: string; source_entity_id: string; target_entity_id: string }>;

		expect(defaultRow.last_synthesized_at).toBeNull();
		expect(typeof agentBRow.last_synthesized_at).toBe("string");
		expect(deps).toEqual([
			{
				agent_id: "agent-b",
				source_entity_id: "agent-b-src",
				target_entity_id: "agent-b-target",
			},
		]);
	});

	test("prompt encodes candidate boundary and empty-array rules", () => {
		const prompt = buildSynthesisPrompt(entity, facts, candidates, new Set(["Redis"]));
		expect(prompt).toContain("Only connect auth service to entities from the known entity list above");
		expect(prompt).toContain("If no supported connection is stated, return []");
		expect(prompt).toContain("Do not repeat already-connected entities unless the dependency type differs");
	});

	test("prompt yields expected edges for known candidates", async () => {
		if (!EXPLICIT_MODEL) {
			console.log("SKIP: set SIGNET_OLLAMA_TEST_MODEL to run live Ollama tests");
			return;
		}
		const available = await ollamaAvailable();
		if (!available) {
			console.log(`SKIP: ${MODEL} not available on Ollama`);
			return;
		}

		const prompt = buildSynthesisPrompt(entity, facts, candidates, new Set());

		let best: readonly SynthDep[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			const deps = extract(await generate(prompt));
			if (deps.length > best.length) best = deps;
			if (best.length >= 3) break;
		}

		const seen = new Set(best.map((d) => `${d.target}|${d.depType}`));
		console.log(best);

		expect(seen.has("Redis|uses")).toBe(true);
		expect(seen.has("platform team|owned_by")).toBe(true);
		expect(seen.has("audit log|informs")).toBe(true);
		for (const dep of best) {
			expect(dep.reason.length).toBeGreaterThan(0);
		}
	}, 120_000);
});

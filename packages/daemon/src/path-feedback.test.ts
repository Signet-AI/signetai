import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@signet/core";

const TEST_DIR = join(tmpdir(), `signet-path-feedback-test-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { initDbAccessor, closeDbAccessor, getDbAccessor } = await import("./db-accessor");
const { recordPathFeedback } = await import("./path-feedback");

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function setupDb(): Database {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	ensureDir(join(TEST_DIR, "memory"));
	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	closeDbAccessor();
	initDbAccessor(dbPath);
	return db;
}

function seedGraph(db: Database): void {
	const ts = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at, updated_by, vector_clock, is_deleted)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0)`,
	).run("mem-a", "A memory", ts, ts);
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
	).run("ent-a", "Entity A", "entity a", ts, ts);
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, 'project', 'default', 1, ?, ?)`,
	).run("ent-b", "Entity B", "entity b", ts, ts);
	db.prepare(
		`INSERT INTO entity_aspects
		 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, 'default', 'timeline', 'timeline', 0.5, ?, ?)`,
	).run("asp-a", "ent-a", ts, ts);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, 'default', ?, 'attribute', 'x', 'x', 1, 0.8, 'active', ?, ?)`,
	).run("attr-a", "asp-a", "mem-a", ts, ts);
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason, created_at, updated_at)
		 VALUES (?, ?, ?, 'default', 'related_to', 0.5, 0.7, 'single-memory', ?, ?)`,
	).run("dep-a", "ent-a", "ent-b", ts, ts);
	db.prepare(
		`INSERT INTO session_memories
		 (id, session_key, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at, path_json)
		 VALUES (?, ?, ?, 'ka_traversal', 0.8, 0.8, 0, 1, 0, ?, ?)`,
	).run(
		"sm-a",
		"sess-a",
		"mem-a",
		ts,
		JSON.stringify({
			entity_ids: ["ent-a", "ent-b"],
			aspect_ids: ["asp-a"],
			dependency_ids: ["dep-a"],
		}),
	);
}

function seedSessionMemory(
	db: Database,
	sessionKey: string,
	memoryId: string,
	pathJson: string | null = null,
	agentId = "default",
): void {
	const ts = new Date().toISOString();
	db.prepare(
		`INSERT INTO session_memories
		 (id, session_key, agent_id, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at, path_json)
		 VALUES (?, ?, ?, ?, 'ka_traversal', 0.8, 0.8, 0, 1, 0, ?, ?)`,
	).run(`sm-${sessionKey}-${memoryId}-${agentId}`, sessionKey, agentId, memoryId, ts, pathJson);
}

let db: Database;

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
	ensureDir(TEST_DIR);
	db = setupDb();
	seedGraph(db);
});

afterEach(() => {
	db.close();
	closeDbAccessor();
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("recordPathFeedback", () => {
	it("writes event/stats and propagates aspect + dependency updates", () => {
		const result = recordPathFeedback(getDbAccessor(), {
			sessionKey: "sess-a",
			agentId: "default",
			ratings: { "mem-a": 1 },
			rewards: { "mem-a": { forward_citation: 1 } },
		});

		expect(result.accepted).toBe(1);
		expect(result.propagated).toBe(1);

		const event = db
			.prepare("SELECT rating, reward_forward FROM path_feedback_events WHERE memory_id = ?")
			.get("mem-a") as { rating: number; reward_forward: number } | undefined;
		expect(event).toBeDefined();
		expect(event?.rating).toBe(1);
		expect(event?.reward_forward).toBe(1);

		const stats = db.prepare("SELECT sample_count, positive_count FROM path_feedback_stats LIMIT 1").get() as
			| { sample_count: number; positive_count: number }
			| undefined;
		expect(stats?.sample_count).toBe(1);
		expect(stats?.positive_count).toBe(1);

		const aspect = db.prepare("SELECT weight FROM entity_aspects WHERE id = 'asp-a'").get() as
			| { weight: number }
			| undefined;
		expect(aspect?.weight).toBeGreaterThan(0.5);

		const dep = db.prepare("SELECT strength, reason FROM entity_dependencies WHERE id = 'dep-a'").get() as
			| { strength: number; reason: string }
			| undefined;
		expect(dep?.strength).toBeGreaterThan(0.5);
		expect(dep?.reason).toBe("pattern-matched");

		const hist = db
			.prepare(
				`SELECT event, changed_by, metadata
				 FROM entity_dependency_history
				 WHERE dependency_id = 'dep-a'
				   AND event = 'updated'
				 ORDER BY rowid DESC
				 LIMIT 1`,
			)
			.get() as
			| { event: string; changed_by: string; metadata: string | null }
			| undefined;
		expect(hist?.event).toBe("updated");
		expect(hist?.changed_by).toBe("db-trigger");
		expect(hist?.metadata).toContain("trg_entity_dependencies_audit_update");
	});

	it("skips IDs that do not belong to the rated session", () => {
		const result = recordPathFeedback(getDbAccessor(), {
			sessionKey: "sess-a",
			agentId: "default",
			ratings: { ghost: 1 },
			paths: {
				ghost: {
					entity_ids: ["ent-a", "ent-b"],
					aspect_ids: ["asp-a"],
					dependency_ids: ["dep-a"],
				},
			},
		});

		expect(result.accepted).toBe(0);
		expect(result.propagated).toBe(0);

		const events = db.prepare("SELECT COUNT(*) AS cnt FROM path_feedback_events WHERE memory_id = 'ghost'").get() as
			| { cnt: number }
			| undefined;
		expect(events?.cnt).toBe(0);
	});

	it("skips IDs recorded for a different agent with same session key", () => {
		seedSessionMemory(db, "sess-shared", "mem-a", null, "agent-b");

		const result = recordPathFeedback(getDbAccessor(), {
			sessionKey: "sess-shared",
			agentId: "agent-a",
			ratings: { "mem-a": 1 },
			paths: {
				"mem-a": {
					entity_ids: ["ent-a"],
					aspect_ids: ["asp-a"],
					dependency_ids: ["dep-a"],
				},
			},
		});

		expect(result.accepted).toBe(0);
		expect(result.propagated).toBe(0);
	});

	it("assigns a default reason when positive feedback hits NULL reason", () => {
		const ts = new Date().toISOString();
		db.prepare(
			`INSERT INTO entity_dependencies
			 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason, created_at, updated_at)
			 VALUES ('dep-null', 'ent-a', 'ent-b', 'default', 'depends_on', 0.4, 0.4, NULL, ?, ?)`,
		).run(ts, ts);

		const result = recordPathFeedback(getDbAccessor(), {
			sessionKey: "sess-a",
			agentId: "default",
			ratings: { "mem-a": 1 },
			paths: {
				"mem-a": {
					entity_ids: ["ent-a", "ent-b"],
					aspect_ids: [],
					dependency_ids: ["dep-null"],
				},
			},
		});
		expect(result.accepted).toBe(1);
		expect(result.propagated).toBe(1);

		const dep = db.prepare("SELECT reason, confidence FROM entity_dependencies WHERE id = 'dep-null'").get() as
			| { reason: string | null; confidence: number }
			| undefined;
		expect(dep?.reason).toBe("single-memory");
		expect(dep?.confidence).toBeGreaterThanOrEqual(0.7);
	});

	it("promotes co-occurrence edge after repeated sessions", () => {
		for (const key of ["sess-co-1", "sess-co-2", "sess-co-3"]) {
			seedSessionMemory(db, key, "mem-a");
			recordPathFeedback(getDbAccessor(), {
				sessionKey: key,
				agentId: "default",
				ratings: { "mem-a": 1 },
				paths: {
					"mem-a": {
						entity_ids: ["ent-a", "ent-b"],
						aspect_ids: [],
						dependency_ids: [],
					},
				},
			});
		}

		const forward = db
			.prepare(
				`SELECT reason, confidence
				 FROM entity_dependencies
				 WHERE source_entity_id = 'ent-a'
				   AND target_entity_id = 'ent-b'
				   AND dependency_type = 'related_to'
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.get() as { reason: string; confidence: number } | undefined;
		expect(forward).toBeDefined();
		expect(forward?.reason).toBe("pattern-matched");
		expect(forward?.confidence).toBeGreaterThanOrEqual(0.5);

		const forwardHist = db
			.prepare(
				`SELECT event, changed_by, metadata
				 FROM entity_dependency_history
				 WHERE source_entity_id = 'ent-a'
				   AND target_entity_id = 'ent-b'
				 ORDER BY created_at DESC
				 LIMIT 1`,
			)
			.get() as
			| { event: string; changed_by: string; metadata: string | null }
			| undefined;
		expect(forwardHist?.changed_by).toBe("db-trigger");
		expect(forwardHist?.metadata).toContain("trg_entity_dependencies_audit_insert");

		const reverse = db
			.prepare(
				`SELECT reason, confidence
				 FROM entity_dependencies
				 WHERE source_entity_id = 'ent-b'
				   AND target_entity_id = 'ent-a'
				   AND dependency_type = 'related_to'
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.get() as { reason: string; confidence: number } | undefined;
		expect(reverse).toBeDefined();
		expect(reverse?.reason).toBe("pattern-matched");
		expect(reverse?.confidence).toBeGreaterThanOrEqual(0.5);
	});
});

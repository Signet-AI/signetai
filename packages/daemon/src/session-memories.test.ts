/**
 * Tests for session memory candidate recording and FTS hit tracking.
 *
 * Uses an in-memory SQLite database with full migrations so the schema
 * matches production exactly.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `signet-session-mem-test-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { initDbAccessor, closeDbAccessor } = await import("./db-accessor");
const {
	recordSessionCandidates,
	trackFtsHits,
	parseFeedback,
	recordAgentFeedbackInner,
} = await import("./session-memories");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

	const now = new Date().toISOString();
	const stmt = db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0)`,
	);
	stmt.run("mem-aaa-111", "User prefers dark mode", now, now);
	stmt.run("mem-bbb-222", "Project uses TypeScript", now, now);
	stmt.run("mem-ccc-333", "Bun is the package manager", now, now);

	closeDbAccessor();
	initDbAccessor(dbPath);

	return db;
}

function openTestDb(): Database {
	return new Database(join(TEST_DIR, "memory", "memories.db"));
}

function getSessionMemoryRows(
	db: Database,
	sessionKey: string,
): Array<{
	id: string;
	session_key: string;
	memory_id: string;
	source: string;
	effective_score: number | null;
	final_score: number;
	rank: number;
	was_injected: number;
	relevance_score: number | null;
	fts_hit_count: number;
}> {
	return db
		.prepare(
			`SELECT id, session_key, memory_id, source, effective_score,
			        final_score, rank, was_injected, relevance_score, fts_hit_count
			 FROM session_memories WHERE session_key = ? ORDER BY rank ASC`,
		)
		.all(sessionKey) as Array<{
		id: string;
		session_key: string;
		memory_id: string;
		source: string;
		effective_score: number | null;
		final_score: number;
		rank: number;
		was_injected: number;
		relevance_score: number | null;
		fts_hit_count: number;
	}>;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
	ensureDir(TEST_DIR);
	db = setupDb();
});

afterEach(() => {
	db.close();
	closeDbAccessor();
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// recordSessionCandidates
// ============================================================================

describe("recordSessionCandidates", () => {
	it("inserts candidate rows with correct was_injected flags", () => {
		const candidates = [
			{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const },
			{ id: "mem-bbb-222", effScore: 0.7, source: "effective" as const },
			{ id: "mem-ccc-333", effScore: 0.4, source: "effective" as const },
		];
		const injectedIds = new Set(["mem-aaa-111", "mem-bbb-222"]);

		recordSessionCandidates("session-001", candidates, injectedIds);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-001");
		testDb.close();

		expect(rows.length).toBe(3);

		const injected = rows.filter((r) => r.was_injected === 1);
		const notInjected = rows.filter((r) => r.was_injected === 0);
		expect(injected.length).toBe(2);
		expect(notInjected.length).toBe(1);
		expect(notInjected[0].memory_id).toBe("mem-ccc-333");
	});

	it("sets rank in order", () => {
		const candidates = [
			{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const },
			{ id: "mem-bbb-222", effScore: 0.7, source: "effective" as const },
		];

		recordSessionCandidates(
			"session-002",
			candidates,
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-002");
		testDb.close();

		expect(rows[0].rank).toBe(0);
		expect(rows[1].rank).toBe(1);
	});

	it("stores effective_score and final_score", () => {
		const candidates = [
			{ id: "mem-aaa-111", effScore: 0.85, source: "effective" as const },
		];

		recordSessionCandidates(
			"session-003",
			candidates,
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-003");
		testDb.close();

		expect(rows[0].effective_score).toBeCloseTo(0.85, 2);
		expect(rows[0].final_score).toBeCloseTo(0.85, 2);
	});

	it("is idempotent (INSERT OR IGNORE on duplicate session+memory)", () => {
		const candidates = [
			{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const },
		];

		recordSessionCandidates(
			"session-004",
			candidates,
			new Set(["mem-aaa-111"]),
		);
		recordSessionCandidates(
			"session-004",
			candidates,
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-004");
		testDb.close();

		expect(rows.length).toBe(1);
	});

	it("bails on undefined sessionKey", () => {
		const candidates = [
			{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const },
		];

		recordSessionCandidates(undefined, candidates, new Set(["mem-aaa-111"]));

		const testDb = openTestDb();
		const count = testDb
			.prepare("SELECT COUNT(*) as cnt FROM session_memories")
			.get() as { cnt: number };
		testDb.close();

		expect(count.cnt).toBe(0);
	});

	it("bails on empty candidates array", () => {
		recordSessionCandidates("session-005", [], new Set());

		const testDb = openTestDb();
		const count = testDb
			.prepare("SELECT COUNT(*) as cnt FROM session_memories")
			.get() as { cnt: number };
		testDb.close();

		expect(count.cnt).toBe(0);
	});

	it("sets source field correctly", () => {
		const candidates = [
			{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const },
		];

		recordSessionCandidates(
			"session-006",
			candidates,
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-006");
		testDb.close();

		expect(rows[0].source).toBe("effective");
	});
});

// ============================================================================
// trackFtsHits
// ============================================================================

describe("trackFtsHits", () => {
	it("increments fts_hit_count for existing candidate rows", () => {
		recordSessionCandidates(
			"session-fts-1",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		trackFtsHits("session-fts-1", ["mem-aaa-111"]);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-fts-1");
		testDb.close();

		expect(rows.length).toBe(1);
		expect(rows[0].fts_hit_count).toBe(1);
		expect(rows[0].source).toBe("effective");
	});

	it("increments multiple times", () => {
		recordSessionCandidates(
			"session-fts-2",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		trackFtsHits("session-fts-2", ["mem-aaa-111"]);
		trackFtsHits("session-fts-2", ["mem-aaa-111"]);
		trackFtsHits("session-fts-2", ["mem-aaa-111"]);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-fts-2");
		testDb.close();

		expect(rows[0].fts_hit_count).toBe(3);
	});

	it("creates fts_only rows for memories not in candidate pool", () => {
		trackFtsHits("session-fts-3", ["mem-bbb-222"]);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-fts-3");
		testDb.close();

		expect(rows.length).toBe(1);
		expect(rows[0].memory_id).toBe("mem-bbb-222");
		expect(rows[0].source).toBe("fts_only");
		expect(rows[0].was_injected).toBe(0);
		expect(rows[0].fts_hit_count).toBe(1);
	});

	it("bails on undefined sessionKey", () => {
		trackFtsHits(undefined, ["mem-aaa-111"]);

		const testDb = openTestDb();
		const count = testDb
			.prepare("SELECT COUNT(*) as cnt FROM session_memories")
			.get() as { cnt: number };
		testDb.close();

		expect(count.cnt).toBe(0);
	});

	it("bails on empty matchedIds", () => {
		trackFtsHits("session-fts-4", []);

		const testDb = openTestDb();
		const count = testDb
			.prepare("SELECT COUNT(*) as cnt FROM session_memories")
			.get() as { cnt: number };
		testDb.close();

		expect(count.cnt).toBe(0);
	});

	it("handles mix of existing and new memory IDs", () => {
		recordSessionCandidates(
			"session-fts-5",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		trackFtsHits("session-fts-5", ["mem-aaa-111", "mem-bbb-222"]);

		const testDb = openTestDb();
		const rows = getSessionMemoryRows(testDb, "session-fts-5");
		testDb.close();

		expect(rows.length).toBe(2);

		const existing = rows.find((r) => r.memory_id === "mem-aaa-111");
		const newRow = rows.find((r) => r.memory_id === "mem-bbb-222");

		expect(existing).toBeDefined();
		expect(existing!.fts_hit_count).toBe(1);
		expect(existing!.source).toBe("effective");

		expect(newRow).toBeDefined();
		expect(newRow!.fts_hit_count).toBe(1);
		expect(newRow!.source).toBe("fts_only");
	});
});

// ============================================================================
// parseFeedback
// ============================================================================

describe("parseFeedback", () => {
	it("returns null for null/undefined input", () => {
		expect(parseFeedback(null)).toBeNull();
		expect(parseFeedback(undefined)).toBeNull();
	});

	it("returns null for non-object input", () => {
		expect(parseFeedback("string")).toBeNull();
		expect(parseFeedback(42)).toBeNull();
		expect(parseFeedback(true)).toBeNull();
		expect(parseFeedback([])).toBeNull();
	});

	it("returns null for empty object", () => {
		expect(parseFeedback({})).toBeNull();
	});

	it("returns null when all values are invalid types", () => {
		expect(parseFeedback({ mem1: "high", mem2: true })).toBeNull();
	});

	it("parses valid feedback", () => {
		const result = parseFeedback({ mem1: 0.8, mem2: -0.5, mem3: 0 });
		expect(result).toEqual({ mem1: 0.8, mem2: -0.5, mem3: 0 });
	});

	it("clamps scores to [-1, 1]", () => {
		const result = parseFeedback({ mem1: 5.0, mem2: -3.0 });
		expect(result).toEqual({ mem1: 1.0, mem2: -1.0 });
	});

	it("skips entries with invalid values but keeps valid ones", () => {
		const result = parseFeedback({
			good: 0.5,
			bad_string: "nope",
			bad_bool: true,
			bad_nan: NaN,
			bad_inf: Infinity,
			also_good: -0.3,
		});
		expect(result).toEqual({ good: 0.5, also_good: -0.3 });
	});

	it("skips empty string keys", () => {
		const result = parseFeedback({ "": 0.5, valid: 0.8 });
		expect(result).toEqual({ valid: 0.8 });
	});
});

// ============================================================================
// recordAgentFeedbackInner (running mean accumulation)
// ============================================================================

/** Read feedback columns for a session memory. */
function getFeedbackColumns(
	testDb: Database,
	sessionKey: string,
	memoryId: string,
): { agent_relevance_score: number | null; agent_feedback_count: number } | undefined {
	return testDb
		.prepare(
			`SELECT agent_relevance_score, agent_feedback_count
			 FROM session_memories
			 WHERE session_key = ? AND memory_id = ?`,
		)
		.get(sessionKey, memoryId) as
		| { agent_relevance_score: number | null; agent_feedback_count: number }
		| undefined;
}

describe("recordAgentFeedbackInner", () => {
	it("sets score on first feedback (NULL -> score)", () => {
		recordSessionCandidates(
			"session-fb-1",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		recordAgentFeedbackInner(testDb, "session-fb-1", { "mem-aaa-111": 0.8 });

		const result = getFeedbackColumns(testDb, "session-fb-1", "mem-aaa-111");
		testDb.close();

		expect(result).toBeDefined();
		expect(result!.agent_relevance_score).toBeCloseTo(0.8, 6);
		expect(result!.agent_feedback_count).toBe(1);
	});

	it("computes running mean on second feedback", () => {
		recordSessionCandidates(
			"session-fb-2",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		recordAgentFeedbackInner(testDb, "session-fb-2", { "mem-aaa-111": 0.8 });
		recordAgentFeedbackInner(testDb, "session-fb-2", { "mem-aaa-111": 0.4 });

		const result = getFeedbackColumns(testDb, "session-fb-2", "mem-aaa-111");
		testDb.close();

		// mean = (0.8 * 1 + 0.4) / 2 = 0.6
		expect(result!.agent_relevance_score).toBeCloseTo(0.6, 6);
		expect(result!.agent_feedback_count).toBe(2);
	});

	it("multiple feedbacks converge to the mean", () => {
		recordSessionCandidates(
			"session-fb-3",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		const scores = [0.9, 0.7, 0.5, 0.3, 0.1];
		for (const s of scores) {
			recordAgentFeedbackInner(testDb, "session-fb-3", { "mem-aaa-111": s });
		}

		const result = getFeedbackColumns(testDb, "session-fb-3", "mem-aaa-111");
		testDb.close();

		const expectedMean = scores.reduce((a, b) => a + b, 0) / scores.length;
		expect(result!.agent_relevance_score).toBeCloseTo(expectedMean, 4);
		expect(result!.agent_feedback_count).toBe(5);
	});

	it("handles multiple memories in one feedback call", () => {
		recordSessionCandidates(
			"session-fb-4",
			[
				{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const },
				{ id: "mem-bbb-222", effScore: 0.7, source: "effective" as const },
			],
			new Set(["mem-aaa-111", "mem-bbb-222"]),
		);

		const testDb = openTestDb();
		recordAgentFeedbackInner(testDb, "session-fb-4", {
			"mem-aaa-111": 0.9,
			"mem-bbb-222": -0.5,
		});

		const a = getFeedbackColumns(testDb, "session-fb-4", "mem-aaa-111");
		const b = getFeedbackColumns(testDb, "session-fb-4", "mem-bbb-222");
		testDb.close();

		expect(a!.agent_relevance_score).toBeCloseTo(0.9, 6);
		expect(b!.agent_relevance_score).toBeCloseTo(-0.5, 6);
	});

	it("ignores feedback for non-existent session memories", () => {
		recordSessionCandidates(
			"session-fb-5",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		// mem-ghost doesn't exist — UPDATE matches 0 rows, no crash
		recordAgentFeedbackInner(testDb, "session-fb-5", {
			"mem-aaa-111": 0.5,
			"mem-ghost": 0.9,
		});

		const real = getFeedbackColumns(testDb, "session-fb-5", "mem-aaa-111");
		const ghost = getFeedbackColumns(testDb, "session-fb-5", "mem-ghost");
		testDb.close();

		expect(real!.agent_relevance_score).toBeCloseTo(0.5, 6);
		expect(ghost).toBeFalsy();
	});

	it("feedback for wrong session does not affect other sessions", () => {
		recordSessionCandidates(
			"session-fb-6a",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);
		recordSessionCandidates(
			"session-fb-6b",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		recordAgentFeedbackInner(testDb, "session-fb-6a", { "mem-aaa-111": 0.7 });

		const a = getFeedbackColumns(testDb, "session-fb-6a", "mem-aaa-111");
		const b = getFeedbackColumns(testDb, "session-fb-6b", "mem-aaa-111");
		testDb.close();

		expect(a!.agent_relevance_score).toBeCloseTo(0.7, 6);
		expect(b!.agent_relevance_score).toBeNull();
	});

	it("handles negative scores correctly", () => {
		recordSessionCandidates(
			"session-fb-7",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		recordAgentFeedbackInner(testDb, "session-fb-7", { "mem-aaa-111": -0.8 });
		recordAgentFeedbackInner(testDb, "session-fb-7", { "mem-aaa-111": -0.4 });

		const result = getFeedbackColumns(testDb, "session-fb-7", "mem-aaa-111");
		testDb.close();

		// mean = (-0.8 * 1 + (-0.4)) / 2 = -0.6
		expect(result!.agent_relevance_score).toBeCloseTo(-0.6, 6);
		expect(result!.agent_feedback_count).toBe(2);
	});

	it("empty feedback object is a no-op", () => {
		recordSessionCandidates(
			"session-fb-8",
			[{ id: "mem-aaa-111", effScore: 0.9, source: "effective" as const }],
			new Set(["mem-aaa-111"]),
		);

		const testDb = openTestDb();
		recordAgentFeedbackInner(testDb, "session-fb-8", {});

		const result = getFeedbackColumns(testDb, "session-fb-8", "mem-aaa-111");
		testDb.close();

		expect(result!.agent_relevance_score).toBeNull();
		expect(result!.agent_feedback_count).toBe(0);
	});
});

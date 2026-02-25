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
const { recordSessionCandidates, trackFtsHits } = await import(
	"./session-memories"
);

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

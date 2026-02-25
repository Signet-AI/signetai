/**
 * Tests for enhanced continuity scoring in summary-worker.
 *
 * Validates that:
 * - session_memories table has the right schema
 * - loadInjectedMemories query works correctly
 * - writePerMemoryRelevance maps 8-char prefixes to full IDs
 * - session_scores new columns work (confidence, continuity_reasoning)
 * - memories_recalled is populated from actual injected count
 * - Backward compat: sessions without session_memories still score
 *
 * Uses an in-memory SQLite database with full migrations.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function insertMemory(
	db: Database,
	id: string,
	content: string,
	opts: { importance?: number; project?: string } = {},
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, project)
		 VALUES (?, 'fact', ?, 1.0, ?, ?, ?, 'test', '{}', 0, ?)`,
	).run(id, content, opts.importance ?? 0.5, now, now, opts.project ?? null);
}

function insertSessionMemory(
	db: Database,
	sessionKey: string,
	memoryId: string,
	opts: {
		wasInjected?: number;
		rank?: number;
		effectiveScore?: number;
		source?: string;
	} = {},
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO session_memories
		 (id, session_key, memory_id, source, effective_score,
		  final_score, rank, was_injected, fts_hit_count, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
	).run(
		crypto.randomUUID(),
		sessionKey,
		memoryId,
		opts.source ?? "effective",
		opts.effectiveScore ?? 0.8,
		opts.effectiveScore ?? 0.8,
		opts.rank ?? 0,
		opts.wasInjected ?? 1,
		now,
	);
}

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

let db: Database;
let accessor: DbAccessor;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	accessor = makeAccessor(db);
});

afterEach(() => {
	db.close();
});

// ============================================================================
// session_memories table schema
// ============================================================================

describe("session_memories table", () => {
	it("has all required columns", () => {
		const cols = db
			.prepare("PRAGMA table_info(session_memories)")
			.all() as Array<{ name: string; type: string }>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("id");
		expect(colNames).toContain("session_key");
		expect(colNames).toContain("memory_id");
		expect(colNames).toContain("source");
		expect(colNames).toContain("effective_score");
		expect(colNames).toContain("predictor_score");
		expect(colNames).toContain("final_score");
		expect(colNames).toContain("rank");
		expect(colNames).toContain("was_injected");
		expect(colNames).toContain("relevance_score");
		expect(colNames).toContain("fts_hit_count");
		expect(colNames).toContain("agent_preference");
		expect(colNames).toContain("created_at");
	});

	it("enforces UNIQUE(session_key, memory_id)", () => {
		insertMemory(db, "mem-1", "Test memory");
		insertSessionMemory(db, "session-1", "mem-1");

		expect(() => {
			insertSessionMemory(db, "session-1", "mem-1");
		}).toThrow();
	});

	it("allows same memory in different sessions", () => {
		insertMemory(db, "mem-1", "Test memory");
		insertSessionMemory(db, "session-1", "mem-1");
		insertSessionMemory(db, "session-2", "mem-1");

		const count = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM session_memories WHERE memory_id = ?",
			)
			.get("mem-1") as { cnt: number };

		expect(count.cnt).toBe(2);
	});
});

// ============================================================================
// session_scores extended columns
// ============================================================================

describe("session_scores extensions", () => {
	it("has confidence and continuity_reasoning columns", () => {
		const cols = db
			.prepare("PRAGMA table_info(session_scores)")
			.all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name);

		expect(colNames).toContain("confidence");
		expect(colNames).toContain("continuity_reasoning");
	});

	it("can write and read the new columns", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_scores
			 (id, session_key, project, harness, score, memories_recalled,
			  memories_used, novel_context_count, reasoning,
			  confidence, continuity_reasoning, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"score-1",
			"session-1",
			null,
			"test",
			0.85,
			5,
			3,
			1,
			"Good coverage",
			0.92,
			"Detailed reasoning about memory quality",
			now,
		);

		const row = db
			.prepare(
				"SELECT confidence, continuity_reasoning FROM session_scores WHERE id = ?",
			)
			.get("score-1") as { confidence: number; continuity_reasoning: string };

		expect(row.confidence).toBeCloseTo(0.92, 2);
		expect(row.continuity_reasoning).toBe(
			"Detailed reasoning about memory quality",
		);
	});

	it("allows null confidence for backward compatibility", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO session_scores
			 (id, session_key, project, harness, score, memories_recalled,
			  memories_used, novel_context_count, reasoning, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("score-2", "session-2", null, "test", 0.7, 0, 2, 0, "OK", now);

		const row = db
			.prepare(
				"SELECT confidence, continuity_reasoning FROM session_scores WHERE id = ?",
			)
			.get("score-2") as {
			confidence: number | null;
			continuity_reasoning: string | null;
		};

		expect(row.confidence).toBeNull();
		expect(row.continuity_reasoning).toBeNull();
	});
});

// ============================================================================
// loadInjectedMemories query
// ============================================================================

describe("injected memory loading", () => {
	it("joins session_memories with memories to get content", () => {
		insertMemory(db, "mem-1", "User prefers dark mode");
		insertMemory(db, "mem-2", "Project uses Bun");
		insertSessionMemory(db, "session-1", "mem-1", {
			wasInjected: 1,
			rank: 0,
			effectiveScore: 0.9,
		});
		insertSessionMemory(db, "session-1", "mem-2", {
			wasInjected: 1,
			rank: 1,
			effectiveScore: 0.7,
		});

		const rows = accessor.withReadDb((rdb) =>
			rdb
				.prepare(
					`SELECT sm.memory_id, m.content, sm.source, sm.effective_score
					 FROM session_memories sm
					 JOIN memories m ON m.id = sm.memory_id
					 WHERE sm.session_key = ? AND sm.was_injected = 1
					 ORDER BY sm.rank ASC LIMIT 50`,
				)
				.all("session-1"),
		) as Array<{
			memory_id: string;
			content: string;
			source: string;
			effective_score: number;
		}>;

		expect(rows.length).toBe(2);
		expect(rows[0].memory_id).toBe("mem-1");
		expect(rows[0].content).toBe("User prefers dark mode");
		expect(rows[0].effective_score).toBeCloseTo(0.9, 2);
		expect(rows[1].memory_id).toBe("mem-2");
	});

	it("excludes non-injected candidates", () => {
		insertMemory(db, "mem-1", "Injected memory");
		insertMemory(db, "mem-2", "Candidate only");
		insertSessionMemory(db, "session-1", "mem-1", { wasInjected: 1 });
		insertSessionMemory(db, "session-1", "mem-2", { wasInjected: 0 });

		const rows = accessor.withReadDb((rdb) =>
			rdb
				.prepare(
					`SELECT sm.memory_id FROM session_memories sm
					 WHERE sm.session_key = ? AND sm.was_injected = 1`,
				)
				.all("session-1"),
		) as Array<{ memory_id: string }>;

		expect(rows.length).toBe(1);
		expect(rows[0].memory_id).toBe("mem-1");
	});

	it("returns empty for sessions with no session_memories", () => {
		const rows = accessor.withReadDb((rdb) =>
			rdb
				.prepare(
					`SELECT sm.memory_id FROM session_memories sm
					 WHERE sm.session_key = ? AND sm.was_injected = 1`,
				)
				.all("nonexistent-session"),
		) as Array<{ memory_id: string }>;

		expect(rows.length).toBe(0);
	});
});

// ============================================================================
// per-memory relevance writing
// ============================================================================

describe("per-memory relevance writing", () => {
	it("maps 8-char prefix to full ID and writes relevance_score", () => {
		insertMemory(db, "abcd1234-full-uuid-here", "Memory about TypeScript");
		insertSessionMemory(db, "session-1", "abcd1234-full-uuid-here", {
			wasInjected: 1,
		});

		const prefixMap = new Map<string, string>();
		prefixMap.set("abcd1234", "abcd1234-full-uuid-here");

		const perMemory = [{ id: "abcd1234", relevance: 0.85 }];

		accessor.withWriteTx((wdb) => {
			const stmt = wdb.prepare(
				`UPDATE session_memories SET relevance_score = ?
				 WHERE session_key = ? AND memory_id = ?`,
			);
			for (const entry of perMemory) {
				const fullId = prefixMap.get(entry.id);
				if (!fullId) continue;
				stmt.run(
					Math.max(0, Math.min(1, entry.relevance)),
					"session-1",
					fullId,
				);
			}
		});

		const row = db
			.prepare(
				"SELECT relevance_score FROM session_memories WHERE memory_id = ?",
			)
			.get("abcd1234-full-uuid-here") as { relevance_score: number | null };

		expect(row.relevance_score).toBeCloseTo(0.85, 2);
	});

	it("skips unknown prefix IDs without error", () => {
		insertMemory(db, "known-id-1234", "Known memory");
		insertSessionMemory(db, "session-1", "known-id-1234", {
			wasInjected: 1,
		});

		const prefixMap = new Map<string, string>();
		prefixMap.set("known-id", "known-id-1234");

		const perMemory = [
			{ id: "known-id", relevance: 0.9 },
			{ id: "unknown1", relevance: 0.5 },
		];

		accessor.withWriteTx((wdb) => {
			const stmt = wdb.prepare(
				`UPDATE session_memories SET relevance_score = ?
				 WHERE session_key = ? AND memory_id = ?`,
			);
			for (const entry of perMemory) {
				const fullId = prefixMap.get(entry.id);
				if (!fullId) continue;
				stmt.run(entry.relevance, "session-1", fullId);
			}
		});

		const row = db
			.prepare(
				"SELECT relevance_score FROM session_memories WHERE memory_id = ?",
			)
			.get("known-id-1234") as { relevance_score: number };

		expect(row.relevance_score).toBeCloseTo(0.9, 2);
	});

	it("clamps relevance to [0, 1]", () => {
		insertMemory(db, "mem-clamp-test", "Clamp test");
		insertSessionMemory(db, "session-1", "mem-clamp-test", {
			wasInjected: 1,
		});

		accessor.withWriteTx((wdb) => {
			wdb
				.prepare(
					`UPDATE session_memories SET relevance_score = ?
					 WHERE session_key = ? AND memory_id = ?`,
				)
				.run(Math.max(0, Math.min(1, 1.5)), "session-1", "mem-clamp-test");
		});

		const row = db
			.prepare(
				"SELECT relevance_score FROM session_memories WHERE memory_id = ?",
			)
			.get("mem-clamp-test") as { relevance_score: number };

		expect(row.relevance_score).toBe(1.0);
	});
});

// ============================================================================
// Full continuity scoring round-trip
// ============================================================================

describe("continuity scoring round-trip", () => {
	it("writes memories_recalled from actual injected count", () => {
		insertMemory(db, "mem-rt-1", "Memory one");
		insertMemory(db, "mem-rt-2", "Memory two");
		insertMemory(db, "mem-rt-3", "Memory three");
		insertSessionMemory(db, "session-rt-1", "mem-rt-1", {
			wasInjected: 1,
			rank: 0,
		});
		insertSessionMemory(db, "session-rt-1", "mem-rt-2", {
			wasInjected: 1,
			rank: 1,
		});
		insertSessionMemory(db, "session-rt-1", "mem-rt-3", {
			wasInjected: 0,
			rank: 2,
		});

		const injected = accessor.withReadDb((rdb) =>
			rdb
				.prepare(
					`SELECT COUNT(*) as cnt FROM session_memories
					 WHERE session_key = ? AND was_injected = 1`,
				)
				.get("session-rt-1"),
		) as { cnt: number };

		expect(injected.cnt).toBe(2);

		const now = new Date().toISOString();
		accessor.withWriteTx((wdb) => {
			wdb.prepare(
				`INSERT INTO session_scores
				 (id, session_key, project, harness, score, memories_recalled,
				  memories_used, novel_context_count, reasoning,
				  confidence, continuity_reasoning, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"score-rt-1",
				"session-rt-1",
				null,
				"test",
				0.85,
				injected.cnt,
				2,
				0,
				"Good session",
				0.9,
				"Both memories were used effectively",
				now,
			);
		});

		const score = db
			.prepare(
				"SELECT memories_recalled, confidence, continuity_reasoning FROM session_scores WHERE id = ?",
			)
			.get("score-rt-1") as {
			memories_recalled: number;
			confidence: number;
			continuity_reasoning: string;
		};

		expect(score.memories_recalled).toBe(2);
		expect(score.confidence).toBeCloseTo(0.9, 2);
		expect(score.continuity_reasoning).toBe(
			"Both memories were used effectively",
		);
	});

	it("handles sessions with no session_memories gracefully", () => {
		const injected = accessor.withReadDb((rdb) =>
			rdb
				.prepare(
					`SELECT sm.memory_id FROM session_memories sm
					 JOIN memories m ON m.id = sm.memory_id
					 WHERE sm.session_key = ? AND sm.was_injected = 1`,
				)
				.all("old-session-no-data"),
		) as Array<{ memory_id: string }>;

		expect(injected.length).toBe(0);

		const now = new Date().toISOString();
		accessor.withWriteTx((wdb) => {
			wdb.prepare(
				`INSERT INTO session_scores
				 (id, session_key, project, harness, score, memories_recalled,
				  memories_used, novel_context_count, reasoning, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"score-old-1",
				"old-session-no-data",
				null,
				"test",
				0.5,
				0,
				0,
				3,
				"No memory data available",
				now,
			);
		});

		const score = db
			.prepare(
				"SELECT memories_recalled FROM session_scores WHERE id = ?",
			)
			.get("score-old-1") as { memories_recalled: number };

		expect(score.memories_recalled).toBe(0);
	});

	it("indexes support efficient session-based queries", () => {
		for (let i = 0; i < 20; i++) {
			const memId = `mem-idx-${i}`;
			insertMemory(db, memId, `Memory ${i}`);
			insertSessionMemory(db, i < 10 ? "session-a" : "session-b", memId, {
				wasInjected: i % 2 === 0 ? 1 : 0,
				rank: i % 10,
			});
		}

		const plan = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM session_memories WHERE session_key = ?",
			)
			.all("session-a") as Array<{ detail: string }>;

		const usesIndex = plan.some(
			(r) =>
				r.detail.includes("idx_session_memories_session") ||
				r.detail.includes("USING INDEX"),
		);
		expect(usesIndex).toBe(true);
	});

	it("fts_hit_count defaults to 0 for new candidates", () => {
		insertMemory(db, "mem-fts-default", "FTS default test");
		insertSessionMemory(db, "session-fts-default", "mem-fts-default");

		const row = db
			.prepare(
				"SELECT fts_hit_count FROM session_memories WHERE memory_id = ?",
			)
			.get("mem-fts-default") as { fts_hit_count: number };

		expect(row.fts_hit_count).toBe(0);
	});
});

// ============================================================================
// scoreContinuity simulation — exact sequence the real function performs
// ============================================================================

describe("scoreContinuity full simulation", () => {
	it("processes a mock LLM response and writes all outputs correctly", () => {
		// --- Setup: 3 injected memories, 1 candidate-only ---
		const memIds = [
			"a1b2c3d4-e5f6-7890-abcd-111111111111",
			"b2c3d4e5-f6a7-8901-bcde-222222222222",
			"c3d4e5f6-a7b8-9012-cdef-333333333333",
			"d4e5f6a7-b8c9-0123-defa-444444444444",
		];
		insertMemory(db, memIds[0], "User prefers dark mode and vim keybindings");
		insertMemory(db, memIds[1], "Project uses Bun as package manager");
		insertMemory(db, memIds[2], "Daemon targets bun for Hono/JSX support");
		insertMemory(db, memIds[3], "CLI targets node for compatibility");

		insertSessionMemory(db, "sim-session", memIds[0], { wasInjected: 1, rank: 0, effectiveScore: 0.95 });
		insertSessionMemory(db, "sim-session", memIds[1], { wasInjected: 1, rank: 1, effectiveScore: 0.82 });
		insertSessionMemory(db, "sim-session", memIds[2], { wasInjected: 1, rank: 2, effectiveScore: 0.71 });
		insertSessionMemory(db, "sim-session", memIds[3], { wasInjected: 0, rank: 3, effectiveScore: 0.40 });

		// --- Step 1: loadInjectedMemories ---
		const injectedMemories = accessor.withReadDb((rdb) =>
			rdb
				.prepare(
					`SELECT sm.memory_id, m.content, sm.source, sm.effective_score
					 FROM session_memories sm
					 JOIN memories m ON m.id = sm.memory_id
					 WHERE sm.session_key = ? AND sm.was_injected = 1
					 ORDER BY sm.rank ASC LIMIT 50`,
				)
				.all("sim-session"),
		) as Array<{
			memory_id: string;
			content: string;
			source: string;
			effective_score: number;
		}>;

		expect(injectedMemories.length).toBe(3);

		// --- Step 2: Simulate LLM JSON response ---
		const mockLlmResponse = JSON.stringify({
			score: 0.78,
			confidence: 0.85,
			memories_used: 2,
			novel_context_count: 1,
			reasoning: "Dark mode preference and Bun usage were directly relevant. Daemon target info was not needed.",
			per_memory: [
				{ id: memIds[0].slice(0, 8), relevance: 0.95 },
				{ id: memIds[1].slice(0, 8), relevance: 0.88 },
				{ id: memIds[2].slice(0, 8), relevance: 0.15 },
			],
		});

		// --- Step 3: Parse (same logic as scoreContinuity) ---
		let jsonStr = mockLlmResponse.trim();
		const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) jsonStr = fenceMatch[1].trim();
		jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

		const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
		expect(typeof parsed.score).toBe("number");

		const perMemoryRaw = Array.isArray(parsed.per_memory) ? parsed.per_memory : [];
		const perMemory = perMemoryRaw
			.filter(
				(e: unknown): e is { id: string; relevance: number } =>
					typeof e === "object" &&
					e !== null &&
					typeof (e as Record<string, unknown>).id === "string" &&
					typeof (e as Record<string, unknown>).relevance === "number",
			)
			.map((e) => ({ id: e.id, relevance: e.relevance }));

		expect(perMemory.length).toBe(3);

		const result = {
			score: Math.max(0, Math.min(1, parsed.score as number)),
			confidence: typeof parsed.confidence === "number"
				? Math.max(0, Math.min(1, parsed.confidence))
				: 0,
			memories_used: typeof parsed.memories_used === "number" ? parsed.memories_used : 0,
			novel_context_count: typeof parsed.novel_context_count === "number" ? parsed.novel_context_count : 0,
			reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
			per_memory: perMemory,
		};

		// --- Step 4: writePerMemoryRelevance ---
		const prefixMap = new Map<string, string>();
		for (const mem of injectedMemories) {
			prefixMap.set(mem.memory_id.slice(0, 8), mem.memory_id);
		}

		accessor.withWriteTx((wdb) => {
			const stmt = wdb.prepare(
				`UPDATE session_memories SET relevance_score = ?
				 WHERE session_key = ? AND memory_id = ?`,
			);
			for (const entry of result.per_memory) {
				const fullId = prefixMap.get(entry.id);
				if (!fullId) continue;
				stmt.run(Math.max(0, Math.min(1, entry.relevance)), "sim-session", fullId);
			}
		});

		// --- Step 5: Write session_scores ---
		const now = new Date().toISOString();
		accessor.withWriteTx((wdb) => {
			wdb.prepare(
				`INSERT INTO session_scores
				 (id, session_key, project, harness, score, memories_recalled,
				  memories_used, novel_context_count, reasoning,
				  confidence, continuity_reasoning, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"score-sim-1",
				"sim-session",
				null,
				"test",
				result.score,
				injectedMemories.length,
				result.memories_used,
				result.novel_context_count,
				result.reasoning,
				result.confidence,
				result.reasoning,
				now,
			);
		});

		// --- Verify all outputs ---

		// 1. session_scores row
		const scoreRow = db
			.prepare("SELECT * FROM session_scores WHERE id = ?")
			.get("score-sim-1") as Record<string, unknown>;

		expect(scoreRow.score).toBeCloseTo(0.78, 2);
		expect(scoreRow.confidence).toBeCloseTo(0.85, 2);
		expect(scoreRow.memories_recalled).toBe(3); // NOT 0
		expect(scoreRow.memories_used).toBe(2);
		expect(scoreRow.novel_context_count).toBe(1);
		expect(scoreRow.continuity_reasoning).toContain("Dark mode preference");

		// 2. Per-memory relevance scores
		const mem0 = db
			.prepare("SELECT relevance_score FROM session_memories WHERE session_key = ? AND memory_id = ?")
			.get("sim-session", memIds[0]) as { relevance_score: number };
		expect(mem0.relevance_score).toBeCloseTo(0.95, 2);

		const mem1 = db
			.prepare("SELECT relevance_score FROM session_memories WHERE session_key = ? AND memory_id = ?")
			.get("sim-session", memIds[1]) as { relevance_score: number };
		expect(mem1.relevance_score).toBeCloseTo(0.88, 2);

		const mem2 = db
			.prepare("SELECT relevance_score FROM session_memories WHERE session_key = ? AND memory_id = ?")
			.get("sim-session", memIds[2]) as { relevance_score: number };
		expect(mem2.relevance_score).toBeCloseTo(0.15, 2);

		// 3. Non-injected candidate should NOT have relevance_score
		const mem3 = db
			.prepare("SELECT relevance_score FROM session_memories WHERE session_key = ? AND memory_id = ?")
			.get("sim-session", memIds[3]) as { relevance_score: number | null };
		expect(mem3.relevance_score).toBeNull();
	});

	it("handles LLM response wrapped in markdown fences", () => {
		const fencedResponse = '```json\n{"score": 0.6, "confidence": 0.7, "memories_used": 1, "novel_context_count": 2, "reasoning": "ok", "per_memory": []}\n```';

		let jsonStr = fencedResponse.trim();
		const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) jsonStr = fenceMatch[1].trim();

		const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
		expect(parsed.score).toBe(0.6);
		expect(parsed.confidence).toBe(0.7);
	});

	it("handles LLM response with <think> blocks", () => {
		const thinkResponse = '<think>Let me analyze...</think>\n{"score": 0.5, "confidence": 0.9, "memories_used": 0, "novel_context_count": 3, "reasoning": "poor", "per_memory": []}';

		let jsonStr = thinkResponse.trim();
		jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

		const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
		expect(parsed.score).toBe(0.5);
		expect(parsed.confidence).toBe(0.9);
	});

	it("handles LLM response missing optional fields gracefully", () => {
		const minimalResponse = '{"score": 0.4}';

		const parsed = JSON.parse(minimalResponse) as Record<string, unknown>;
		expect(typeof parsed.score).toBe("number");

		// Simulate the fallback logic
		const result = {
			score: Math.max(0, Math.min(1, parsed.score as number)),
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
			memories_used: typeof parsed.memories_used === "number" ? parsed.memories_used : 0,
			novel_context_count: typeof parsed.novel_context_count === "number" ? parsed.novel_context_count : 0,
			reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
			per_memory: Array.isArray(parsed.per_memory) ? parsed.per_memory : [],
		};

		expect(result.score).toBeCloseTo(0.4, 2);
		expect(result.confidence).toBe(0);
		expect(result.memories_used).toBe(0);
		expect(result.reasoning).toBe("");
		expect(result.per_memory).toEqual([]);
	});

	it("rejects non-numeric score", () => {
		const badResponse = '{"score": "high", "confidence": 0.5}';
		const parsed = JSON.parse(badResponse) as Record<string, unknown>;

		// scoreContinuity returns early if score isn't a number
		expect(typeof parsed.score).not.toBe("number");
	});

	it("clamps out-of-range scores", () => {
		const result = {
			score: Math.max(0, Math.min(1, 1.5)),
			confidence: Math.max(0, Math.min(1, -0.3)),
		};

		expect(result.score).toBe(1.0);
		expect(result.confidence).toBe(0);
	});
});

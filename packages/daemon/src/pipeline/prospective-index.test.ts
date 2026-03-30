/**
 * Tests for the prospective indexing (hints) pipeline.
 *
 * Uses a real in-memory SQLite database with full migrations.
 * Mock providers simulate various LLM output formats (clean, thinking
 * tags, chain-of-thought noise, empty responses).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../core/src/migrations";
import type { LlmProvider } from "./provider";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { PipelineHintsConfig } from "@signet/core";
import { generateHints, enqueueHintsJob, startHintsWorker } from "./prospective-index";

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

function insertMemory(db: Database, id: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, extraction_status)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none')`,
	).run(id, content, now, now);
}

const HINTS_CFG: PipelineHintsConfig = {
	enabled: true,
	max: 5,
	timeout: 5000,
	maxTokens: 256,
	poll: 10, // fast polling for tests
};

function getHints(db: Database, memoryId: string): string[] {
	return (
		db.prepare(`SELECT hint FROM memory_hints WHERE memory_id = ? ORDER BY hint`).all(memoryId) as Array<{
			hint: string;
		}>
	).map((r) => r.hint);
}

function getHintsFts(db: Database, query: string): string[] {
	return (
		db
			.prepare(
				`SELECT h.memory_id
				 FROM memory_hints_fts f
				 JOIN memory_hints h ON h.rowid = f.rowid
				 WHERE memory_hints_fts MATCH ?`,
			)
			.all(query) as Array<{ memory_id: string }>
	).map((r) => r.memory_id);
}

function getJob(
	db: Database,
	memoryId: string,
):
	| {
			status: string;
			attempts: number;
			leased_at: string | null;
			failed_at: string | null;
	  }
	| undefined {
	return db
		.prepare(
			`SELECT status, attempts, leased_at, failed_at FROM memory_jobs
			 WHERE memory_id = ? AND job_type = 'prospective_index'`,
		)
		.get(memoryId) as
		| {
				status: string;
				attempts: number;
				leased_at: string | null;
				failed_at: string | null;
		  }
		| undefined;
}

/** Shared pipeline config with hints enabled. */
function pipelineCfg(hints = HINTS_CFG) {
	return {
		enabled: true,
		shadowMode: false,
		mutationsFrozen: false,
		extraction: { provider: "ollama" as const, model: "test", timeout: 5000, minConfidence: 0.7 },
		worker: { pollMs: 10, maxRetries: 3, leaseTimeoutMs: 300000 },
		graph: { enabled: false, boostWeight: 0, boostTimeoutMs: 500 },
		reranker: { enabled: false, model: "", useExtractionModel: false, topN: 20, timeoutMs: 2000 },
		autonomous: {
			enabled: false,
			frozen: false,
			allowUpdateDelete: false,
			maintenanceIntervalMs: 0,
			maintenanceMode: "observe" as const,
		},
		repair: {
			reembedCooldownMs: 0,
			reembedHourlyBudget: 0,
			requeueCooldownMs: 0,
			requeueHourlyBudget: 0,
			dedupCooldownMs: 0,
			dedupHourlyBudget: 0,
			dedupSemanticThreshold: 0.92,
			dedupBatchSize: 100,
		},
		documents: { workerIntervalMs: 10000, chunkSize: 2000, chunkOverlap: 200, maxContentBytes: 10_000_000 },
		guardrails: { maxContentChars: 500, chunkTargetChars: 300, recallTruncateChars: 500 },
		structural: { enabled: false, classifyBatchSize: 8, dependencyBatchSize: 5, pollIntervalMs: 10000 },
		significance: { enabled: false, minTurns: 5, minEntityOverlap: 1, noveltyThreshold: 0.15 },
		hints,
	};
}

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

/** Clean question-per-line output (ideal LLM response). */
function cleanProvider(): LlmProvider {
	return {
		name: "mock-clean",
		async generate() {
			return [
				"Where does Caroline live now?",
				"When did Caroline move to Seattle?",
				"Who helped Caroline with the move?",
				"Tell me about Caroline's relocation",
				"Did Caroline leave Portland?",
			].join("\n");
		},
		async available() {
			return true;
		},
	};
}

/** Response wrapped in think tags (qwen3 with thinking mode via tags). */
function thinkingTagProvider(): LlmProvider {
	return {
		name: "mock-thinking-tags",
		async generate() {
			return [
				"<think>",
				"The user stored a fact about Caroline moving.",
				"I should generate diverse questions.",
				"Let me think about temporal, relational, and direct questions.",
				"</think>",
				"Where does Caroline live now?",
				"When did Caroline relocate from Portland?",
				"Tell me about Caroline's move to Seattle",
			].join("\n");
		},
		async available() {
			return true;
		},
	};
}

/** Response with chain-of-thought noise mixed in (thinking field fallback). */
function cotNoiseProvider(): LlmProvider {
	return {
		name: "mock-cot-noise",
		async generate() {
			return [
				"We are given the fact about Caroline moving.",
				"Let's craft diverse questions:",
				"Make sure each is distinct.",
				"Where does Caroline live now?",
				"The third should be relational:",
				"Who is Caroline's roommate in Seattle?",
				"When did Caroline move to Seattle?",
				"Now for conversational cues:",
				"Tell me about Caroline's relocation from Portland",
			].join("\n");
		},
		async available() {
			return true;
		},
	};
}

/** Numbered list output (common LLM format). */
function numberedProvider(): LlmProvider {
	return {
		name: "mock-numbered",
		async generate() {
			return [
				"1. Where does Caroline live?",
				"2) When did she move?",
				"3. Who helped with the move?",
				"- Tell me about Caroline's new city",
				"* Has Caroline settled in Seattle?",
			].join("\n");
		},
		async available() {
			return true;
		},
	};
}

/** Empty response (LLM returns nothing). */
function emptyProvider(): LlmProvider {
	return {
		name: "mock-empty",
		async generate() {
			return "";
		},
		async available() {
			return true;
		},
	};
}

/** Provider that throws (simulates timeout/error). */
function throwingProvider(): LlmProvider {
	return {
		name: "mock-throw",
		async generate() {
			throw new Error("Ollama timeout after 30000ms");
		},
		async available() {
			return false;
		},
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("prospective-index", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		runMigrations(db as any);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	// -----------------------------------------------------------------------
	// generateHints — line parsing and filtering
	// -----------------------------------------------------------------------

	describe("generateHints", () => {
		it("parses clean question-per-line output", async () => {
			const hints = await generateHints(cleanProvider(), "test", HINTS_CFG);
			expect(hints.length).toBe(5);
			expect(hints[0]).toBe("Where does Caroline live now?");
			expect(hints[4]).toBe("Did Caroline leave Portland?");
		});

		it("strips think tags and keeps only questions", async () => {
			const hints = await generateHints(thinkingTagProvider(), "test", HINTS_CFG);
			expect(hints.length).toBe(3);
			expect(hints).toContain("Where does Caroline live now?");
			expect(hints).toContain("Tell me about Caroline's move to Seattle");
			// CoT lines inside think block should be gone
			for (const h of hints) {
				expect(h).not.toContain("I should generate");
			}
		});

		it("filters chain-of-thought noise from mixed output", async () => {
			const hints = await generateHints(cotNoiseProvider(), "test", HINTS_CFG);
			// Should keep only lines that look like questions or cues
			expect(hints.length).toBe(4);
			expect(hints).toContain("Where does Caroline live now?");
			expect(hints).toContain("Who is Caroline's roommate in Seattle?");
			expect(hints).toContain("Tell me about Caroline's relocation from Portland");
			// Should NOT contain reasoning lines
			for (const h of hints) {
				expect(h).not.toContain("We are given");
				expect(h).not.toContain("Let's craft");
				expect(h).not.toContain("Make sure");
				expect(h).not.toContain("Now for");
			}
		});

		it("strips numbering and bullet prefixes", async () => {
			const hints = await generateHints(numberedProvider(), "test", HINTS_CFG);
			expect(hints.length).toBe(5);
			expect(hints[0]).toBe("Where does Caroline live?");
			expect(hints[1]).toBe("When did she move?");
			expect(hints[2]).toBe("Who helped with the move?");
			expect(hints[3]).toBe("Tell me about Caroline's new city");
			expect(hints[4]).toBe("Has Caroline settled in Seattle?");
		});

		it("returns empty array for empty LLM response", async () => {
			const hints = await generateHints(emptyProvider(), "test", HINTS_CFG);
			expect(hints).toEqual([]);
		});

		it("propagates provider errors", async () => {
			await expect(generateHints(throwingProvider(), "test", HINTS_CFG)).rejects.toThrow("Ollama timeout");
		});

		it("filters lines shorter than 11 characters", async () => {
			const provider: LlmProvider = {
				name: "mock-short",
				async generate() {
					return "Short?\nWhere does Caroline live now?";
				},
				async available() {
					return true;
				},
			};
			const hints = await generateHints(provider, "test", HINTS_CFG);
			expect(hints.length).toBe(1);
			expect(hints[0]).toBe("Where does Caroline live now?");
		});
	});

	// -----------------------------------------------------------------------
	// enqueueHintsJob — job creation
	// -----------------------------------------------------------------------

	describe("enqueueHintsJob", () => {
		it("creates a pending prospective_index job", () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "test content");

			accessor.withWriteTx((wdb) => {
				enqueueHintsJob(wdb, mid, "test content");
			});

			const job = getJob(db, mid);
			expect(job).toBeDefined();
			expect(job!.status).toBe("pending");
			expect(job!.attempts).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// startHintsWorker — full job lifecycle
	// -----------------------------------------------------------------------

	describe("startHintsWorker", () => {
		it("processes a job and writes hints to memory_hints", async () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "Caroline moved from Portland to Seattle in 2019");

			accessor.withWriteTx((wdb) => {
				enqueueHintsJob(wdb, mid, "Caroline moved from Portland to Seattle in 2019");
			});

			const handle = startHintsWorker({
				accessor,
				provider: cleanProvider(),
				pipelineCfg: pipelineCfg(),
			});

			await new Promise((r) => setTimeout(r, 200));
			await handle.stop();

			const job = getJob(db, mid);
			expect(job).toBeDefined();
			expect(job!.status).toBe("completed");

			const hints = getHints(db, mid);
			expect(hints.length).toBe(5);
			expect(hints).toContain("Where does Caroline live now?");
		});

		it("writes hints to FTS5 index via triggers", async () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "Caroline moved to Seattle");

			accessor.withWriteTx((wdb) => {
				enqueueHintsJob(wdb, mid, "Caroline moved to Seattle");
			});

			const handle = startHintsWorker({
				accessor,
				provider: cleanProvider(),
				pipelineCfg: pipelineCfg(),
			});

			await new Promise((r) => setTimeout(r, 200));
			await handle.stop();

			// FTS5 should find the hints
			const ftsMatches = getHintsFts(db, '"Caroline" "live"');
			expect(ftsMatches.length).toBeGreaterThan(0);
			expect(ftsMatches[0]).toBe(mid);
		});

		it("completes job with zero hints on empty LLM response", async () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "test content");

			accessor.withWriteTx((wdb) => {
				enqueueHintsJob(wdb, mid, "test content");
			});

			const handle = startHintsWorker({
				accessor,
				provider: emptyProvider(),
				pipelineCfg: pipelineCfg(),
			});

			await new Promise((r) => setTimeout(r, 200));
			await handle.stop();

			const job = getJob(db, mid);
			expect(job!.status).toBe("completed");
			expect(getHints(db, mid)).toEqual([]);
		});

		it("returns a no-op handle when hints are disabled", () => {
			const handle = startHintsWorker({
				accessor,
				provider: cleanProvider(),
				pipelineCfg: pipelineCfg({ ...HINTS_CFG, enabled: false }),
			});

			expect(handle.running).toBe(false);
		});

		it("deduplicates hints via UNIQUE constraint", async () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "test");

			// Enqueue two jobs for the same memory
			accessor.withWriteTx((wdb) => {
				enqueueHintsJob(wdb, mid, "test");
				enqueueHintsJob(wdb, mid, "test");
			});

			const handle = startHintsWorker({
				accessor,
				provider: cleanProvider(),
				pipelineCfg: pipelineCfg(),
			});

			await new Promise((r) => setTimeout(r, 400));
			await handle.stop();

			// Same hints should not duplicate due to UNIQUE(memory_id, hint)
			const hints = getHints(db, mid);
			expect(hints.length).toBe(5);
		});

		it("requeues throwing jobs immediately instead of leaving them leased for the reaper", async () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "test content");

			accessor.withWriteTx((wdb) => {
				enqueueHintsJob(wdb, mid, "test content");
			});

			const handle = startHintsWorker({
				accessor,
				provider: throwingProvider(),
				pipelineCfg: pipelineCfg(),
			});

			await new Promise((r) => setTimeout(r, 200));
			await handle.stop();

			const job = getJob(db, mid);
			expect(job).toBeDefined();
			expect(job?.status).toBe("pending");
			expect(job?.attempts).toBe(1);
			expect(job?.failed_at).not.toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// CASCADE delete — hints removed when parent memory deleted
	// -----------------------------------------------------------------------

	describe("cascade delete", () => {
		it("deletes hints when parent memory is deleted", () => {
			const mid = crypto.randomUUID();
			insertMemory(db, mid, "test");

			// Insert hints directly
			const now = new Date().toISOString();
			db.prepare(
				`INSERT INTO memory_hints (id, memory_id, agent_id, hint, created_at)
				 VALUES (?, ?, 'default', 'Where does X live?', ?)`,
			).run(crypto.randomUUID(), mid, now);

			expect(getHints(db, mid).length).toBe(1);

			db.prepare(`DELETE FROM memories WHERE id = ?`).run(mid);

			expect(getHints(db, mid).length).toBe(0);
		});
	});
});

/**
 * Tests for the shadow decision engine.
 *
 * Uses a real in-memory SQLite database so FTS5 BM25 search works
 * correctly without complex mocking.
 *
 * Key constraint: FTS5 MATCH requires ALL query terms to appear in
 * the document (implicit AND). Memory content must overlap with the
 * fact content for BM25 to return candidates.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";
import { runShadowDecisions } from "./decision";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { LlmProvider } from "./provider";
import type { ExtractedFact } from "@signet/core";
import type { DecisionConfig } from "./decision";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(responses: string[]): LlmProvider {
	let i = 0;
	return {
		name: "mock",
		async generate() {
			return responses[i++] ?? "";
		},
		async available() {
			return true;
		},
	};
}

/** Build a real accessor backed by an in-memory SQLite DB. */
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

/** Insert a memory row into the DB. */
function insertMemory(
	db: Database,
	id: string,
	content: string,
	type = "fact",
	importance = 0.5,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted)
		 VALUES (?, ?, ?, 1.0, ?, ?, ?, 'test', '{}', 0)`,
	).run(id, type, content, importance, now, now);
}

/** Minimal DecisionConfig that disables vector search (fetchEmbedding returns null). */
function makeDecisionConfig(): DecisionConfig {
	return {
		embedding: {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 768,
			base_url: "http://localhost:11434",
		},
		search: { alpha: 0.7, top_k: 20, min_score: 0.0 },
		async fetchEmbedding() {
			// Return null so vector path is skipped; BM25 only.
			return null;
		},
	};
}

/**
 * Fact used for tests that need BM25 to find candidates.
 * Memory content must contain all words in the fact for FTS5 to match.
 */
const MATCHING_FACT: ExtractedFact = {
	content: "prefers dark mode editor",
	type: "preference",
	confidence: 0.9,
};

// Content that shares all words with MATCHING_FACT so FTS5 returns it
const MATCHING_MEMORY_CONTENT =
	"User prefers dark mode in their editor settings";

/** A fact for no-candidate tests (content that won't match any stored memory). */
const UNMATCHED_FACT: ExtractedFact = {
	content: "Zygomorphic flibbertigibbet quux",
	type: "preference",
	confidence: 0.9,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runShadowDecisions", () => {
	let db: Database;
	let accessor: DbAccessor;
	let cfg: DecisionConfig;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
		cfg = makeDecisionConfig();
	});

	afterEach(() => {
		db.close();
	});

	it("proposes ADD when there are no candidates", async () => {
		// Empty DB - no memories to match against
		const provider = mockProvider([]);
		const result = await runShadowDecisions(
			[UNMATCHED_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].action).toBe("add");
		expect(result.proposals[0].confidence).toBe(UNMATCHED_FACT.confidence);
		expect(result.proposals[0].reason).toMatch(/no existing/i);
		expect(result.warnings).toHaveLength(0);
	});

	it("proposes ADD when no memory content overlaps with the fact", async () => {
		// Insert a memory whose content shares no terms with UNMATCHED_FACT
		insertMemory(db, "mem-unrelated", "User enjoys coffee in the morning");
		const provider = mockProvider([]);

		const result = await runShadowDecisions(
			[UNMATCHED_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].action).toBe("add");
	});

	it("parses a valid UPDATE decision JSON response", async () => {
		// Memory shares all words with MATCHING_FACT so BM25 returns it
		insertMemory(db, "mem-001", MATCHING_MEMORY_CONTENT);

		const decision = JSON.stringify({
			action: "update",
			targetId: "mem-001",
			confidence: 0.85,
			reason: "The new fact is more specific than the existing one",
		});
		const provider = mockProvider([decision]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].action).toBe("update");
		expect(result.proposals[0].targetMemoryId).toBe("mem-001");
		expect(result.proposals[0].confidence).toBeCloseTo(0.85);
		expect(result.proposals[0].reason).toBeTruthy();
		expect(result.warnings).toHaveLength(0);
	});

	it("rejects an invalid action with a warning", async () => {
		insertMemory(db, "mem-002", MATCHING_MEMORY_CONTENT);

		const badDecision = JSON.stringify({
			action: "explode",
			confidence: 0.8,
			reason: "This action does not exist",
		});
		const provider = mockProvider([badDecision]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("Invalid action"))).toBe(
			true,
		);
	});

	it("rejects UPDATE referencing a non-candidate ID", async () => {
		insertMemory(db, "mem-real", MATCHING_MEMORY_CONTENT);

		const badDecision = JSON.stringify({
			action: "update",
			targetId: "mem-does-not-exist",
			confidence: 0.8,
			reason: "Referencing a non-existent memory id",
		});
		const provider = mockProvider([badDecision]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("non-candidate"))).toBe(true);
	});

	it("rejects a decision missing a reason", async () => {
		insertMemory(db, "mem-003", MATCHING_MEMORY_CONTENT);

		const noReason = JSON.stringify({
			action: "none",
			confidence: 0.7,
			reason: "",
		});
		const provider = mockProvider([noReason]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("missing reason"))).toBe(
			true,
		);
	});

	it("clamps confidence on decisions to [0, 1]", async () => {
		insertMemory(db, "mem-004", MATCHING_MEMORY_CONTENT);

		const outOfRange = JSON.stringify({
			action: "none",
			confidence: 3.5,
			reason: "Already covered by existing memories",
		});
		const provider = mockProvider([outOfRange]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].confidence).toBe(1);
	});

	it("clamps negative confidence to 0", async () => {
		insertMemory(db, "mem-004b", MATCHING_MEMORY_CONTENT);

		const negative = JSON.stringify({
			action: "none",
			confidence: -0.5,
			reason: "Already fully covered",
		});
		const provider = mockProvider([negative]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].confidence).toBe(0);
	});

	it("handles provider error gracefully and adds warning", async () => {
		insertMemory(db, "mem-005", MATCHING_MEMORY_CONTENT);

		const errorProvider: LlmProvider = {
			name: "failing",
			async generate() {
				throw new Error("network timeout");
			},
			async available() {
				return false;
			},
		};

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			errorProvider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("Decision LLM error"))).toBe(
			true,
		);
	});

	it("returns one ADD proposal per fact when no candidates match", async () => {
		const facts: ExtractedFact[] = [
			{
				content: "Xylophones are fascinating instruments indeed",
				type: "preference",
				confidence: 0.95,
			},
			{
				content: "Zeppelin aeronautics fascinate the researcher",
				type: "preference",
				confidence: 0.9,
			},
		];
		const provider = mockProvider([]);

		const result = await runShadowDecisions(facts, accessor, provider, cfg);

		expect(result.proposals).toHaveLength(2);
		for (const proposal of result.proposals) {
			expect(proposal.action).toBe("add");
		}
	});

	it("handles invalid decision JSON with a warning", async () => {
		insertMemory(db, "mem-006", MATCHING_MEMORY_CONTENT);

		const provider = mockProvider(["this is not json"]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(
			result.warnings.some((w) => w.includes("Failed to parse decision JSON")),
		).toBe(true);
	});

	it("accepts 'delete' action referencing a valid candidate", async () => {
		insertMemory(db, "mem-007", MATCHING_MEMORY_CONTENT);

		const deleteDecision = JSON.stringify({
			action: "delete",
			targetId: "mem-007",
			confidence: 0.8,
			reason: "This memory is now outdated and contradicted",
		});
		const provider = mockProvider([deleteDecision]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].action).toBe("delete");
		expect(result.proposals[0].targetMemoryId).toBe("mem-007");
	});

	it("accepts 'none' action without a targetId", async () => {
		insertMemory(db, "mem-008", MATCHING_MEMORY_CONTENT);

		const noneDecision = JSON.stringify({
			action: "none",
			confidence: 0.9,
			reason: "Fact is already fully covered by existing memory",
		});
		const provider = mockProvider([noneDecision]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0].action).toBe("none");
		expect(result.proposals[0].targetMemoryId).toBeUndefined();
	});

	it("rejects 'update' without targetId", async () => {
		insertMemory(db, "mem-notarget", MATCHING_MEMORY_CONTENT);

		const bad = JSON.stringify({
			action: "update",
			confidence: 0.8,
			reason: "Should be rejected because no targetId",
		});
		const provider = mockProvider([bad]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("missing targetId"))).toBe(
			true,
		);
	});

	it("rejects 'delete' without targetId", async () => {
		insertMemory(db, "mem-notarget2", MATCHING_MEMORY_CONTENT);

		const bad = JSON.stringify({
			action: "delete",
			confidence: 0.7,
			reason: "Should be rejected because no targetId",
		});
		const provider = mockProvider([bad]);

		const result = await runShadowDecisions(
			[MATCHING_FACT],
			accessor,
			provider,
			cfg,
		);

		expect(result.proposals).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("missing targetId"))).toBe(
			true,
		);
	});

	it("processes multiple facts independently", async () => {
		// First fact has a matching candidate; second does not
		insertMemory(db, "mem-multi", MATCHING_MEMORY_CONTENT);

		const addDecision = JSON.stringify({
			action: "add",
			confidence: 0.8,
			reason: "New information not covered by any candidate",
		});
		const provider = mockProvider([addDecision]);

		const facts: ExtractedFact[] = [
			MATCHING_FACT,
			{
				content: "Zygomorphic quuxbar completely unrelated content here",
				type: "fact",
				confidence: 0.7,
			},
		];

		const result = await runShadowDecisions(facts, accessor, provider, cfg);

		// Both facts get proposals: first from LLM (add), second from fallback (add)
		expect(result.proposals).toHaveLength(2);
		for (const p of result.proposals) {
			expect(p.action).toBe("add");
		}
	});
});

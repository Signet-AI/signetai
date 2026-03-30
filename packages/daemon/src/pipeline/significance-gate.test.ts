import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations, type MigrationDb } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import { assessSignificance, type SignificanceConfig } from "./significance-gate";

const DEFAULT_CONFIG: SignificanceConfig = {
	enabled: true,
	minTurns: 5,
	minEntityOverlap: 1,
	noveltyThreshold: 0.15,
};

/** Wrap bun:sqlite Database to satisfy ReadDb. */
function makeReadDb(db: Database): ReadDb {
	return { prepare: (sql: string) => db.prepare(sql) };
}

/** Wrap bun:sqlite Database to satisfy MigrationDb. */
function makeMigrationDb(db: Database): MigrationDb {
	return {
		exec: (sql: string) => db.exec(sql),
		prepare: (sql: string) => {
			const stmt = db.prepare(sql);
			return {
				run: (...args: unknown[]) => stmt.run(...args),
				get: (...args: unknown[]) => stmt.get(...args) ?? undefined,
				all: (...args: unknown[]) => stmt.all(...args),
			};
		},
	};
}

describe("significance gate", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(makeMigrationDb(db));
	});

	afterEach(() => {
		db.close();
	});

	it("marks trivial sessions as insignificant when all gates fail", () => {
		// Seed recent sessions with the same trivial content so novelty is low
		const now = new Date().toISOString();
		for (let i = 0; i < 5; i++) {
			db.run(
				`INSERT INTO summary_jobs (id, session_key, harness, project, transcript, status, created_at, completed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[`job-${i}`, `s-${i}`, "claude-code", "/test", "Human: hi\nAssistant: hello", "completed", now, now],
			);
		}

		const transcript = "Human: hi\nAssistant: hello";
		const result = assessSignificance(transcript, makeReadDb(db), "default", DEFAULT_CONFIG);
		expect(result.significant).toBe(false);
		expect(result.scores.turnCount).toBe(0);
		expect(result.reason).toContain("below threshold");
	});

	it("marks sessions with enough turns as significant", () => {
		// Build a transcript with 6 substantive turns
		const turns: string[] = [];
		for (let i = 0; i < 6; i++) {
			turns.push(`Human: This is a substantive user message number ${i} with enough content.`);
			turns.push(
				`Assistant: This is a substantive assistant response with enough content to pass the 50-char threshold for turn ${i}.`,
			);
		}
		const transcript = turns.join("\n");

		const result = assessSignificance(transcript, makeReadDb(db), "default", DEFAULT_CONFIG);
		expect(result.significant).toBe(true);
		expect(result.scores.turnCount).toBeGreaterThanOrEqual(5);
	});

	it("counts entity overlap from known entities", () => {
		// Insert entities with mentions >= 3
		db.run(
			"INSERT INTO entities (id, name, entity_type, agent_id, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["e1", "TypeScript", "tool", "default", 5, "2024-01-01", "2024-01-01"],
		);
		db.run(
			"INSERT INTO entities (id, name, entity_type, agent_id, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["e2", "Svelte", "tool", "default", 10, "2024-01-01", "2024-01-01"],
		);
		db.run(
			"INSERT INTO entities (id, name, entity_type, agent_id, mentions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["e3", "Obscure", "tool", "default", 1, "2024-01-01", "2024-01-01"],
		);

		const transcript = "Human: Can you help with TypeScript?\nAssistant: Sure, TypeScript is great for type safety.";

		const result = assessSignificance(transcript, makeReadDb(db), "default", DEFAULT_CONFIG);

		// TypeScript should match (mentions=5), Svelte should not, Obscure has < 3 mentions
		expect(result.scores.entityOverlap).toBe(1);
	});

	it("passes entity gate when entities table has no qualifying rows", () => {
		const transcript = "Human: Lets discuss something entirely new\nAssistant: Sure, what would you like to explore?";

		const result = assessSignificance(transcript, makeReadDb(db), "default", {
			...DEFAULT_CONFIG,
			minEntityOverlap: 1,
		});

		// No entities with mentions >= 3, so entityOverlap = 0 which fails.
		// But novelty should be 1.0 (no recent sessions), so session is significant.
		expect(result.scores.entityOverlap).toBe(0);
		expect(result.scores.novelty).toBe(1.0);
		expect(result.significant).toBe(true);
	});

	it("computes novelty as 1.0 when no prior sessions exist", () => {
		const transcript = "Human: This is a brand new session.\nAssistant: Welcome!";
		const result = assessSignificance(transcript, makeReadDb(db), "default", DEFAULT_CONFIG);
		expect(result.scores.novelty).toBe(1.0);
	});

	it("computes reduced novelty when transcript overlaps recent sessions", () => {
		// Insert completed summary_jobs with similar content
		const now = new Date().toISOString();
		const repeatedContent =
			"Human: We discussed TypeScript configuration for the build system today.\nAssistant: The TypeScript configuration needs tsconfig changes.";

		for (let i = 0; i < 5; i++) {
			db.run(
				`INSERT INTO summary_jobs (id, session_key, harness, project, transcript, status, created_at, completed_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[`job-${i}`, `session-${i}`, "claude-code", "/test", repeatedContent, "completed", now, now],
			);
		}

		// Use very similar transcript — should have low novelty
		const result = assessSignificance(repeatedContent, makeReadDb(db), "default", DEFAULT_CONFIG);

		expect(result.scores.novelty).toBeLessThan(0.5);
	});

	it("requires all three gates to fail for insignificance", () => {
		// Even with low turns and no entity overlap, high novelty passes
		const transcript = "Human: hi\nAssistant: hello";

		const result = assessSignificance(transcript, makeReadDb(db), "default", DEFAULT_CONFIG);

		// Turns: 0 (fails), entities: 0 (fails), novelty: 1.0 (passes)
		// Session should be significant because novelty passes
		expect(result.scores.turnCount).toBe(0);
		expect(result.scores.novelty).toBe(1.0);
		expect(result.significant).toBe(true);
	});

	it("respects custom config thresholds", () => {
		const turns: string[] = [];
		for (let i = 0; i < 3; i++) {
			turns.push(`Human: A sufficiently long user message for turn ${i} to pass.`);
			turns.push(
				`Assistant: A sufficiently long assistant response for turn ${i} that exceeds the fifty character minimum.`,
			);
		}
		const transcript = turns.join("\n");

		// With minTurns=2, this should pass the turn gate
		const result = assessSignificance(transcript, makeReadDb(db), "default", { ...DEFAULT_CONFIG, minTurns: 2 });

		expect(result.significant).toBe(true);
		expect(result.scores.turnCount).toBeGreaterThanOrEqual(2);
	});
});

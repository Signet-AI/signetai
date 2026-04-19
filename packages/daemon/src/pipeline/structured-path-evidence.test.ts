import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import { scoreStructuredPathEvidence } from "./structured-path-evidence";

function asReadDb(db: Database): ReadDb {
	return db as unknown as ReadDb;
}

describe("structured path evidence", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	function seedMemory(id: string, content: string): void {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, ?, 'preference', 'memorybench', 0, ?, ?, 'test')`,
		).run(id, content, now, now);
	}

	function seedAttribute(opts: {
		readonly id: string;
		readonly memoryId: string;
		readonly aspect: string;
		readonly group: string;
		readonly claim: string;
		readonly content: string;
		readonly importance?: number;
	}): void {
		const now = new Date().toISOString();
		const entityId = "ent-user";
		db.prepare(
			`INSERT OR IGNORE INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES (?, 'MemoryBench User', 'memorybench user', 'person', 'memorybench', 1, ?, ?)`,
		).run(entityId, now, now);
		db.prepare(
			`INSERT OR IGNORE INTO entity_aspects (
				id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
			) VALUES (?, ?, 'memorybench', ?, ?, 0.9, ?, ?)`,
		).run(`asp-${opts.aspect}`, entityId, opts.aspect, opts.aspect, now, now);
		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, group_key, claim_key, created_at, updated_at
			) VALUES (?, ?, 'memorybench', ?, 'attribute', ?, ?, 0.95, ?, 'active', ?, ?, ?, ?)`,
		).run(
			opts.id,
			`asp-${opts.aspect}`,
			opts.memoryId,
			opts.content,
			opts.content.toLowerCase(),
			opts.importance ?? 0.8,
			opts.group,
			opts.claim,
			now,
			now,
		);
	}

	it("boosts advice-shaped queries toward matching entity/aspect/group/claim paths", () => {
		seedMemory("mem-social-justice", "The user prefers social justice organizations.");
		seedMemory("mem-travel", "The user wants scenic mountain travel suggestions.");
		seedMemory("mem-virtual-coffee", "The user likes virtual coffee breaks with colleagues.");

		seedAttribute({
			id: "attr-social",
			memoryId: "mem-social-justice",
			aspect: "preferences",
			group: "donation_targets",
			claim: "prefer_donate_to_organizations",
			content: "Prefers to support social justice organizations and donation suggestions.",
		});
		seedAttribute({
			id: "attr-travel",
			memoryId: "mem-travel",
			aspect: "preferences",
			group: "mountain_destinations",
			claim: "hiking_and_scenic_drives_preference",
			content: "Prefers mountain destinations with hiking and scenic drives.",
		});
		seedAttribute({
			id: "attr-coffee",
			memoryId: "mem-virtual-coffee",
			aspect: "decision_patterns",
			group: "virtual_coffee_breaks",
			claim: "plans_communicate_with_team",
			content: "Plans virtual coffee breaks, informal team socializing, and facilitation guidance.",
		});

		const scores = scoreStructuredPathEvidence(
			asReadDb(db),
			["mem-social-justice", "mem-travel", "mem-virtual-coffee"],
			"ways to stay connected with colleagues, any suggestions?",
			"memorybench",
		);

		expect(scores.get("mem-virtual-coffee") ?? 0).toBeGreaterThan(scores.get("mem-social-justice") ?? 0);
		expect(scores.get("mem-virtual-coffee") ?? 0).toBeGreaterThan(scores.get("mem-travel") ?? 0);
	});

	it("returns an empty map when there are no candidate IDs", () => {
		expect(scoreStructuredPathEvidence(asReadDb(db), [], "anything", "memorybench").size).toBe(0);
	});
});

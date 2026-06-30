import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import type { ReadDb } from "../db-accessor";
import { findStructuredClaimCandidates, scoreStructuredPathEvidence } from "./structured-path-evidence";

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

	it("returns unbacked source-provenanced ontology claims as structured recall candidates", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES ('ent-artbat', 'ARTBAT / Arbat ForComp', 'artbat arbat forcomp', 'project', 'memorybench', 1, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_aspects (
				id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
			) VALUES ('asp-billing', 'ent-artbat', 'memorybench', 'billing_context', 'billing_context', 0.9, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, group_key, claim_key, proposal_evidence, created_at, updated_at
			) VALUES (?, 'asp-billing', 'memorybench', NULL, 'attribute', ?, ?, 0.95, 0.82, 'active', ?, ?, ?, ?, ?)`,
		).run(
			"attr-artbat-invoice",
			"Current ARTBAT invoice for Maksym Getman is €1,000 and the outstanding 2025 balance is €2,000.",
			"current artbat invoice for maksym getman is eur 1000 and outstanding balance is eur 2000",
			"invoice_followup",
			"maksym_request_2026_06_29",
			JSON.stringify([{ source_kind: "transcript", source_path: "dreaming-log.md:42", quote: "€1,000 and €2,000" }]),
			now,
			now,
		);
		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, group_key, claim_key, proposal_evidence, created_at, updated_at
			) VALUES (?, 'asp-billing', 'other-agent', NULL, 'attribute', ?, ?, 0.95, 0.9, 'active', ?, ?, ?, ?, ?)`,
		).run(
			"attr-other-agent",
			"Other agent ARTBAT invoice decoy is $8,000.",
			"other agent artbat invoice decoy is 8000",
			"invoice_followup",
			"decoy",
			JSON.stringify([{ source_kind: "transcript", source_path: "decoy.md:1", quote: "$8,000" }]),
			now,
			now,
		);
		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, group_key, claim_key, proposal_evidence, created_at, updated_at
			) VALUES (?, 'asp-billing', 'memorybench', NULL, 'attribute', ?, ?, 0.95, 0.9, 'superseded', ?, ?, ?, ?, ?)`,
		).run(
			"attr-superseded",
			"Superseded ARTBAT invoice guess was around €2,000.",
			"superseded artbat invoice guess was around eur 2000",
			"invoice_followup",
			"old_guess",
			JSON.stringify([{ source_kind: "transcript", source_path: "old.md:1", quote: "guess" }]),
			now,
			now,
		);

		const candidates = findStructuredClaimCandidates(
			asReadDb(db),
			"how much were the Artbat invoices for Maksym Getman?",
			"memorybench",
			{ limit: 5, minScore: 0.01 },
		);

		expect(candidates.map((row) => row.id)).toEqual(["attr-artbat-invoice"]);
		expect(candidates[0]?.content).toContain("€1,000");
		expect(candidates[0]?.content).toContain("€2,000");
	});

	it("returns an empty map when there are no candidate IDs", () => {
		expect(scoreStructuredPathEvidence(asReadDb(db), [], "anything", "memorybench").size).toBe(0);
	});
});

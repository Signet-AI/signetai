import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { ensureCompartmentShards } from "../../../core/src/compartment-shards";
import type { ReadDb } from "../db-accessor";
import type { DbOwnerClient } from "../db-owner-client";
import type { DbOwnerRequest } from "../db-owner-client";
import type { ReadScope } from "../read-scope";
import {
	findStructuredClaimCandidates,
	findStructuredClaimCandidatesViaOwner,
	findStructuredPathCandidates,
	findStructuredPathCandidatesViaOwner,
	scoreStructuredPathEvidence,
	scoreStructuredPathEvidenceViaOwner,
} from "./structured-path-evidence";

function asReadDb(db: Database): ReadDb {
	return db as unknown as ReadDb;
}

function asOwner(db: Database, operations: string[]): DbOwnerClient {
	return {
		submit<Result>(request: DbOwnerRequest, options: { readonly operation: string; readonly deadlineMs: number }) {
			if (request.kind !== "query") throw new Error("test owner only supports query requests");
			operations.push(options.operation);
			const params = request.statement.params ?? [];
			const statement = db.prepare(request.statement.sql);
			const value = request.statement.result === "all" ? statement.all(...params) : statement.get(...params);
			return { result: Promise.resolve(value as Result) } as never;
		},
	} as unknown as DbOwnerClient;
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

	it("treats a non-empty source kind as claim provenance", () => {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at
			) VALUES ('ent-source-kind', 'Source Kind Note', 'source kind note', 'source_document', 'memorybench', 0, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_aspects (
				id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
			) VALUES ('asp-source-kind', 'ent-source-kind', 'memorybench', 'overview', 'overview', 0.9, ?, ?)`,
		).run(now, now);
		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
				confidence, importance, status, source_kind, source_id, source_path,
				proposal_evidence, created_at, updated_at
			) VALUES ('attr-source-kind', 'asp-source-kind', 'memorybench', NULL, 'claim', ?, ?, 0.95, 0.8, 'active', ?, NULL, NULL, '[]', ?, ?)`,
		).run(
			"The source-kind provenance is Obsidian-backed.",
			"the source-kind provenance is obsidian-backed",
			"source_obsidian_markdown",
			now,
			now,
		);

		const candidates = findStructuredClaimCandidates(asReadDb(db), "source kind provenance", "memorybench", {
			limit: 5,
			minScore: 0.01,
		});

		expect(candidates.map((row) => row.id)).toEqual(["attr-source-kind"]);
		expect(candidates[0]?.sourceKind).toBe("source_obsidian_markdown");
	});

	it("runs owner-bound evidence scoring through the DB owner", async () => {
		seedMemory("mem-owner", "The user prefers owner-bound graph evidence.");
		seedAttribute({
			id: "attr-owner",
			memoryId: "mem-owner",
			aspect: "preferences",
			group: "owner_boundary",
			claim: "owner_reads_only",
			content: "Prefers owner-bound graph evidence.",
		});

		const operations: string[] = [];
		const scores = await scoreStructuredPathEvidenceViaOwner(
			asOwner(db, operations),
			["mem-owner"],
			"owner-bound graph evidence",
			"memorybench",
		);

		expect(scores.get("mem-owner") ?? 0).toBeGreaterThan(0);
		expect(operations).toEqual(["memory-search.structured-path-evidence"]);
	});

	it("ranks scoped owner path matches before the bounded candidate window", async () => {
		for (let index = 0; index < 12; index++) {
			seedMemory(`weak-${index}`, "Weak path match");
			seedAttribute({
				id: `attr-weak-${index}`,
				memoryId: `weak-${index}`,
				aspect: "overview",
				group: "context",
				claim: "weak",
				content: "alpha",
			});
		}
		for (const id of ["strong", "deleted", "foreign", "filtered"]) {
			seedMemory(id, "Strong path match");
			seedAttribute({
				id: `attr-${id}`,
				memoryId: id,
				aspect: "overview",
				group: "context",
				claim: id,
				content: "alpha beta gamma",
			});
		}
		db.exec("UPDATE entity_attributes SET version_root_id = 'a' WHERE memory_id LIKE 'weak-%'");
		db.exec("UPDATE entity_attributes SET version_root_id = 'z' WHERE memory_id = 'strong'");
		db.exec("UPDATE memories SET is_deleted = 1 WHERE id = 'deleted'");
		db.exec("UPDATE entity_attributes SET agent_id = 'other-agent' WHERE memory_id = 'foreign'");
		db.exec("UPDATE memories SET project = 'excluded' WHERE id = 'filtered'");
		const operations: string[] = [];
		const candidates = await findStructuredPathCandidatesViaOwner(
			asOwner(db, operations),
			"alpha beta gamma",
			"memorybench",
			{ limit: 1, minScore: 0.8, filterSql: "AND m.project IS NULL" },
		);
		expect([...candidates.keys()]).toEqual(["strong"]);
		expect(operations).toEqual(["memory-search.structured-path-candidates", "memory-search.structured-path-evidence"]);
	});

	it("returns an empty map when there are no candidate IDs", () => {
		expect(scoreStructuredPathEvidence(asReadDb(db), [], "anything", "memorybench").size).toBe(0);
	});
});

describe("structured path evidence read scope", () => {
	let db: Database;
	const now = "2026-11-25T00:00:00.000Z";
	const org: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
	const query = "alpha beta gamma";

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		for (const id of ["alice", "bob"]) {
			db.prepare("INSERT OR IGNORE INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
				id,
				id,
				now,
				now,
			);
		}
		db.prepare("INSERT INTO compartments (id, key, created_at) VALUES (1, 'cls_hr', ?)").run(now);
		ensureCompartmentShards(db as unknown as Parameters<typeof ensureCompartmentShards>[0], 1, 0);
	});

	afterEach(() => {
		db.close();
	});

	function graph(prefix: string, agent: string, compartment: { entity?: number; aspect?: number } = {}): string {
		db.prepare(
			`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'project', ?, 1, ?, ?, ?)`,
		).run(`e-${prefix}`, `Entity ${prefix}`, `entity ${prefix}`, agent, compartment.entity ?? null, now, now);
		db.prepare(
			`INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, weight, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, 'overview', 'overview', 0.9, ?, ?, ?)`,
		).run(`a-${prefix}`, `e-${prefix}`, agent, compartment.aspect ?? null, now, now);
		return `a-${prefix}`;
	}

	function memory(id: string, agent: string, compartment: number | null): void {
		db.prepare(
			`INSERT INTO memories (id, content, type, agent_id, compartment_id, is_deleted, created_at, updated_at, updated_by)
			 VALUES (?, 'memory', 'fact', ?, ?, 0, ?, ?, 'test')`,
		).run(id, agent, compartment, now, now);
	}

	function attribute(
		id: string,
		aspectId: string,
		agent: string,
		memoryId: string | null,
		content: string,
		compartment: number | null,
		importance = 0.5,
	): void {
		db.prepare(
			`INSERT INTO entity_attributes (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, source_kind, compartment_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'claim', ?, ?, 0.5, ?, 'active', 'transcript', ?, ?, ?)`,
		).run(id, aspectId, agent, memoryId, content, content, importance, compartment, now, now);
	}

	async function observe(agentId: string, scope: ReadScope) {
		const owner = asOwner(db, []);
		const options = { limit: 5, minScore: 0.01, readScope: scope };
		const paths = [...findStructuredPathCandidates(asReadDb(db), query, agentId, options).entries()];
		expect([...(await findStructuredPathCandidatesViaOwner(owner, query, agentId, options)).entries()]).toEqual(paths);
		const ids = ["m-visible", "m-hidden-attr", "m-bob"];
		const scores = [...scoreStructuredPathEvidence(asReadDb(db), ids, query, agentId, scope).entries()].sort();
		expect(
			[...(await scoreStructuredPathEvidenceViaOwner(owner, ids, query, agentId, scope)).entries()].sort(),
		).toEqual(scores);
		const claims = findStructuredClaimCandidates(asReadDb(db), query, agentId, options).map((row) => [
			row.id,
			row.score,
		]);
		expect(
			(await findStructuredClaimCandidatesViaOwner(owner, query, agentId, options)).map((row) => [row.id, row.score]),
		).toEqual(claims);
		return { paths, scores, claims };
	}

	it("returns identical candidates, scores and claims whether hidden rows exist", async () => {
		const aspect = graph("visible", "alice");
		memory("m-visible", "alice", null);
		attribute("at-visible", aspect, "alice", "m-visible", "alpha beta", null);
		attribute("claim-visible", aspect, "alice", null, "alpha beta gamma claim", null);
		const before = await observe("alice", org);
		expect(before.paths.map(([id]) => id)).toEqual(["m-visible"]);
		expect(before.claims.map(([id]) => id)).toEqual(["claim-visible"]);
		memory("m-hidden", "alice", 1);
		attribute("at-hidden-memory", aspect, "alice", "m-hidden", "alpha beta gamma", null, 0.9);
		attribute("at-hidden-boost", aspect, "alice", "m-visible", "alpha beta gamma", 1, 1);
		memory("m-hidden-attr", "alice", null);
		attribute("at-hidden-attr", aspect, "alice", "m-hidden-attr", "alpha beta gamma", 1, 1);
		attribute("claim-hidden", aspect, "alice", null, "alpha beta gamma hidden claim", 1, 1);
		const hiddenAspect = graph("hidden-aspect", "alice", { aspect: 1 });
		attribute("at-hidden-aspect", hiddenAspect, "alice", "m-visible", "alpha beta gamma", null, 1);
		attribute("claim-hidden-aspect", hiddenAspect, "alice", null, "alpha beta gamma aspect claim", null, 1);
		const hiddenEntity = graph("hidden-entity", "alice", { entity: 1 });
		attribute("at-hidden-entity", hiddenEntity, "alice", "m-visible", "alpha beta gamma", null, 1);
		attribute("claim-hidden-entity", hiddenEntity, "alice", null, "alpha beta gamma entity claim", null, 1);
		expect(await observe("alice", org)).toEqual(before);
	});

	it("lets organization reach read every active agent without agent equality", async () => {
		const aspect = graph("bob", "bob");
		memory("m-bob", "bob", null);
		attribute("at-bob", aspect, "bob", "m-bob", "alpha beta gamma", null);
		attribute("claim-bob", aspect, "bob", null, "alpha beta gamma claim", null);
		const observed = await observe("alice", org);
		expect(observed.paths.map(([id]) => id)).toEqual(["m-bob"]);
		expect(observed.scores.map(([id]) => id)).toEqual(["m-bob"]);
		expect(observed.claims.map(([id]) => id)).toEqual(["claim-bob"]);
	});

	it("fails closed for project-restricted reads of project-less graph rows", async () => {
		const aspect = graph("visible", "alice");
		memory("m-visible", "alice", null);
		db.exec("UPDATE memories SET project = 'atlas'");
		attribute("at-visible", aspect, "alice", "m-visible", "alpha beta gamma", null);
		attribute("claim-visible", aspect, "alice", null, "alpha beta gamma claim", null);
		expect(await observe("alice", { ...org, projects: ["atlas"] })).toEqual({ paths: [], scores: [], claims: [] });
	});
});

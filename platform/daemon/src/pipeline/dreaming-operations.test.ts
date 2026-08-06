import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { type DreamingOperationRequest, applyDreamingOperations } from "./dreaming-operations";

describe("dreaming operations", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-ops-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(id: string, name: string, canonicalName: string, agentId = "agent-a"): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, 'project', ?, 1, 0, '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z')`,
			).run(id, name, canonicalName, agentId);
		});
	}

	function insertAspect(aspectId: string, entityId: string, name: string, agentId = "agent-a"): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run(aspectId, entityId, agentId, name, name.toLowerCase());
		});
	}

	function insertEpisodicMemory(
		id: string,
		content: string,
		agentId = "agent-a",
		reviewAfter: string | null = null,
	): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, review_after, created_at, updated_at)
				 VALUES (?, ?, 'manual', 'episodic', 'normal', ?, ?, datetime('now'), datetime('now'))`,
			).run(id, content, agentId, reviewAfter);
		});
	}

	function flag(operation: Record<string, unknown>): DreamingOperationRequest {
		return { operation: "flag", payload: operation };
	}

	it("mints hygiene attention for a flag op and returns the id", () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({
					subjectRef: "entity:e-husk",
					details: { entityId: "e-husk", reason: "zero_active_attributes" },
				}),
			],
		});
		expect(result.ok).toBe(true);
		const item = result.items[0]!;
		expect(item.ok).toBe(true);
		const attentionId = (item.result as { attentionId: string | null }).attentionId;
		expect(attentionId).toBeTypeOf("string");
		const pending = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE resolved_at IS NULL").get() as { c: number },
		);
		expect(pending.c).toBe(1);
	});

	it("archives a flagged entity in the same batch via attention:$<index>", () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-1",
			operations: [
				flag({ subjectRef: "entity:e-husk", details: { entityId: "e-husk", reason: "zero_active_attributes" } }),
				{
					operation: "archive_entity",
					payload: { target: "e-husk", reason: "non-concrete" },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.items).toHaveLength(2);
		expect(result.items[0]!.ok).toBe(true);
		expect(result.items[1]!.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-husk")),
		).toEqual({ status: "archived" });
		// The consumed flag was resolved in the same tx.
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE resolved_at IS NULL").get() as { c: number },
			),
		).toEqual({ c: 0 });
	});

	it("rejects a same-batch archive whose target is not the flagged entity", () => {
		insertEntity("e-flagged", "Flagged", "flagged");
		insertEntity("e-other", "Other", "other");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "entity:e-flagged", details: { entityId: "e-flagged", reason: "zero_active_attributes" } }),
				{ operation: "archive_entity", payload: { target: "e-other" }, provenance: "attention:$0" },
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)");
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-other")),
		).toEqual({ status: "active" });
	});

	it("archives an entity flagged by a prior batch via attention:<uuid>", () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const minted = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "entity:e-husk", details: { entityId: "e-husk", reason: "zero_active_attributes" } }),
			],
		});
		const attentionId = (minted.items[0]!.result as { attentionId: string | null }).attentionId!;
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-2",
			operations: [
				{ operation: "archive_entity", payload: { target: "e-husk" }, provenance: `attention:${attentionId}` },
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-husk")),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE resolved_at IS NULL").get() as { c: number },
			),
		).toEqual({ c: 0 });
	});

	it("rejects a hygiene archive without provenance", () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "archive_entity", payload: { target: "e-husk" } }],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Hygiene archives require attention provenance");
	});

	it("merges a flagged duplicate group via targets/survivor", () => {
		insertEntity("e-target", "Acme", "acme");
		insertEntity("e-source", "Acme App", "acme");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-3",
			operations: [
				flag({
					subjectRef: "duplicate:acme",
					details: { canonicalName: "acme", reason: "duplicate_canonical_name" },
				}),
				{
					operation: "merge_entities",
					payload: { targets: ["e-target", "e-source"], survivor: "e-target" },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT id FROM entities WHERE id = ?").get("e-source")),
		).toBeNull();
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT id FROM entities WHERE id = ?").get("e-target")),
		).not.toBeNull();
	});

	it("applies a content op with an exact-quote citation resolved against the store", () => {
		insertEpisodicMemory("mem-1", "Acme switched its deployment target to edge runtime in Q2.");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Acme", type: "project" },
					evidence: [
						{
							source_ref: "memory:mem-1",
							source_kind: "manual",
							source_id: "mem-1",
							quote: "Acme switched its deployment target to edge runtime in Q2.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb(
				(db) => db.prepare("SELECT name FROM entities WHERE agent_id = ?").get("agent-a") as { name: string },
			),
		).toEqual({ name: "Acme" });
	});

	it("rejects a content op whose quote is not an exact substring of the source", () => {
		insertEpisodicMemory("mem-1", "Acme switched its deployment target to edge runtime in Q2.");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Acme", type: "project" },
					evidence: [
						{
							source_ref: "memory:mem-1",
							source_kind: "manual",
							source_id: "mem-1",
							quote: "This quote was never in the source.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Every operation must cite an exact quote from scoped episodic evidence");
	});

	it("rejects evidence cited from another agent scope with a corrective error", () => {
		insertEpisodicMemory("mem-other", "The source belongs to the default scope.", "default");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "hermes-agent",
			actor: "dreaming",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Wrong Scope", type: "project" },
					evidence: [
						{
							source_ref: "memory:mem-other",
							source_kind: "manual",
							source_id: "mem-other",
							quote: "The source belongs to the default scope.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe(
			"Cited evidence belongs to scope 'default' but this operation targets 'hermes-agent'. Search evidence in the target scope before applying the operation.",
		);
	});

	it("rejects a content op without evidence", () => {
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "create_entity", payload: { name: "Acme", type: "project" } }],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Every operation must cite an exact quote from scoped episodic evidence");
	});

	it("stores review_after on a semantic memory for a future temporal claim", () => {
		insertEntity("e-acme", "Acme", "acme");
		insertAspect("a-main", "e-acme", "general");
		insertEpisodicMemory("mem-temporal", "Acme plans to travel on 2026-08-03.");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "set_claim_value",
					payload: {
						entityId: "e-acme",
						aspectId: "a-main",
						claimKey: "travel_plan",
						value: "Acme plans to travel on 2026-08-03.",
						reviewAfter: "2026-08-03T00:00:00-06:00",
					},
					evidence: [
						{
							source_ref: "memory:mem-temporal",
							source_kind: "manual",
							source_id: "mem-temporal",
							quote: "Acme plans to travel on 2026-08-03.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT m.review_after
						   FROM memories m
						   JOIN entity_attributes ea ON ea.memory_id = m.id
						  WHERE ea.agent_id = ? AND ea.claim_key = ?`,
					)
					.get("agent-a", "travel_plan") as { review_after: string },
		);
		expect(row.review_after).toBe("2026-08-03T06:00:00.000Z");
	});

	it("supersedes the current active claim for a key without an explicit attribute id", () => {
		insertEntity("e-acme", "Acme", "acme");
		insertAspect("a-main", "e-acme", "general");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, group_key, claim_key, version, version_root_id, created_at, updated_at)
				 VALUES ('attr-1', 'a-main', 'agent-a', 'attribute', 'Old claim value.', 'old claim value.', 0.8, 0.5, 'active', 'general', 'status', 1, 'attr-1', datetime('now'), datetime('now'))`,
			).run();
		});
		insertEpisodicMemory("mem-1", "Acme moved to edge runtime in Q2.");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "supersede_claim_value",
					payload: { entityId: "e-acme", aspectId: "a-main", claimKey: "status", value: "edge runtime" },
					evidence: [
						{
							source_ref: "memory:mem-1",
							source_kind: "manual",
							source_id: "mem-1",
							quote: "Acme moved to edge runtime in Q2.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content, status FROM entity_attributes WHERE aspect_id = ? ORDER BY created_at DESC")
					.all("a-main") as Array<{ content: string; status: string }>,
		);
		expect(rows.some((row) => row.content === "edge runtime" && row.status === "active")).toBe(true);
		expect(rows.some((row) => row.content === "Old claim value." && row.status === "superseded")).toBe(true);
	});

	it("rejects an unsupported operation before touching the graph", () => {
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "drop_everything", payload: {} }],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unsupported ontology proposal operation");
	});
});

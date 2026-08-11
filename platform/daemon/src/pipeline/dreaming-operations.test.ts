import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DbAccessor, closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { applyOntologyProposal, getOntologyProposal, rejectOntologyProposal } from "../ontology-proposals";
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

	function reviewLinkOperation(): DreamingOperationRequest {
		return {
			operation: "create_link",
			payload: { fromEntityId: "e-source", toEntityId: "e-target", linkType: "supports_claim" },
			reason: "Local-first and hosted inference may be two deployment modes. Link them?",
			risk: "review_required",
			evidence: [
				{
					source_ref: "memory:m-review",
					source_kind: "manual",
					source_id: "m-review",
					quote: "Local-first and hosted inference may be two deployment modes.",
				},
			],
		};
	}

	it("mints hygiene attention for a flag op and returns the id", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = await applyDreamingOperations({
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
		const item = result.items[0];
		if (item === undefined) throw new Error("flag result is missing");
		expect(item.ok).toBe(true);
		const attentionId = (item.result as { attentionId: string | null }).attentionId;
		expect(attentionId).toBeTypeOf("string");
		const pending = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE resolved_at IS NULL").get() as { c: number },
		);
		expect(pending.c).toBe(1);
	});

	it("bounds large apply requests across yielding writer transactions (#1337)", async () => {
		const base = getDbAccessor();
		const enqueue = base.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		for (let index = 0; index < 25; index += 1) {
			insertEpisodicMemory(`m-1337-${index}`, `Evidence for operation ${index}.`);
		}
		let transactions = 0;
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				transactions++;
				return enqueue(fn);
			},
		};
		let eventLoopTicks = 0;
		const timer = setInterval(() => {
			eventLoopTicks += 1;
		}, 0);
		let result: Awaited<ReturnType<typeof applyDreamingOperations>>;
		try {
			result = await applyDreamingOperations({
				accessor,
				agentId: "agent-a",
				actor: "dreaming",
				operations: Array.from({ length: 25 }, (_, index) => ({
					operation: "create_entity",
					payload: { name: `Issue 1337 entity ${index}`, type: "project" },
					evidence: [
						{
							source_ref: `memory:m-1337-${index}`,
							source_kind: "manual",
							source_id: `m-1337-${index}`,
							quote: `Evidence for operation ${index}.`,
						},
					],
				})),
			});
		} finally {
			clearInterval(timer);
		}

		expect(result.ok).toBe(true);
		expect(result.items).toHaveLength(25);
		expect(result.items.map((item) => item.index)).toEqual(Array.from({ length: 25 }, (_, index) => index));
		expect(transactions).toBeGreaterThanOrEqual(3);
		expect(eventLoopTicks).toBeGreaterThan(0);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT COUNT(*) AS c FROM entities WHERE agent_id = ?").get("agent-a"),
			),
		).toEqual({ c: 25 });
	});

	it("reports a committed prefix and retries only its suffix after a writer-batch rejection (#1414)", async () => {
		const base = getDbAccessor();
		const enqueue = base.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		for (let index = 0; index < 25; index += 1) {
			insertEpisodicMemory(`m-1414-${index}`, `Evidence for retry operation ${index}.`);
		}
		let transactions = 0;
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				transactions += 1;
				if (transactions === 3) return Promise.reject(new Error("injected writer rejection"));
				return enqueue(fn);
			},
		};
		const operations: DreamingOperationRequest[] = Array.from({ length: 25 }, (_, index) => ({
			operation: "create_entity",
			payload: { name: `Issue 1414 entity ${index}`, type: "project" },
			evidence: [
				{
					source_ref: `memory:m-1414-${index}`,
					source_kind: "manual",
					source_id: `m-1414-${index}`,
					quote: `Evidence for retry operation ${index}.`,
				},
			],
		}));

		const partial = await applyDreamingOperations({ accessor, agentId: "agent-a", actor: "dreaming", operations });
		expect(partial.ok).toBe(false);
		expect(partial.retryable).toBe(true);
		expect(partial.retryFrom).toBe(20);
		expect(partial.error).toBe("injected writer rejection");
		expect(partial.items.map((item) => item.index)).toEqual(Array.from({ length: 20 }, (_, index) => index));
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT COUNT(*) AS c FROM ontology_proposals WHERE agent_id = ?").get("agent-a"),
			),
		).toEqual({ c: 20 });

		const retryFrom = partial.retryFrom;
		if (retryFrom === undefined) throw new Error("partial response has no retry boundary");
		const resumed = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: operations.slice(retryFrom),
		});
		expect(resumed.ok).toBe(true);
		expect(resumed.items).toHaveLength(5);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT COUNT(*) AS c FROM ontology_proposals WHERE agent_id = ?").get("agent-a"),
			),
		).toEqual({ c: 25 });
	});

	it("retries a suffix-local attention flag/archive pair without leaving an orphan (#1414)", async () => {
		const base = getDbAccessor();
		const enqueue = base.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		insertEntity("e-1414-husk", "Retry Husk", "retry husk");
		for (let index = 0; index < 20; index += 1) {
			insertEpisodicMemory(`m-1414-suffix-${index}`, `Evidence for suffix retry ${index}.`);
		}
		let transactions = 0;
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				transactions += 1;
				if (transactions === 4) return Promise.reject(new Error("injected suffix writer rejection"));
				return enqueue(fn);
			},
		};
		const operations: DreamingOperationRequest[] = Array.from({ length: 20 }, (_, index) => ({
			operation: "create_entity",
			payload: { name: `Issue 1414 prefix entity ${index}`, type: "project" },
			evidence: [
				{
					source_ref: `memory:m-1414-suffix-${index}`,
					source_kind: "manual",
					source_id: `m-1414-suffix-${index}`,
					quote: `Evidence for suffix retry ${index}.`,
				},
			],
		}));
		operations.push(
			flag({
				subjectRef: "entity:e-1414-husk",
				details: { entityId: "e-1414-husk", reason: "zero_active_attributes" },
			}),
			{
				operation: "archive_entity",
				payload: { target: "e-1414-husk", reason: "non-concrete" },
				provenance: "attention:$20",
			},
		);

		const partial = await applyDreamingOperations({ accessor, agentId: "agent-a", actor: "dreaming", operations });
		expect(partial.ok).toBe(false);
		expect(partial.retryable).toBe(true);
		expect(partial.retryFrom).toBe(20);
		expect(partial.items.map((item) => item.index)).toEqual(Array.from({ length: 20 }, (_, index) => index));

		const retryFrom = partial.retryFrom;
		if (retryFrom === undefined) throw new Error("partial response has no retry boundary");
		const attentionId = getDbAccessor().withReadDb(
			(db) =>
				(
					db
						.prepare(
							"SELECT id FROM dreaming_attention WHERE agent_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1",
						)
						.get("agent-a") as { id?: unknown } | null
				)?.id,
		);
		if (typeof attentionId !== "string") throw new Error("suffix retry attention is missing");
		const resumedOperations = operations.slice(retryFrom);
		const archive = resumedOperations[1];
		if (archive === undefined) throw new Error("suffix retry archive is missing");
		resumedOperations[1] = { ...archive, provenance: `attention:${attentionId}` };
		const resumed = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: resumedOperations,
		});
		expect(resumed.ok).toBe(true);
		expect(resumed.items).toHaveLength(2);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-1414-husk")),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ? AND resolved_at IS NULL")
					.get("agent-a"),
			),
		).toEqual({ c: 0 });
	});

	it("accepts an in-range retained attention coordinate after suffix retry without orphaning the flag (#1414)", async () => {
		const base = getDbAccessor();
		const enqueue = base.withWriteTxAsync;
		if (!enqueue) throw new Error("async write API is unavailable");
		insertEntity("e-1414-in-range-husk", "In-range Retry Husk", "in-range retry husk");
		for (let index = 0; index < 100; index += 1) {
			insertEpisodicMemory(`m-1414-in-range-${index}`, `Evidence for in-range retry ${index}.`);
		}
		let transactions = 0;
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				transactions += 1;
				if (transactions === 3) return Promise.reject(new Error("injected in-range writer rejection"));
				return enqueue(fn);
			},
		};
		const operations: DreamingOperationRequest[] = Array.from({ length: 100 }, (_, index) => {
			if (index === 20) {
				return flag({
					subjectRef: "entity:e-1414-in-range-husk",
					details: { entityId: "e-1414-in-range-husk", reason: "zero_active_attributes" },
				});
			}
			if (index === 21) {
				return {
					operation: "archive_entity",
					payload: { target: "e-1414-in-range-husk", reason: "non-concrete" },
					provenance: "attention:$20",
				};
			}
			return {
				operation: "create_entity",
				payload: { name: `Issue 1414 in-range entity ${index}`, type: "project" },
				evidence: [
					{
						source_ref: `memory:m-1414-in-range-${index}`,
						source_kind: "manual",
						source_id: `m-1414-in-range-${index}`,
						quote: `Evidence for in-range retry ${index}.`,
					},
				],
			};
		});

		const partial = await applyDreamingOperations({ accessor, agentId: "agent-a", actor: "dreaming", operations });
		expect(partial.ok).toBe(false);
		expect(partial.retryable).toBe(true);
		expect(partial.retryFrom).toBe(10);
		expect(partial.items.map((item) => item.index)).toEqual(Array.from({ length: 10 }, (_, index) => index));

		const retryFrom = partial.retryFrom;
		if (retryFrom === undefined) throw new Error("partial response has no retry boundary");
		const resumed = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: operations.slice(retryFrom),
		});
		expect(resumed.ok).toBe(true);
		expect(resumed.items[10]?.result).toMatchObject({ attentionId: expect.any(String) });
		expect(resumed.items[11]?.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entities WHERE id = ?").get("e-1414-in-range-husk"),
			),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ? AND resolved_at IS NULL")
					.get("agent-a"),
			),
		).toEqual({ c: 0 });
	});

	it("rejects an oversized apply request before minting or writing (#1337)", async () => {
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: Array.from({ length: 101 }, (_, index) => flag({ subjectRef: `entity:e-${index}` })),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("operations cannot exceed 100 items");
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ?").get("agent-a"),
			),
		).toEqual({ c: 0 });
	});

	it("escalates review-required content operations without mutating the ontology", async () => {
		insertEntity("e-source", "Local-first", "local-first");
		insertEntity("e-target", "Hosted inference", "hosted inference");
		insertEpisodicMemory("m-review", "Local-first and hosted inference may be two deployment modes.");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [reviewLinkOperation()],
		});
		expect(result.ok).toBe(true);
		expect((result.items[0]?.result as { reviewRequired?: boolean }).reviewRequired).toBe(true);
		const proposalId = (result.items[0]?.proposal as { id: string }).id;
		expect(getOntologyProposal(getDbAccessor(), proposalId, "agent-a")).toMatchObject({
			operation: "create_link",
			status: "pending",
			risk: "review_required",
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM entity_dependencies WHERE agent_id = ?").get("agent-a") as {
						c: number;
					},
			),
		).toEqual({ c: 0 });
		const applied = applyOntologyProposal(getDbAccessor(), {
			agentId: "agent-a",
			id: proposalId,
			actor: "dashboard",
		});
		expect(applied.status).toBe("applied");
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM entity_dependencies WHERE agent_id = ?").get("agent-a") as {
						c: number;
					},
			),
		).toEqual({ c: 1 });
	});

	it("deduplicates repeated review-required operations and honors a rejection", async () => {
		insertEntity("e-source", "Local-first", "local-first");
		insertEntity("e-target", "Hosted inference", "hosted inference");
		insertEpisodicMemory("m-review", "Local-first and hosted inference may be two deployment modes.");
		const run = async () =>
			await applyDreamingOperations({
				accessor: getDbAccessor(),
				agentId: "agent-a",
				actor: "dreaming",
				operations: [reviewLinkOperation()],
			});
		const first = await run();
		const proposalId = (first.items[0]?.proposal as { id: string }).id;
		const second = await run();
		expect((second.items[0]?.result as { deduped?: boolean }).deduped).toBe(true);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM ontology_proposals WHERE agent_id = ?").get("agent-a") as { c: number },
			),
		).toEqual({ c: 1 });
		rejectOntologyProposal(getDbAccessor(), {
			agentId: "agent-a",
			id: proposalId,
			actor: "dashboard",
			reason: "Not the same relationship",
		});
		const third = await run();
		expect((third.items[0]?.result as { deduped?: boolean }).deduped).toBe(true);
		expect(getOntologyProposal(getDbAccessor(), proposalId, "agent-a")).toMatchObject({ status: "rejected" });
	});

	it("archives a flagged entity in the same batch via attention:$<index>", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = await applyDreamingOperations({
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
		expect(result.items[0]?.ok).toBe(true);
		expect(result.items[1]?.ok).toBe(true);
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

	it("rejects an out-of-range suffix attention coordinate without archiving or orphaning state (#1414)", async () => {
		insertEntity("e-out-of-range-husk", "Out-of-range Husk", "out-of-range husk");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({
					subjectRef: "entity:e-out-of-range-husk",
					details: { entityId: "e-out-of-range-husk", reason: "zero_active_attributes" },
				}),
				{
					operation: "archive_entity",
					payload: { target: "e-out-of-range-husk", reason: "non-concrete" },
					provenance: "attention:$999",
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(result.error).toBe("Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)");
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entities WHERE id = ?").get("e-out-of-range-husk"),
			),
		).toEqual({ status: "active" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as { c: number },
			),
		).toEqual({ c: 0 });
	});

	it("archives an entity flagged without an entityId in details, pinned by subjectRef alone (#1168)", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-1",
			operations: [
				// Agent-minted flags carry inspection facts in details but no
				// entityId; the subjectRef is the only id pin.
				flag({ subjectRef: "entity:e-husk", details: { reason: "zero_active_attributes" } }),
				{
					operation: "archive_entity",
					payload: { target: "e-husk", reason: "non-concrete" },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.items[1]?.ok).toBe(true);
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

	it("archives an entity flagged without an entityId in a prior batch via attention:<uuid> (#1168)", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const minted = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [flag({ subjectRef: "entity:e-husk", details: { reason: "zero_active_attributes" } })],
		});
		const attentionId = (minted.items[0]?.result as { attentionId?: string | null } | undefined)?.attentionId;
		if (!attentionId) throw new Error("flag did not mint attention");
		const result = await applyDreamingOperations({
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
	});

	it("rejects an archive whose details id contradicts the flagged subjectRef", async () => {
		insertEntity("e-flagged", "Flagged", "flagged");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "entity:e-flagged", details: { entityId: "e-other", reason: "x" } }),
				{ operation: "archive_entity", payload: { target: "e-flagged" }, provenance: "attention:$0" },
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)");
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("e-flagged")),
		).toEqual({ status: "active" });
		// Preflight rejects the contradictory target before minting the flag.
		expect(
			getDbAccessor().withReadDb(
				(db) => db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention").get() as { c: number },
			),
		).toEqual({ c: 0 });
	});

	it("merges a flagged duplicate group flagged without a canonicalName in details (#1168)", async () => {
		insertEntity("e-target", "Acme", "acme");
		insertEntity("e-source", "Acme App", "acme");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-3",
			operations: [
				// Agent-minted flags carry the canonical name only in the subjectRef.
				flag({ subjectRef: "duplicate:acme", details: { reason: "duplicate_canonical_name" } }),
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

	it("rejects a merge_aspects whose details aspectId contradicts the flagged subjectRef", async () => {
		insertEntity("e-merge3", "MergeThree", "mergethree");
		insertAspect("a-t3", "e-merge3", "target");
		insertAspect("a-s3", "e-merge3", "source");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				// The details aspectId names a different aspect than the subjectRef pin.
				flag({ subjectRef: "aspect:a-s3", details: { aspectId: "a-other", reason: "aspect_over_cap" } }),
				{
					operation: "merge_aspects",
					payload: { entityId: "e-merge3", target: "a-t3", sources: ["a-other"] },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Hygiene archives require attention provenance");
	});

	it("rejects a duplicate merge flagged with an empty canonical name", async () => {
		insertEntity("e-1", "One", "");
		insertEntity("e-2", "Two", "");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "duplicate:", details: { reason: "duplicate_canonical_name" } }),
				{
					operation: "merge_entities",
					payload: { targets: ["e-1", "e-2"], survivor: "e-1" },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Hygiene archives require attention provenance");
	});

	it("consumes a flag after the first hygiene op citing it", async () => {
		insertEntity("e-a", "A", "acme");
		insertEntity("e-b", "B", "acme");
		insertEntity("e-c", "C", "acme");
		insertEntity("e-d", "D", "acme");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-4",
			operations: [
				flag({ subjectRef: "duplicate:acme", details: { canonicalName: "acme", reason: "duplicate_canonical_name" } }),
				{
					operation: "merge_entities",
					payload: { targets: ["e-a", "e-b"], survivor: "e-a" },
					provenance: "attention:$0",
				},
				{
					operation: "merge_entities",
					payload: { targets: ["e-c", "e-d"], survivor: "e-c" },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.items[1]?.ok).toBe(true);
		expect(result.items[2]?.ok).toBe(false);
		expect(result.items[2]?.error).toContain("already consumed");
	});

	it("rejects a same-batch archive whose target is not the flagged entity", async () => {
		insertEntity("e-flagged", "Flagged", "flagged");
		insertEntity("e-other", "Other", "other");
		const result = await applyDreamingOperations({
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

	it("archives an entity flagged by a prior batch via attention:<uuid>", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const minted = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "entity:e-husk", details: { entityId: "e-husk", reason: "zero_active_attributes" } }),
			],
		});
		const attentionId = (minted.items[0]?.result as { attentionId?: string | null } | undefined)?.attentionId;
		if (!attentionId) throw new Error("flag did not mint attention");
		const result = await applyDreamingOperations({
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

	it("rejects a hygiene archive without provenance", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "archive_entity", payload: { target: "e-husk" } }],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Hygiene archives require attention provenance");
	});

	it("merges a flagged duplicate group via targets/survivor", async () => {
		insertEntity("e-target", "Acme", "acme");
		insertEntity("e-source", "Acme App", "acme");
		const result = await applyDreamingOperations({
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

	it("applies a content op with an exact-quote citation resolved against the store", async () => {
		insertEpisodicMemory("mem-1", "Acme switched its deployment target to edge runtime in Q2.");
		const result = await applyDreamingOperations({
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

	it("rejects a content op whose quote is not an exact substring of the source", async () => {
		insertEpisodicMemory("mem-1", "Acme switched its deployment target to edge runtime in Q2.");
		const result = await applyDreamingOperations({
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

	it("validates later evidence before minting an earlier flag (#1414)", async () => {
		insertEntity("e-husk", "Legacy Husk", "legacy husk");
		insertEpisodicMemory("mem-1414-invalid", "The only supported evidence sentence.");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "entity:e-husk", details: { entityId: "e-husk" } }),
				{
					operation: "create_entity",
					payload: { name: "Invalid after flag", type: "project" },
					evidence: [
						{
							source_ref: "memory:mem-1414-invalid",
							source_kind: "manual",
							source_id: "mem-1414-invalid",
							quote: "This quote is not present.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Every operation must cite an exact quote from scoped episodic evidence");
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as {
						c: number;
					},
			),
		).toEqual({ c: 0 });
	});

	it("rejects a mixed flag and cross-scope decline before minting (#1414)", async () => {
		insertEntity("e-owner", "Owner entity", "owner entity");
		const existing = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			actor: "dreaming",
			operations: [flag({ subjectRef: "entity:e-owner" })],
		});
		const foreignAttentionId = (existing.items[0]?.result as { attentionId?: string } | undefined)?.attentionId;
		if (!foreignAttentionId) throw new Error("foreign flag did not mint attention");

		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "entity:e-owner" }),
				{ operation: "decline_attention", payload: { attentionId: foreignAttentionId } },
			],
		});

		expect(result).toMatchObject({
			ok: false,
			items: [],
			error: "Attention record is not pending in this agent scope",
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as { c: number },
			),
		).toEqual({ c: 0 });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT COUNT(*) AS c FROM dreaming_attention WHERE agent_id = ? AND resolved_at IS NULL")
						.get("agent-b") as {
						c: number;
					},
			),
		).toEqual({ c: 1 });
	});

	it("rejects evidence cited from another agent scope with a corrective error", async () => {
		insertEpisodicMemory("mem-other", "The source belongs to the default scope.", "default");
		const result = await applyDreamingOperations({
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

	it("rejects a content op without evidence", async () => {
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "create_entity", payload: { name: "Acme", type: "project" } }],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Every operation must cite an exact quote from scoped episodic evidence");
	});

	it("stores review_after on a semantic memory for a future temporal claim", async () => {
		insertEntity("e-acme", "Acme", "acme");
		insertAspect("a-main", "e-acme", "general");
		insertEpisodicMemory("mem-temporal", "Acme plans to travel on 2026-08-03.");
		const result = await applyDreamingOperations({
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

	it("supersedes the current active claim for a key without an explicit attribute id", async () => {
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
		const result = await applyDreamingOperations({
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

	it("rejects an unsupported operation before touching the graph", async () => {
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "drop_everything", payload: {} }],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Unsupported ontology proposal operation");
	});

	it("merges aspects through the hygiene seam with attention provenance", async () => {
		insertEntity("e-merge", "MergeCo", "mergeco");
		insertAspect("a-target", "e-merge", "status_history");
		insertAspect("a-source", "e-merge", "changelog");
		getDbAccessor().withWriteTx((db) => {
			for (const [aspectId, content] of [
				["a-target", "status one"],
				["a-source", "change one"],
				["a-source", "change two"],
			] as const) {
				db.prepare(
					`INSERT INTO entity_attributes
					 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
					  status, group_key, claim_key, version, version_root_id, created_at, updated_at)
					 VALUES (?, ?, ?, 'fact', ?, ?, 0.9, 0.9, 'active', 'general', 'k', 1, ?, datetime('now'), datetime('now'))`,
				).run(`attr-${content}`, aspectId, "agent-a", content, content, `root-${content}`);
			}
		});

		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-merge",
			operations: [
				flag({ subjectRef: "aspect:a-source", details: { aspectId: "a-source", reason: "aspect_over_cap" } }),
				{
					operation: "merge_aspects",
					payload: {
						entityId: "e-merge",
						target: "a-target",
						sources: ["a-source"],
						newName: "timeline",
						reason: "fold changelog into status history",
					},
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.items[1]?.ok).toBe(true);
		expect(result.items[1]?.result).toMatchObject({ targetAspect: "timeline", totalAttributesMoved: 2 });
		// Source archived, target renamed, all attributes under the target
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entity_aspects WHERE id = ?").get("a-source")),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT COUNT(*) AS c FROM entity_attributes WHERE aspect_id = ? AND status = 'active'")
					.get("a-target"),
			),
		).toEqual({ c: 3 });
	});

	it("requires attention provenance for merge_aspects like other hygiene ops", async () => {
		insertEntity("e-merge2", "MergeTwo", "mergetwo");
		insertAspect("a-t2", "e-merge2", "target");
		insertAspect("a-s2", "e-merge2", "source");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "merge_aspects",
					payload: { entityId: "e-merge2", target: "a-t2", sources: ["a-s2"] },
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Hygiene archives require attention provenance");
	});
});

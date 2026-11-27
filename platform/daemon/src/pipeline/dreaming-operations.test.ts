import { up as upgradeDreamingPartitions } from "../../../core/src/migrations/179-dreaming-evidence-leases";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, type DbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { applyOntologyProposal, getOntologyProposal, rejectOntologyProposal } from "../ontology-proposals";
import { applyDreamingOperations, type DreamingOperationRequest } from "./dreaming-operations";

describe("dreaming operations", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-ops-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			upgradeDreamingPartitions(db);
			for (const id of ["pass-1", "pass-2", "pass-3", "pass-4", "pass-merge"])
				db.prepare("INSERT INTO dreaming_passes (id, agent_id, scope_key) VALUES (?, 'agent-a', 'agent-a')").run(id);
		});
	});

	afterEach(async () => {
		await closeDbAccessor();
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

	it("rejects mixed-label cascades and merge targets before minting flags", async () => {
		insertEntity("partition-source", "Partition source", "partition source");
		insertEntity("partition-target", "Partition target", "partition target");
		insertAspect("partition-aspect", "partition-source", "facts");
		insertEpisodicMemory("partition-evidence", "Partition evidence");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("INSERT INTO compartments (id, key, created_at) VALUES (91, 'alpha', datetime('now'))").run();
			db.prepare("INSERT INTO compartment_members (compartment_id, classification_id) VALUES (91, 'alpha')").run();
			db.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, scope_key, compartment_id) VALUES ('partition-pass', 'agent-a', 'agent-a', 91)",
			).run();
			db.prepare("UPDATE entities SET compartment_id = 91 WHERE id IN ('partition-source', 'partition-target')").run();
		});
		const archive = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "partition-pass",
			operations: [
				flag({ subjectRef: "entity:partition-source", details: { entityId: "partition-source" } }),
				{ operation: "archive_entity", payload: { target: "partition-source" }, provenance: "attention:$0" },
			],
		});
		expect(archive).toMatchObject({ ok: false, error: "compartment_mismatch", items: [] });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM dreaming_attention").get()),
		).toEqual({ count: 0 });
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entity_aspects SET compartment_id = 91 WHERE id = 'partition-aspect'").run();
			db.prepare("UPDATE entities SET compartment_id = NULL WHERE id = 'partition-target'").run();
			db.prepare("UPDATE entities SET canonical_name = 'partition duplicate'").run();
		});
		const merge = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "partition-pass",
			operations: [
				flag({ subjectRef: "duplicate:partition duplicate" }),
				{
					operation: "merge_entities",
					payload: { targets: ["partition-source", "partition-target"], survivor: "partition-target" },
					provenance: "attention:$0",
				},
			],
		});
		expect(merge).toMatchObject({ ok: false, error: "compartment_mismatch", items: [] });
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM entities").get())).toEqual({
			count: 2,
		});
	});

	it("rejects a foreign-agent archive target before minting its same-batch flag", async () => {
		insertEntity("foreign-archive-target", "Foreign archive target", "foreign archive target", "agent-b");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "pass-1",
			operations: [
				flag({ subjectRef: "entity:foreign-archive-target" }),
				{ operation: "archive_entity", payload: { target: "foreign-archive-target" }, provenance: "attention:$0" },
			],
		});
		expect(result).toMatchObject({ ok: false, items: [], error: "compartment_mismatch" });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM dreaming_attention").get()),
		).toEqual({ count: 0 });
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entities WHERE id = 'foreign-archive-target'").get(),
			),
		).toEqual({ status: "active" });
	});

	it("rejects a stale classification epoch before flags", async () => {
		insertEntity("epoch-target", "Epoch target", "epoch target");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, scope_key) VALUES ('epoch-pass', 'agent-a', 'agent-a')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_classification_epoch(agent_id, epoch) VALUES ('agent-a', 1) ON CONFLICT(agent_id) DO UPDATE SET epoch = epoch + 1",
			).run();
		});
		const stale = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "epoch-pass",
			operations: [flag({ subjectRef: "entity:epoch-target" })],
		});
		expect(stale).toMatchObject({ ok: false, error: "compartment_mismatch", items: [] });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM dreaming_attention").get()),
		).toEqual({ count: 0 });
	});

	it("records attention under the durable pass label and rejects evidence above that label", async () => {
		insertEntity("attention-source", "Attention source", "attention source");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO compartments (id, key, created_at) VALUES (91, 'cls_alpha', datetime('now')), (93, 'cls_alpha,cls_beta', datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO compartment_members (compartment_id, classification_id) VALUES (91, 'cls_alpha'), (93, 'cls_alpha'), (93, 'cls_beta')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, scope_key, compartment_id) VALUES ('attention-pass', 'agent-a', 'agent-a', 91)",
			).run();
			db.prepare("UPDATE entities SET compartment_id = 91 WHERE id = 'attention-source'").run();
		});
		const first = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "attention-pass",
			operations: [flag({ subjectRef: "entity:attention-source" })],
		});
		expect(first.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id, dreaming_pass_id FROM dreaming_attention").get(),
			),
		).toEqual({ compartment_id: 91, dreaming_pass_id: "attention-pass" });
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM dreaming_attention").run();
			db.prepare("UPDATE entities SET compartment_id = 93 WHERE id = 'attention-source'").run();
		});
		const rejected = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "attention-pass",
			operations: [flag({ subjectRef: "entity:attention-source" })],
		});
		expect(rejected).toMatchObject({ ok: false, error: "compartment_mismatch", items: [] });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM dreaming_attention").get()),
		).toEqual({ count: 0 });
	});

	it("keeps hidden duplicate-group ids out of hygiene correction errors", async () => {
		for (const [id, name, canonicalName] of [
			["e-group-first", "Group first", "group"],
			["e-group-second", "Group second", "group"],
			["e-hidden-group", "Hidden group", "group"],
			["e-outside", "Outside group", "outside"],
		]) {
			if (id === undefined || name === undefined || canonicalName === undefined)
				throw new Error("Invalid group fixture");
			insertEntity(id, name, canonicalName);
		}
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO compartments (id, key, created_at) VALUES (91, 'cls_alpha', datetime('now')), (93, 'cls_alpha,cls_beta', datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO compartment_members (compartment_id, classification_id) VALUES (91, 'cls_alpha'), (93, 'cls_alpha'), (93, 'cls_beta')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, scope_key, compartment_id) VALUES ('group-pass', 'agent-a', 'agent-a', 91)",
			).run();
			db.prepare("UPDATE entities SET compartment_id = CASE WHEN id = 'e-hidden-group' THEN 93 ELSE 91 END").run();
		});
		const first = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "group-pass",
			operations: [flag({ subjectRef: "duplicate:group" })],
		});
		const result = first.items[0]?.result;
		if (typeof result !== "object" || result === null) throw new Error("Missing attention result");
		const attentionId = Reflect.get(result, "attentionId");
		if (typeof attentionId !== "string") throw new Error("Missing attention id");
		const rejected = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "group-pass",
			operations: [
				{
					operation: "merge_entities",
					payload: { targets: ["e-group-first", "e-outside"], survivor: "e-group-first" },
					provenance: `attention:${attentionId}`,
				},
			],
		});
		expect(rejected.ok).toBe(false);
		expect(rejected.error).toContain("e-group-second");
		expect(rejected.error).not.toContain("e-hidden-group");
	});

	it.each([
		{ agentId: "agent-b", compartmentId: null, error: "authorized agent scope" },
		{ agentId: "agent-a", compartmentId: 93, error: "compartment_mismatch" },
	])("rejects forbidden copied provenance before minting flags (%j)", async (source) => {
		insertEntity("copy-target", "Copy target project", "copy target project");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO compartments (id, key, created_at) VALUES (91, 'cls_alpha', datetime('now')), (93, 'cls_alpha,cls_beta', datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO compartment_members (compartment_id, classification_id) VALUES (91, 'cls_alpha'), (93, 'cls_alpha'), (93, 'cls_beta')",
			).run();
			db.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, scope_key, compartment_id) VALUES ('copy-pass', 'agent-a', 'agent-a', 91)",
			).run();
			db.prepare("UPDATE entities SET compartment_id = 91 WHERE id = 'copy-target'").run();
			db.prepare(
				"INSERT INTO memories (id, content, agent_id, memory_kind, compartment_id, created_at, updated_at) VALUES ('copied-source', 'Copied source evidence', ?, 'episodic', ?, datetime('now'), datetime('now'))",
			).run(source.agentId, source.compartmentId);
			db.prepare(
				"INSERT INTO evidence_citations (derived_kind, derived_id, agent_id, evidence_kind, evidence_id) VALUES ('entity', 'copy-target', 'agent-a', 'memory', 'copied-source')",
			).run();
		});
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			passId: "copy-pass",
			operations: [
				flag({ subjectRef: "entity:copy-target" }),
				{ operation: "archive_entity", payload: { target: "copy-target" }, provenance: "attention:$0" },
			],
		});
		expect(result.ok).toBe(false);
		expect(result.items).toEqual([]);
		expect(result.error).toContain(source.error);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT (SELECT COUNT(*) FROM dreaming_attention) AS flags, (SELECT COUNT(*) FROM ontology_proposals) AS proposals",
					)
					.get(),
			),
		).toEqual({ flags: 0, proposals: 0 });
	});

	it("isolates dangling target citations to a retryable item while applying healthy siblings", async () => {
		insertEpisodicMemory("rename-proof", "Correct entity names.");
		insertEntity("broken-target", "Broken target", "broken target");
		insertEntity("healthy-target", "Healthy target", "healthy target");
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO evidence_citations(derived_kind, derived_id, agent_id, evidence_kind, evidence_id) VALUES ('entity', 'broken-target', 'agent-a', 'memory', 'missing-evidence')",
				)
				.run(),
		);
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "rename_entity",
					payload: { entityId: "broken-target", newName: "Broken renamed" },
					reason: "Correct name",
					evidence: [{ source_ref: "memory:rename-proof", quote: "Correct entity names." }],
				},
				{
					operation: "rename_entity",
					payload: { entityId: "healthy-target", newName: "Healthy renamed" },
					reason: "Correct name",
					evidence: [{ source_ref: "memory:rename-proof", quote: "Correct entity names." }],
				},
			],
		});
		expect(result.items).toEqual([
			expect.objectContaining({ index: 0, ok: false, error: "evidence_citation_missing", retryable: true }),
			expect.objectContaining({ index: 1, ok: true }),
		]);
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT name FROM entities ORDER BY id").all())).toEqual([
			{ name: "Broken target" },
			{ name: "Healthy renamed" },
		]);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"DELETE FROM evidence_citations WHERE derived_kind = 'entity' AND derived_id = 'broken-target' AND evidence_id = 'missing-evidence'",
				)
				.run(),
		);
		const retry = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "rename_entity",
					payload: { entityId: "broken-target", newName: "Broken renamed" },
					evidence: [{ source_ref: "memory:rename-proof", quote: "Correct entity names." }],
				},
			],
		});
		expect(retry.items).toEqual([expect.objectContaining({ index: 0, ok: true })]);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM ontology_proposals").get()),
		).toEqual({ count: 2 });
	});

	it("retries a missing structural person as an item without creating a substitute or blocking siblings", async () => {
		insertEpisodicMemory("healthy-proof", "Healthy evidence.");
		insertEpisodicMemory("person-proof", "Authenticated evidence.");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO users(id, username, display_name, role, created_at, updated_at) VALUES ('usr_missing', 'missing', 'Missing Person', 'member', datetime('now'), datetime('now'))",
			).run();
			db.prepare("UPDATE memories SET author_user_id = 'usr_missing' WHERE id = 'person-proof'").run();
		});
		const operations: DreamingOperationRequest[] = [
			{
				operation: "create_entity",
				payload: { name: "Authenticated project", type: "project" },
				evidence: [{ source_ref: "memory:person-proof", quote: "Authenticated evidence." }],
			},
			{
				operation: "create_entity",
				payload: { name: "Healthy project", type: "project" },
				evidence: [{ source_ref: "memory:healthy-proof", quote: "Healthy evidence." }],
			},
		];
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations,
		});
		expect(result.items).toEqual([
			expect.objectContaining({ index: 0, ok: false, error: "person_identity_missing", retryable: true }),
			expect.objectContaining({ index: 1, ok: true }),
		]);
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT name FROM entities ORDER BY name").all())).toEqual([
			{ name: "Healthy project" },
		]);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO entities(id, agent_id, name, canonical_name, entity_type, person_user_id, created_at, updated_at) VALUES ('repaired-person', 'agent-a', 'Missing Person', 'missing person', 'person', 'usr_missing', datetime('now'), datetime('now'))",
				)
				.run(),
		);
		const retry = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: operations.slice(0, 1),
		});
		expect(retry.items).toEqual([expect.objectContaining({ index: 0, ok: true })]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT COUNT(*) AS count FROM entities WHERE name = 'Healthy project'").get(),
			),
		).toEqual({ count: 1 });
	});

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
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				const committed = base.withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM ontology_proposals").get());
				if (
					committed !== null &&
					typeof committed === "object" &&
					"count" in committed &&
					typeof committed.count === "number" &&
					committed.count >= 20
				)
					return Promise.reject(new Error("injected writer rejection"));
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
		expect(partial.error).toContain("injected");
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
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				const committed = base.withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM ontology_proposals").get());
				if (
					committed !== null &&
					typeof committed === "object" &&
					"count" in committed &&
					typeof committed.count === "number" &&
					committed.count >= 20
				)
					return Promise.reject(new Error("injected suffix writer rejection"));
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
		expect(partial.error).toContain("injected");
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
		const accessor: DbAccessor = {
			...base,
			withWriteTxAsync: (fn) => {
				const committed = base.withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM ontology_proposals").get());
				if (
					committed !== null &&
					typeof committed === "object" &&
					"count" in committed &&
					typeof committed.count === "number" &&
					committed.count >= 10
				)
					return Promise.reject(new Error("injected in-range writer rejection"));
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
		expect(partial.error).toContain("injected");
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

	it("preserves a required dependency reason through Dreaming translation", async () => {
		insertEntity("reason-source", "Deployment A", "deployment a");
		insertEntity("reason-target", "Deployment B", "deployment b");
		insertEpisodicMemory("reason-evidence", "Both deployments use the same reviewed release process.");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "create_link",
					payload: {
						fromEntityId: "reason-source",
						toEntityId: "reason-target",
						linkType: "related_to",
						reason: "Both deployments share the reviewed release process.",
					},
					evidence: [
						{ source_ref: "memory:reason-evidence", quote: "Both deployments use the same reviewed release process." },
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT reason FROM entity_dependencies WHERE source_entity_id='reason-source' AND target_entity_id='reason-target'",
					)
					.get(),
			),
		).toEqual({ reason: "Both deployments share the reviewed release process." });
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
		expect(result.items[0]?.result).toMatchObject({ reviewRequired: true });
		const proposal = result.items[0]?.proposal;
		if (typeof proposal !== "object" || proposal === null) throw new Error("Missing proposal");
		const proposalId = Reflect.get(proposal, "id");
		if (typeof proposalId !== "string") throw new Error("Missing proposal id");
		expect(await getOntologyProposal(getDbAccessor(), proposalId, "agent-a")).toMatchObject({
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
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
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
		const proposal = first.items[0]?.proposal;
		if (typeof proposal !== "object" || proposal === null) throw new Error("Missing proposal");
		const proposalId = Reflect.get(proposal, "id");
		if (typeof proposalId !== "string") throw new Error("Missing proposal id");
		const second = await run();
		expect(second.items[0]?.result).toMatchObject({ deduped: true });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS c FROM ontology_proposals WHERE agent_id = ?").get("agent-a") as { c: number },
			),
		).toEqual({ c: 1 });
		await rejectOntologyProposal(getDbAccessor(), {
			agentId: "agent-a",
			id: proposalId,
			actor: "dashboard",
			reason: "Not the same relationship",
		});
		const third = await run();
		expect(third.items[0]?.result).toMatchObject({ deduped: true });
		expect(await getOntologyProposal(getDbAccessor(), proposalId, "agent-a")).toMatchObject({ status: "rejected" });
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
				flag({ subjectRef: "duplicate:acme", details: { reason: "duplicate_canonical_name" } }),
				{
					operation: "merge_entities",
					payload: { targets: ["e-target", "e-source"], survivor: "e-target" },
					provenance: "attention:$0",
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(result.items?.[1]).toMatchObject({ ok: true });
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT status, archive_reason FROM entities WHERE id = ?").get("e-source"),
			),
		).toEqual({ status: "archived", archive_reason: "merged" });
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

	it("says when a hygiene merge cites an attention id that is not pending in this agent", async () => {
		insertEntity("e-target", "Acme", "acme");
		insertEntity("e-source", "Acme App", "acme");
		const flagged = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "duplicate:acme", details: { canonicalName: "acme", reason: "duplicate_canonical_name" } }),
			],
		});
		const attentionId = (flagged.items[0] as { result?: { attentionId?: string } }).result?.attentionId ?? "";
		const miscopied = `${attentionId.slice(0, -1)}${attentionId.endsWith("0") ? "1" : "0"}`;
		expect(miscopied).not.toBe(attentionId);
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "merge_entities",
					payload: { targets: ["e-target", "e-source"], survivor: "e-target" },
					provenance: `attention:${miscopied}`,
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain(`${miscopied} is not a pending hygiene attention in this agent`);
	});

	it("names merge targets outside the flagged duplicate group", async () => {
		insertEntity("e-target", "Acme", "acme");
		insertEntity("e-source", "Acme App", "acme");
		insertEntity("e-other", "Acme Holdings", "acme holdings");
		const flagged = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				flag({ subjectRef: "duplicate:acme", details: { canonicalName: "acme", reason: "duplicate_canonical_name" } }),
			],
		});
		const attentionId = (flagged.items[0] as { result?: { attentionId?: string } }).result?.attentionId ?? "";
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "merge_entities",
					payload: { targets: ["e-other", "e-target"], survivor: "e-target" },
					provenance: `attention:${attentionId}`,
				},
			],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain('targets e-other are not in the "acme" duplicate group');
		expect(result.error).toContain("decline_attention");
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
		expect(result.items?.[1]).toMatchObject({ ok: true });
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT status, archive_reason FROM entities WHERE id = ?").get("e-source"),
			),
		).toEqual({ status: "archived", archive_reason: "merged" });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT id FROM entities WHERE id = ?").get("e-target")),
		).not.toBeNull();
	});

	it("applies a content op with a canonical source_ref and exact quote", async () => {
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
		expect(result.error).toContain("Every operation must cite an exact quote from scoped episodic evidence");
		expect(result.error).toContain(
			'operation 0 quotes text not found verbatim in memory:mem-1: "This quote was never in the source."',
		);
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
		expect(result.error).toContain("Every operation must cite an exact quote from scoped episodic evidence");
		expect(result.error).toContain("operation 1 quotes text not found verbatim in memory:mem-1414-invalid");
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

	it.each(["memory", "artifact", "transcript"])(
		"rejects cross-agent %s citations before flags or semantic writes (AC6)",
		async (kind) => {
			const content = "The source belongs to the default scope.";
			let sourceRef = "memory:mem-other";
			if (kind === "memory") insertEpisodicMemory("mem-other", content, "default");
			if (kind === "artifact") {
				sourceRef = "artifact:memory/ac6.md";
				getDbAccessor().withWriteTx((db) =>
					db
						.prepare(`INSERT INTO memory_artifacts
				(agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at)
				VALUES ('default', 'memory/ac6.md', 'ac6-hash', 'manual', 'ac6-session', 'ac6-token', datetime('now'), ?, datetime('now'))`)
						.run(content),
				);
			}
			if (kind === "transcript") {
				sourceRef = "transcript:ac6-session";
				getDbAccessor().withWriteTx((db) =>
					db
						.prepare(`INSERT INTO session_transcripts
				(session_key, agent_id, content, created_at) VALUES ('ac6-session', 'default', ?, datetime('now'))`)
						.run(content),
				);
			}
			const result = await applyDreamingOperations({
				accessor: getDbAccessor(),
				agentId: "hermes-agent",
				actor: "dreaming",
				operations: [
					flag({ subjectRef: "entity:unminted-flag" }),
					{
						operation: "create_entity",
						payload: { name: "Wrong Scope", type: "project" },
						evidence: [{ source_ref: sourceRef, quote: content }],
					},
				],
			});
			expect(result).toMatchObject({
				ok: false,
				items: [],
				error:
					"Cited evidence belongs to scope 'default' but this operation targets 'hermes-agent'. Search evidence in the target scope before applying the operation.",
			});
			expect(
				getDbAccessor().withReadDb((db) =>
					db
						.prepare(
							"SELECT (SELECT COUNT(*) FROM dreaming_attention) AS flags, (SELECT COUNT(*) FROM ontology_proposals) AS proposals, (SELECT COUNT(*) FROM entities) AS entities",
						)
						.get(),
				),
			).toEqual({ flags: 0, proposals: 0, entities: 0 });
		},
	);

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

	it("names the operation and the id that did not resolve", async () => {
		insertEntity("e-trip", "June Business Trip", "june-business-trip");
		insertAspect("eb9f4323-95c4-43f1-9b98-b092d545dc45", "e-trip", "trip preparation");
		insertEpisodicMemory("mem-trip", "I need help with packing for my upcoming business trip next month.");
		const evidence = [
			{
				source_ref: "memory:mem-trip",
				source_kind: "manual",
				source_id: "mem-trip",
				quote: "I need help with packing for my upcoming business trip next month.",
			},
		];
		const claim = (aspectId: string) => ({
			operation: "add_claim_value",
			payload: { entityId: "e-trip", aspectId, claimKey: "packing", value: "The user is packing for a trip." },
			evidence,
		});
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [claim("eb9f4323-95c4-43f1-9b98-b092d545dc45"), claim("eb9f4323-95c4-4f51-9b98-b092d545dc45")],
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("operation 1 target (add_claim_value)");
		expect(result.error).toContain("aspect eb9f4323-95c4-4f51-9b98-b092d545dc45 not found on entity e-trip");
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

	it("rejects a dated claim that sets no claim time, so date-filtered recall can find it", async () => {
		insertEntity("e-user", "User", "user");
		insertAspect("a-events", "e-user", "events");
		insertEpisodicMemory("mem-concert", "We saw Queen with my parents last weekend!");
		const attempt = (timing: Record<string, string>) =>
			applyDreamingOperations({
				accessor: getDbAccessor(),
				agentId: "agent-a",
				actor: "dreaming",
				operations: [
					{
						operation: "add_claim_value",
						payload: {
							entityId: "e-user",
							aspectId: "a-events",
							claimKey: "queen_concert",
							value: "Shortly before 2023-04-15 the user saw Queen live with their parents.",
							...timing,
						},
						evidence: [{ source_ref: "memory:mem-concert", quote: "We saw Queen with my parents" }],
					},
				],
			});
		const untimed = await attempt({});
		expect(untimed.ok).toBe(false);
		expect(untimed.items[0]?.error).toContain("names the date 2023-04-15 but sets no claim time");
		const timed = await attempt({ occurredAt: "2023-04-15", timePrecision: "approximate" });
		expect(timed.ok).toBe(true);
	});

	it("carries claim event time from a Dreaming operation onto the claim", async () => {
		insertEntity("e-user", "User", "user");
		insertAspect("a-events", "e-user", "events");
		insertEpisodicMemory("mem-walk", "I just finished the Walk for Hunger this morning!");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "add_claim_value",
					payload: {
						entityId: "e-user",
						aspectId: "a-events",
						claimKey: "charity_walk",
						value: "On 2023-03-19 the user completed the Walk for Hunger.",
						occurredAt: "2023-03-19",
						timePrecision: "day",
					},
					evidence: [{ source_ref: "memory:mem-walk", quote: "I just finished the Walk for Hunger" }],
				},
			],
		});
		expect(result.ok).toBe(true);
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT occurred_start, time_precision FROM entity_attributes WHERE claim_key = ?")
					.get("charity_walk") as { occurred_start: string; time_precision: string },
		);
		expect(row).toEqual({ occurred_start: "2023-03-19T00:00:00.000Z", time_precision: "day" });
	});

	it("rejects only the claim that still holds a relative time and applies the rest of the batch", async () => {
		insertEntity("e-user", "User", "user");
		insertAspect("a-events", "e-user", "events");
		insertEpisodicMemory("mem-walk", "I just finished the Walk for Hunger this morning! I also adopted a cat.");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "add_claim_value",
					payload: {
						entityId: "e-user",
						aspectId: "a-events",
						claimKey: "charity_walk",
						value: "The user completed the Walk for Hunger last weekend.",
					},
					evidence: [{ source_ref: "memory:mem-walk", quote: "I just finished the Walk for Hunger" }],
				},
				{
					operation: "add_claim_value",
					payload: {
						entityId: "e-user",
						aspectId: "a-events",
						claimKey: "pet",
						value: "The user adopted a cat.",
					},
					evidence: [{ source_ref: "memory:mem-walk", quote: "I also adopted a cat." }],
				},
			],
		});
		const rejected = result.items[0] as { ok: boolean; error?: string } | undefined;
		expect(rejected?.ok).toBe(false);
		expect(String(rejected?.error)).toContain('relative time "last weekend"');
		expect(String(rejected?.error)).toContain("capturedAt");
		expect(result.items[1]).toMatchObject({ ok: true });
		const claims = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT claim_key FROM entity_attributes").all() as Array<{ claim_key: string }>,
		);
		expect(claims.map((claim) => claim.claim_key)).toEqual(["pet"]);
	});

	it("lets a content pass merge and rename aspects with a reason instead of a hygiene flag", async () => {
		insertEntity("e-user", "User", "user");
		insertAspect("a-running", "e-user", "running and fitness");
		insertAspect("a-fitness", "e-user", "fitness and exercise");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, group_key, claim_key, version, version_root_id, created_at, updated_at)
				 VALUES ('attr-run', 'a-running', 'agent-a', 'attribute', 'The user runs 5k on Saturdays.', 'the user runs 5k on saturdays.', 0.8, 0.5, 'active', 'general', 'weekend_run', 1, 'attr-run', datetime('now'), datetime('now'))`,
			).run();
		});
		const withoutReason = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{ operation: "rename_aspect", payload: { entityId: "e-user", aspectId: "a-fitness", newName: "fitness" } },
			],
		});
		expect(withoutReason.ok).toBe(false);
		expect(String(withoutReason.error)).toContain("requires a reason");

		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "merge_aspects",
					payload: { entityId: "e-user", target: "a-fitness", sources: ["a-running"] },
					reason: "Running is part of the user's fitness routine.",
				},
				{
					operation: "rename_aspect",
					payload: { entityId: "e-user", aspectId: "a-fitness", newName: "fitness and running" },
					reason: "The merged aspect now covers running too.",
				},
			],
		});
		expect(result.items.map((item) => item.ok)).toEqual([true, true]);
		const state = getDbAccessor().withReadDb((db) => ({
			aspects: db
				.prepare("SELECT id, name, COALESCE(status, 'active') AS status FROM entity_aspects ORDER BY id")
				.all() as Array<{ id: string; name: string; status: string }>,
			claim: db.prepare("SELECT aspect_id FROM entity_attributes WHERE id = 'attr-run'").get() as { aspect_id: string },
		}));
		expect(state.claim.aspect_id).toBe("a-fitness");
		expect(state.aspects.find((aspect) => aspect.id === "a-fitness")?.name).toBe("fitness and running");
		expect(state.aspects.find((aspect) => aspect.id === "a-running")?.status).not.toBe("active");
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

	it("requires a reason for merge_aspects without attention provenance", async () => {
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
		expect(String(result.error)).toContain("requires a reason");
	});

	it("still requires attention provenance for archives", async () => {
		insertEntity("e-arch", "Archived", "archived");
		insertAspect("a-arch", "e-arch", "old");
		const result = await applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [{ operation: "archive_aspect", payload: { target: "a-arch" }, reason: "Unused." }],
		});
		expect(result.ok).toBe(false);
		expect(String(result.error)).toContain("Hygiene archives require attention provenance");
	});
});

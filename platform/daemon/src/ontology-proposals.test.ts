import { up as upgradeDreamingPartitions } from "../../core/src/migrations/179-dreaming-evidence-leases";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { executeClassification } from "./classification-owner";
import { linkDerivedMemorySourcesInTx } from "./derived-memory-provenance";
import { listEpistemicAssertions } from "./ontology-assertions";
import { getOntologyClaimEvidence } from "./ontology-claim-evidence";
import { consolidateOntologyProposals } from "./ontology-consolidation";
import { extractOntologyProposals } from "./ontology-extraction";
import { getOntologyLinkEvidence } from "./ontology-link-evidence";
import {
	applyOntologyOperation,
	applyOntologyOperationBatch,
	applyOntologyProposal,
	createEntityMergePlan,
	createOntologyProposal,
	createOntologyProposals,
	getClaimVersion,
	getOntologyProposal,
	getOntologyProposalEvidence,
	listClaimVersions,
	listOntologyProposalConflicts,
	listOntologyProposals,
	OntologyProposalError,
	proposeDuplicateEntityMerges,
	rejectOntologyProposal,
} from "./ontology-proposals";
import { registerOntologyRoutes } from "./routes/ontology-routes";
import { resolveTemporalRecall } from "./temporal-recall";
import { txIngestEnvelope } from "./transactions";

describe("ontology proposals", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-ontology-proposals-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => upgradeDreamingPartitions(db));
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function insertEntity(
		id: string,
		name: string,
		canonicalName: string,
		agentId: string,
		mentions: number,
		pinned = false,
		entityType = "project",
	): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				name,
				canonicalName,
				entityType,
				agentId,
				mentions,
				pinned ? 1 : 0,
				"2026-05-06T00:00:00.000Z",
				`2026-05-06T00:0${mentions}:00.000Z`,
			);
		});
	}

	function partitionFixture(): void {
		getDbAccessor().withWriteTx((db) => {
			for (const id of ["cls_alpha", "cls_beta"])
				db.prepare("INSERT INTO classifications (id, name, created_at) VALUES (?, ?, datetime('now'))").run(id, id);
			for (const [id, key] of [
				[91, "cls_alpha"],
				[92, "cls_beta"],
				[93, "cls_alpha,cls_beta"],
			])
				db.prepare("INSERT INTO compartments (id, key, created_at) VALUES (?, ?, datetime('now'))").run(id, key);
			for (const [compartment, classification] of [
				[91, "cls_alpha"],
				[92, "cls_beta"],
				[93, "cls_alpha"],
				[93, "cls_beta"],
			])
				db.prepare("INSERT INTO compartment_members (compartment_id, classification_id) VALUES (?, ?)").run(
					compartment,
					classification,
				);
			for (const [id, compartment] of [
				["pass-alpha", 91],
				["pass-both", 93],
			])
				db.prepare(
					"INSERT INTO dreaming_passes (id, agent_id, scope_key, compartment_id) VALUES (?, 'ant', 'ant', ?)",
				).run(id, compartment);
		});
	}

	for (const operation of ["rename_entity", "archive_entity", "merge_entities", "pin_entity", "unpin_entity"] as const)
		it(`rejects ${operation} of structural people before proposal or graph side effects`, async () => {
			insertEntity("identity-person", "Alice", "alice", "ant", 0, false, "person");
			insertEntity("ordinary", "Other", "other", "ant", 0, false, "person");
			getDbAccessor().withWriteTx((db) =>
				db.prepare("UPDATE entities SET person_user_id='alice' WHERE id='identity-person'").run(),
			);
			getDbAccessor().withWriteTx((db) =>
				db
					.prepare(
						"INSERT INTO entity_aliases(id, entity_id, agent_id, alias, canonical_alias, status, created_at, updated_at) VALUES ('person-alias', 'identity-person', 'ant', 'Alice account', 'alice account', 'active', datetime('now'), datetime('now'))",
					)
					.run(),
			);
			const aliases = getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entity_aliases").all());
			const before = getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities ORDER BY id").all());
			await expect(
				applyOntologyOperation(getDbAccessor(), {
					author: { userId: null, credential: "system" },
					actor: "dreaming",
					agentId: "ant",
					operation,
					payload: {
						entity: "identity-person",
						selector: "identity-person",
						target_entity: "ordinary",
						sources: ["identity-person"],
						name: "Renamed",
						new_name: "Renamed",
						alias: "Alice alias",
						alias_id: "person-alias",
					},
				}),
			).rejects.toThrow("person_identity_immutable");
			expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities ORDER BY id").all())).toEqual(
				before,
			);
			expect(
				getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM ontology_proposals").get()),
			).toEqual({ n: 0 });
			expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entity_aliases").all())).toEqual(aliases);
		});

	it.each([false, true])(
		"labels aliases on structural people without changing the parent and archives only its own partition (public first: %s)",
		async (publicFirst) => {
			partitionFixture();
			insertEntity("alias-person", "Alice", "person:alias-alice", "ant", 0, false, "person");
			getDbAccessor().withWriteTx((db) => {
				db.exec("UPDATE entities SET person_user_id='alias-alice' WHERE id='alias-person'");
				db.exec(
					"INSERT INTO memories(id,content,agent_id,memory_kind,created_at,updated_at) VALUES('alias-source','Call me Night Owl.','ant','episodic','now','now')",
				);
			});
			const before = getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT * FROM entities WHERE id='alias-person'").get(),
			);
			const apply = (operation: string, payload: Readonly<Record<string, unknown>>, passId?: string) =>
				applyOntologyOperation(getDbAccessor(), {
					author: { userId: null, credential: "system" },
					agentId: "ant",
					actor: "dreaming",
					passId,
					operation,
					payload,
					evidence: [{ source_ref: "memory:alias-source", quote: "Call me Night Owl." }],
				});
			const createAlias = (passId?: string) =>
				apply("create_entity_alias", { entity_id: "alias-person", alias: "Night Owl" }, passId);
			const first = await createAlias(publicFirst ? undefined : "pass-alpha");
			const second = await createAlias(publicFirst ? "pass-alpha" : undefined);
			const classified = publicFirst ? second : first;
			const publicAlias = publicFirst ? first : second;
			expect(
				getDbAccessor().withReadDb((db) =>
					db.prepare("SELECT compartment_id FROM entity_aliases ORDER BY compartment_id").all(),
				),
			).toEqual([{ compartment_id: null }, { compartment_id: 91 }]);
			expect(
				getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities WHERE id='alias-person'").get()),
			).toEqual(before);
			expect(
				getDbAccessor().withReadDb((db) =>
					db
						.prepare(
							"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='alias' AND derived_id=?",
						)
						.all(classified.result?.aliasId),
				),
			).toEqual([{ evidence_kind: "memory", evidence_id: "alias-source" }]);
			await getDbAccessor().withWriteDbAsync((db) => executeClassification(db, { op: "rebuild", agentId: "ant" }));
			expect(
				getDbAccessor().withReadDb((db) =>
					db.prepare("SELECT compartment_id FROM entity_aliases ORDER BY compartment_id").all(),
				),
			).toEqual([{ compartment_id: null }, { compartment_id: 91 }]);
			await expect(
				apply(
					"archive_entity_alias",
					{ entity_id: "alias-person", alias_id: publicAlias.result?.aliasId },
					"pass-alpha",
				),
			).rejects.toThrow("compartment_mismatch");
			await apply(
				"archive_entity_alias",
				{ entity_id: "alias-person", alias_id: classified.result?.aliasId },
				"pass-alpha",
			);
			expect(
				getDbAccessor().withReadDb((db) =>
					db.prepare("SELECT status,compartment_id FROM entity_aliases ORDER BY compartment_id").all(),
				),
			).toEqual([
				{ status: "active", compartment_id: null },
				{ status: "archived", compartment_id: 91 },
			]);
			expect(
				getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities WHERE id='alias-person'").get()),
			).toEqual(before);
		},
	);

	it("recovers legacy alias labels and citations from their persisted creating proposal", async () => {
		partitionFixture();
		insertEntity("legacy-alias-root", "Legacy Alias", "legacy alias", "ant", 0);
		getDbAccessor().withWriteTx((db) =>
			db.exec(
				"INSERT INTO memories(id,content,agent_id,memory_kind,created_at,updated_at) VALUES('legacy-alias-source','A retained alias disclosure.','ant','episodic','now','now')",
			),
		);
		const created = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			actor: "dreaming",
			agentId: "ant",
			passId: "pass-alpha",
			operation: "create_entity_alias",
			payload: { entity_id: "legacy-alias-root", alias: "Legacy Night Owl" },
			evidence: [{ source_ref: "memory:legacy-alias-source", quote: "A retained alias disclosure." }],
		});
		getDbAccessor().withWriteTx((db) => {
			db.exec("DELETE FROM evidence_citations WHERE derived_kind='alias'");
			db.exec("UPDATE entity_aliases SET compartment_id=NULL,dreaming_pass_id=NULL");
			upgradeDreamingPartitions(db);
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id,dreaming_pass_id FROM entity_aliases").all(),
			),
		).toEqual([{ compartment_id: 91, dreaming_pass_id: "pass-alpha" }]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='alias' AND derived_id=?",
					)
					.all(created.result?.aliasId),
			),
		).toEqual([{ evidence_kind: "memory", evidence_id: "legacy-alias-source" }]);
	});

	it("merges ordinary entities without writing a neighboring structural person's columns", async () => {
		insertEntity("neighbor-person", "Neighbor Person", "neighbor person", "ant", 0, false, "person");
		insertEntity("neighbor-source", "Neighbor source", "neighbor source", "ant", 1);
		insertEntity("neighbor-target", "Neighbor target", "neighbor target", "ant", 1);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET person_user_id = 'usr_neighbor' WHERE id = 'neighbor-person'").run();
			db.prepare(
				"INSERT INTO relations(id, source_entity_id, target_entity_id, relation_type, created_at, agent_id) VALUES ('neighbor-relation', 'neighbor-source', 'neighbor-person', 'knows', datetime('now'), 'ant')",
			).run();
		});
		const before = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT * FROM entities WHERE id = 'neighbor-person'").get(),
		);
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "merge_entities",
			payload: { target_entity_id: "neighbor-target", source_entity_ids: ["neighbor-source"], force: true },
		});
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities WHERE id = 'neighbor-person'").get()),
		).toEqual(before);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT source_entity_id, target_entity_id FROM relations WHERE id = 'neighbor-relation'").get(),
			),
		).toEqual({ source_entity_id: "neighbor-target", target_entity_id: "neighbor-person" });
	});

	for (const first of ["pass-alpha", "pass-public"] as const)
		it(`keeps equal canonical entity names independent when ${first} creates first`, async () => {
			partitionFixture();
			getDbAccessor().withWriteTx((db) =>
				db.exec(
					"INSERT INTO dreaming_passes(id,agent_id,scope_key,status) VALUES('pass-public','ant','ant','running')",
				),
			);
			for (const passId of [first, first === "pass-alpha" ? "pass-public" : "pass-alpha"])
				await applyOntologyOperation(getDbAccessor(), {
					author: { userId: null, credential: "system" },
					agentId: "ant",
					actor: "dreaming",
					passId,
					operation: "create_entity",
					payload: { name: "Project Falcon", entity_type: "project" },
				});
			expect(
				getDbAccessor().withReadDb((db) =>
					db
						.prepare(
							"SELECT compartment_id FROM entities WHERE agent_id='ant' AND name='Project Falcon' ORDER BY compartment_id",
						)
						.all(),
				),
			).toEqual([{ compartment_id: null }, { compartment_id: 91 }]);
		});

	it.each(["add_claim_value", "create_policy"] as const)(
		"allows classified %s children on a readable public person without changing any parent column",
		async (operation) => {
			partitionFixture();
			insertEntity("person-root", "Alice", "person:alice", "ant", 0, false, "person");
			getDbAccessor().withWriteTx((db) => {
				db.exec("UPDATE entities SET person_user_id='alice' WHERE id='person-root'");
				db.exec(
					"INSERT INTO memories(id,content,agent_id,memory_kind,created_at,updated_at) VALUES('child-source','I prefer tea.','ant','episodic','now','now')",
				);
			});
			const before = getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT * FROM entities WHERE id='person-root'").get(),
			);
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				passId: "pass-alpha",
				operation,
				payload:
					operation === "create_policy"
						? { entity: "person-root", kind: "preference", content: "I prefer tea." }
						: { entity: "person-root", aspect: "preferences", claim_key: "drink", value: "I prefer tea." },
				evidence: [{ source_ref: "memory:child-source", quote: "I prefer tea." }],
			});
			expect(
				getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities WHERE id='person-root'").get()),
			).toEqual(before);
			expect(
				getDbAccessor().withReadDb((db) => db.prepare("SELECT compartment_id FROM entity_attributes").all()),
			).toEqual([{ compartment_id: 91 }]);
			expect(
				getDbAccessor().withReadDb((db) =>
					db.prepare("SELECT * FROM evidence_citations WHERE derived_kind='entity'").all(),
				),
			).toEqual([]);
		},
	);

	it("labels every pass claim projection and its copy edges with the durable partition", async () => {
		partitionFixture();
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(`INSERT INTO memories
			(id, content, agent_id, memory_kind, created_at, updated_at, author_user_id)
			VALUES ('pass-source', 'A launch on March 19', 'ant', 'episodic', datetime('now'), datetime('now'), 'alice')`)
				.run(),
		);
		const applied = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: "add_claim_value",
			payload: {
				entity: "Partition project",
				aspect: "timeline",
				claim_key: "launch",
				value: "A launch on March 19",
				occurred_at: "2023-03-19",
			},
			evidence: [{ source_ref: "memory:pass-source", quote: "A launch on March 19" }],
		});
		for (const table of ["memory_entity_mentions", "derived_memory_sources"] as const) {
			const children = getDbAccessor().withReadDb((db) => db.prepare(`SELECT * FROM ${table}`).all());
			expect(children.length).toBeGreaterThan(0);
			for (const child of children) expect(child.compartment_id).toBe(91);
		}
		const rows = getDbAccessor().withReadDb((db) =>
			db
				.prepare(`
			SELECT 'entity' AS kind, compartment_id FROM entities
			UNION ALL SELECT 'aspect', compartment_id FROM entity_aspects
			UNION ALL SELECT 'attribute', compartment_id FROM entity_attributes
			UNION ALL SELECT 'memory', compartment_id FROM memories WHERE memory_kind = 'derived'
			UNION ALL SELECT 'proposal', compartment_id FROM ontology_proposals
			UNION ALL SELECT 'temporal_edge', compartment_id FROM temporal_edges ORDER BY kind`)
				.all(),
		);
		expect(rows).toEqual(
			["aspect", "attribute", "entity", "memory", "proposal", "temporal_edge"].map((kind) => ({
				kind,
				compartment_id: 91,
			})),
		);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT dreaming_pass_id, author_user_id FROM ontology_proposals WHERE id = ?")
					.get(applied.proposal.id),
			),
		).toEqual({ dreaming_pass_id: "pass-alpha", author_user_id: "alice" });
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT evidence_kind FROM evidence_citations WHERE derived_kind = 'temporal_edge' ORDER BY evidence_id",
					)
					.all(),
			),
		).toEqual([{ evidence_kind: "memory" }, { evidence_kind: "memory" }]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT e.proposal_id AS entity_proposal_id, a.proposal_id AS aspect_proposal_id FROM entities e JOIN entity_aspects a ON a.entity_id = e.id WHERE e.agent_id = 'ant'",
					)
					.get(),
			),
		).toEqual({ entity_proposal_id: applied.proposal.id, aspect_proposal_id: applied.proposal.id });
	});

	it("admits subset evidence and rejects sibling labels, stale passes, and cross-agent citations atomically", async () => {
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			for (const [id, agent, compartment] of [
				["subset", "ant", 91],
				["sibling", "ant", 92],
				["foreign", "bee", 91],
			])
				db.prepare(`INSERT INTO memories (id, content, agent_id, compartment_id, memory_kind, created_at, updated_at)
				VALUES (?, 'Partition evidence', ?, ?, 'episodic', datetime('now'), datetime('now'))`).run(
					id,
					agent,
					compartment,
				);
		});
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			passId: "pass-both",
			operation: "create_entity",
			payload: { name: "Subset target" },
			evidence: [{ source_ref: "memory:subset" }],
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id FROM ontology_proposals WHERE id = ?").get(proposal.id),
			),
		).toEqual({ compartment_id: 93 });
		for (const [source, error] of [
			["sibling", "compartment_mismatch"],
			["foreign", "authorized agent scope"],
		])
			await expect(
				createOntologyProposal(getDbAccessor(), {
					author: { userId: null, credential: "system" },
					agentId: "ant",
					passId: "pass-alpha",
					operation: "create_entity",
					payload: { name: "Rejected target" },
					evidence: [{ source_ref: `memory:${source}` }],
				}),
			).rejects.toThrow(error);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO dreaming_classification_epoch(agent_id, epoch) VALUES ('ant', 1) ON CONFLICT(agent_id) DO UPDATE SET epoch = epoch + 1",
				)
				.run(),
		);
		await expect(
			applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				id: proposal.id,
			}),
		).rejects.toThrow("compartment_mismatch");
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM ontology_proposals WHERE id = ?").get(proposal.id),
			),
		).toEqual({ status: "pending" });
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM entities").get())).toEqual({
			count: 0,
		});
	});

	it("supersedes only the exact-label claim stream and preserves a lower-label sibling", async () => {
		const apply = (value: string) =>
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				operation: "add_claim_value",
				payload: { entity: "Sibling project", aspect: "facts", claim_key: "choice", value },
			});
		const first = await apply("First choice");
		const second = await apply("Second choice");
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id = 91").run();
			db.prepare("UPDATE entity_aspects SET compartment_id = 91").run();
			db.prepare("UPDATE entity_attributes SET compartment_id = 91 WHERE id = ?").run(first.result?.attributeId);
			db.prepare("UPDATE memories SET compartment_id = 91 WHERE id = ?").run(first.result?.memoryId);
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: "supersede_claim_value",
			payload: {
				entity: "Sibling project",
				aspect: "facts",
				claim_key: "choice",
				attribute_id: first.result?.attributeId,
				new_value: "Third choice",
			},
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entity_attributes WHERE id = ?").get(second.result?.attributeId),
			),
		).toEqual({ status: "active" });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM ontology_proposals").get()),
		).toEqual({ count: 3 });
	});

	it("rejects an archive that would stale a differently labeled materialized-memory child", async () => {
		const claim = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "add_claim_value",
			payload: { entity: "Cascade project", aspect: "facts", claim_key: "choice", value: "A supported choice" },
		});
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id = 91").run();
			db.prepare("UPDATE entity_aspects SET compartment_id = 91").run();
			db.prepare("UPDATE entity_attributes SET compartment_id = 91").run();
			db.prepare("UPDATE memories SET compartment_id = 91").run();
			db.prepare(
				"INSERT INTO memories (id, content, agent_id, memory_kind, created_at, updated_at) VALUES ('copied-child', 'A copied choice', 'ant', 'derived', datetime('now'), datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO derived_memory_sources (derived_memory_id, source_kind, source_id, agent_id, created_at) VALUES ('copied-child', 'memory', ?, 'ant', datetime('now'))",
			).run(claim.result?.memoryId);
		});
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				passId: "pass-alpha",
				operation: "archive_claim_value",
				payload: { attribute_id: claim.result?.attributeId },
			}),
		).rejects.toThrow("compartment_mismatch");
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT stale_at FROM memories WHERE id = 'copied-child'").get()),
		).toEqual({ stale_at: null });
	});

	it("preserves evidence on both the merged target and archived structural source", async () => {
		getDbAccessor().withWriteTx((db) => {
			for (const id of ["merge-source-proof", "merge-target-proof"])
				db.prepare(
					"INSERT INTO memories (id, content, agent_id, memory_kind, created_at, updated_at) VALUES (?, 'Merge evidence', 'ant', 'episodic', datetime('now'), datetime('now'))",
				).run(id);
		});
		const source = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "create_entity",
			payload: { name: "Evidence source project" },
			evidence: [{ source_ref: "memory:merge-source-proof" }],
		});
		const target = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "create_entity",
			payload: { name: "Evidence target project" },
			evidence: [{ source_ref: "memory:merge-target-proof" }],
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "merge_entities",
			payload: { target_entity_id: target.result?.entityId, source_entity_ids: [source.result?.entityId], force: true },
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT evidence_id FROM evidence_citations WHERE derived_kind = 'entity' AND derived_id = ? ORDER BY evidence_id",
					)
					.all(target.result?.entityId),
			),
		).toEqual([{ evidence_id: "merge-source-proof" }, { evidence_id: "merge-target-proof" }]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare("SELECT COUNT(*) AS count FROM evidence_citations WHERE derived_kind = 'entity' AND derived_id = ?")
					.get(source.result?.entityId),
			),
		).toEqual({ count: 1 });
	});

	it("rejects an entity merge whose aspect deletion would change a differently labeled dependency", async () => {
		for (const [id, name] of [
			["merge-source", "Merge source"],
			["merge-target", "Merge target"],
			["external-source", "External source"],
			["external-target", "External target"],
		]) {
			if (id === undefined || name === undefined) throw new Error("Invalid fixture entity");
			insertEntity(id, name, name.toLowerCase(), "ant", 1);
		}
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id = 91").run();
			for (const [id, entity] of [
				["merge-source-aspect", "merge-source"],
				["merge-target-aspect", "merge-target"],
			])
				db.prepare(
					"INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, compartment_id) VALUES (?, ?, 'ant', 'facts', 'facts', 91)",
				).run(id, entity);
			db.prepare(
				"INSERT INTO entity_dependencies (id, source_entity_id, target_entity_id, aspect_id, agent_id, dependency_type) VALUES ('aspect-dependent', 'external-source', 'external-target', 'merge-source-aspect', 'ant', 'supports')",
			).run();
		});
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				passId: "pass-alpha",
				operation: "merge_entities",
				payload: { target_entity_id: "merge-target", source_entity_ids: ["merge-source"], force: true },
			}),
		).rejects.toThrow("compartment_mismatch");
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT aspect_id FROM entity_dependencies WHERE id = 'aspect-dependent'").get(),
			),
		).toEqual({ aspect_id: "merge-source-aspect" });
	});

	it("keeps claim and dependency streams exact-label on readable public parents", async () => {
		partitionFixture();
		insertEntity("stream-parent", "Stream parent", "stream parent", "ant", 0);
		insertEntity("stream-target", "Stream target", "stream target", "ant", 0);
		const apply = (operation: string, payload: Readonly<Record<string, unknown>>, passId?: string) =>
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				operation,
				payload,
				passId,
			});
		const publicClaim = await apply("set_claim_value", {
			entity: "stream-parent",
			aspect: "facts",
			claim_key: "choice",
			value: "Public choice",
		});
		const publicLink = await apply("create_link", {
			source_entity_id: "stream-parent",
			target_entity_id: "stream-target",
			link_type: "uses",
			reason: "Public support",
		});
		const before = getDbAccessor().withReadDb((db) => ({
			parents: db.prepare("SELECT * FROM entities ORDER BY id").all(),
			aspect: db.prepare("SELECT * FROM entity_aspects").all(),
			claim: db.prepare("SELECT * FROM entity_attributes WHERE id = ?").get(publicClaim.result?.attributeId),
			memory: db.prepare("SELECT * FROM memories WHERE id = ?").get(publicClaim.result?.memoryId),
			link: db.prepare("SELECT * FROM entity_dependencies WHERE id = ?").get(publicLink.result?.dependencyId),
		}));
		const first = await apply(
			"set_claim_value",
			{ entity: "stream-parent", aspect: "facts", claim_key: "choice", value: "Classified first" },
			"pass-alpha",
		);
		await apply(
			"set_claim_value",
			{ entity: "stream-parent", aspect: "facts", claim_key: "choice", value: "Classified second" },
			"pass-alpha",
		);
		await apply("restore_claim_version", { attribute_id: first.result?.attributeId }, "pass-alpha");
		const history = getDbAccessor().withReadDb((db) =>
			db
				.prepare("SELECT agent_id,compartment_id,dreaming_pass_id,event FROM memory_history WHERE memory_id=?")
				.all(first.result?.memoryId),
		);
		expect(history.some((row) => row.event === "recovered")).toBe(true);
		for (const row of history)
			expect(row).toMatchObject({ agent_id: "ant", compartment_id: 91, dreaming_pass_id: "pass-alpha" });
		const privateLink = await apply(
			"create_link",
			{
				source_entity_id: "stream-parent",
				target_entity_id: "stream-target",
				link_type: "uses",
				reason: "Private support",
			},
			"pass-alpha",
		);
		expect(privateLink.result?.dependencyId).not.toBe(publicLink.result?.dependencyId);
		await expect(
			apply("archive_claim_value", { attribute_id: publicClaim.result?.attributeId }, "pass-alpha"),
		).rejects.toThrow("compartment_mismatch");
		await expect(apply("archive_link", { id: publicLink.result?.dependencyId }, "pass-alpha")).rejects.toThrow(
			"compartment_mismatch",
		);
		expect(
			getDbAccessor().withReadDb((db) => ({
				parents: db.prepare("SELECT * FROM entities ORDER BY id").all(),
				aspect: db.prepare("SELECT * FROM entity_aspects").all(),
				claim: db.prepare("SELECT * FROM entity_attributes WHERE id = ?").get(publicClaim.result?.attributeId),
				memory: db.prepare("SELECT * FROM memories WHERE id = ?").get(publicClaim.result?.memoryId),
				link: db.prepare("SELECT * FROM entity_dependencies WHERE id = ?").get(publicLink.result?.dependencyId),
			})),
		).toEqual(before);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id, status FROM entity_attributes WHERE id = ?").get(first.result?.attributeId),
			),
		).toEqual({ compartment_id: 91, status: "active" });
	});

	it("labels claim archive and restore history with the pass rather than the public structural parent", async () => {
		partitionFixture();
		const apply = (operation: string, payload: Readonly<Record<string, unknown>>) =>
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				passId: "pass-alpha",
				operation,
				payload,
			});
		const claim = await apply("add_claim_value", {
			entity: "History project",
			aspect: "facts",
			claim_key: "choice",
			value: "Private choice",
		});
		await apply("archive_claim_value", { attribute_id: claim.result?.attributeId, force: true });
		await apply("restore_claim_version", { attribute_id: claim.result?.attributeId });
		const rows = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT * FROM memory_history WHERE memory_id=? ORDER BY created_at,id").all(claim.result?.memoryId),
		);
		expect(rows.map((row) => row.event).sort()).toEqual(["deleted", "recovered"]);
		for (const row of rows)
			expect(row).toMatchObject({ agent_id: "ant", compartment_id: 91, dreaming_pass_id: "pass-alpha" });
	});

	it("keeps hidden merge edges and their structural source while public merge impact stays unchanged", async () => {
		partitionFixture();
		insertEntity("hidden-edge-source", "Hidden edge source", "hidden edge source", "ant", 0);
		insertEntity("hidden-edge-target", "Hidden edge target", "hidden edge target", "ant", 0);
		const plan = {
			agentId: "ant",
			sourceEntityIds: ["hidden-edge-source"],
			targetEntityId: "hidden-edge-target",
			writeProposal: false,
			force: true,
		};
		const before = await createEntityMergePlan(getDbAccessor(), plan);
		getDbAccessor().withWriteTx((db) => {
			db.exec(
				"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('hidden-edge-memory','Public memory','ant','now','now')",
			);
			db.exec(
				"INSERT INTO memory_entity_mentions(memory_id,entity_id,agent_id,compartment_id,dreaming_pass_id) VALUES('hidden-edge-memory','hidden-edge-source','ant',91,'pass-alpha')",
			);
			db.exec(
				"INSERT INTO relations(id,source_entity_id,target_entity_id,relation_type,agent_id,compartment_id,created_at) VALUES('hidden-edge','hidden-edge-source','hidden-edge-target','uses','ant',91,'now')",
			);
		});
		expect(await createEntityMergePlan(getDbAccessor(), plan)).toEqual(before);
		const children = getDbAccessor().withReadDb((db) => ({
			mentions: db.prepare("SELECT * FROM memory_entity_mentions").all(),
			relations: db.prepare("SELECT * FROM relations").all(),
		}));
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "merge_entities",
			payload: { target_entity_id: "hidden-edge-target", source_entity_ids: ["hidden-edge-source"], force: true },
		});
		expect(
			getDbAccessor().withReadDb((db) => ({
				mentions: db.prepare("SELECT * FROM memory_entity_mentions").all(),
				relations: db.prepare("SELECT * FROM relations").all(),
			})),
		).toEqual(children);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id='hidden-edge-source'").get()),
		).toEqual({ status: "archived" });
	});

	it("rejects a merge that would mutate a readable lower-label relation before graph changes", async () => {
		partitionFixture();
		insertEntity("edge-source", "Edge source", "edge source", "ant", 0);
		insertEntity("edge-target", "Edge target", "edge target", "ant", 0);
		getDbAccessor().withWriteTx((db) => {
			db.exec("UPDATE entities SET compartment_id=91 WHERE id IN ('edge-source','edge-target')");
			db.exec(
				"INSERT INTO relations(id,source_entity_id,target_entity_id,relation_type,agent_id,compartment_id,created_at) VALUES('lower-edge','edge-source','edge-target','uses','ant',NULL,'now')",
			);
		});
		const before = getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM relations").all());
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				passId: "pass-alpha",
				operation: "merge_entities",
				payload: { target_entity_id: "edge-target", source_entity_ids: ["edge-source"], force: true },
			}),
		).rejects.toThrow("compartment_mismatch");
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM relations").all())).toEqual(before);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id='edge-source'").get()),
		).toEqual({ status: "active" });
	});

	it("keeps merge-plan resolution and impact independent of hidden matching names and children", async () => {
		insertEntity("plan-source", "Plan source", "plan source", "ant", 1);
		insertEntity("plan-target", "Plan target", "plan target", "ant", 1);
		const params = {
			agentId: "ant",
			sourceEntities: ["Plan source"],
			targetEntity: "Plan target",
			writeProposal: false,
		};
		const before = await createEntityMergePlan(getDbAccessor(), params);
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO entities(id, agent_id, name, canonical_name, entity_type, compartment_id, created_at, updated_at) VALUES ('hidden-plan-target', 'ant', 'Plan target', 'plan target', 'project', 91, datetime('now'), datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO entity_aspects(id, entity_id, agent_id, name, canonical_name, compartment_id, created_at, updated_at) VALUES ('hidden-plan-aspect', 'plan-source', 'ant', 'private', 'private', 91, datetime('now'), datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO memories(id, agent_id, content, compartment_id, created_at, updated_at) VALUES ('hidden-plan-memory', 'ant', 'Hidden supporting evidence', 91, datetime('now'), datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO memory_entity_mentions(memory_id, entity_id, agent_id, compartment_id) VALUES ('hidden-plan-memory', 'plan-source', 'ant', 91)",
			).run();
		});
		expect(await createEntityMergePlan(getDbAccessor(), params)).toEqual(before);
	});

	it("reactivates only an exact-label archived aspect and leaves lower-label archived columns untouched", async () => {
		partitionFixture();
		insertEntity("archived-parent", "Archived parent", "archived parent", "ant", 0);
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO entity_aspects(id, entity_id, agent_id, name, canonical_name, status, archived_at, created_at, updated_at) VALUES ('public-archived', 'archived-parent', 'ant', 'facts', 'facts', 'archived', '2026-01-01', datetime('now'), datetime('now'))",
				)
				.run(),
		);
		const before = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT * FROM entity_aspects WHERE id = 'public-archived'").get(),
		);
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: "create_aspect",
			payload: { entity_id: "archived-parent", name: "facts" },
		});
		expect(result.result?.aspectId).not.toBe("public-archived");
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entity_aspects WHERE id = 'public-archived'").get()),
		).toEqual(before);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id, status FROM entity_aspects WHERE id = ?").get(result.result?.aspectId),
			),
		).toEqual({ compartment_id: 91, status: "active" });
	});

	it("adds a classified policy to a public parent without mutating the parent", async () => {
		insertEntity("policy-target", "Policy target", "policy target", "ant", 1);
		partitionFixture();
		const before = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT * FROM entities WHERE id = 'policy-target'").get(),
		);
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: "create_policy",
			payload: { target_entity: "Policy target", kind: "security", content: "Keep evidence scoped" },
		});
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT * FROM entities WHERE id = 'policy-target'").get()),
		).toEqual(before);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT compartment_id FROM entity_attributes").all()),
		).toEqual([{ compartment_id: 91 }]);
	});

	it.each(["aspect", "attribute"])("excludes unreadable %s rows from pass graph write caps", async (child) => {
		insertEntity("cap-parent", "Partition cap project", "partition cap project", "ant", 1);
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id = 91 WHERE id = 'cap-parent'").run();
			db.prepare(
				"INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, compartment_id) VALUES ('cap-aspect', 'cap-parent', 'ant', 'facts', 'facts', ?)",
			).run(child === "aspect" ? 93 : 91);
			if (child === "attribute")
				db.prepare(
					"INSERT INTO entity_attributes (id, aspect_id, agent_id, kind, content, normalized_content, claim_key, compartment_id) VALUES ('hidden-cap-attribute', 'cap-aspect', 'ant', 'attribute', 'Hidden claim', 'hidden claim', 'hidden-slot', 93)",
				).run();
		});
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: child === "aspect" ? "create_aspect" : "add_claim_value",
			payload:
				child === "aspect"
					? { entity_id: "cap-parent", name: "Public facts" }
					: { entity: "Partition cap project", aspect: "facts", claim_key: "new-slot", value: "Visible claim" },
			writeCaps: { maxAspectsPerEntity: 1, maxAttributesPerAspect: 1 },
		});
		expect(result.proposal.status).toBe("applied");
	});

	it.each(["pass-alpha", "pass-delegated"])(
		"preserves the durable pass label when rebuilding a semantic row supported by ordinary evidence (%s)",
		async (passId) => {
			partitionFixture();
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					"INSERT INTO memories (id, content, agent_id, memory_kind, created_at, updated_at) VALUES ('rebuild-source', 'Rebuild evidence', 'ant', 'episodic', datetime('now'), datetime('now'))",
				).run();
				if (passId === "pass-delegated")
					db.prepare(
						"INSERT INTO dreaming_passes (id, agent_id, scope_key, compartment_id) VALUES ('pass-delegated', 'runner', 'ant', 91)",
					).run();
			});
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "dreaming",
				passId,
				operation: "create_entity",
				payload: { name: "Rebuild partition project" },
				evidence: [{ source_ref: "memory:rebuild-source" }],
			});
			await getDbAccessor().withWriteDbAsync((db) => executeClassification(db, { op: "rebuild", agentId: "ant" }));
			await getDbAccessor().withWriteDbAsync((db) => executeClassification(db, { op: "rebuild", agentId: "ant" }));
			expect(
				getDbAccessor().withReadDb((db) =>
					db.prepare("SELECT compartment_id FROM entities WHERE name = 'Rebuild partition project'").get(),
				),
			).toEqual({ compartment_id: 91 });
			expect(
				getDbAccessor().withReadDb((db) =>
					db.prepare("SELECT compartment_id FROM dreaming_passes WHERE id = ?").get(passId),
				),
			).toEqual({ compartment_id: 91 });
		},
	);

	it("does not mutate or consult an unrelated hidden contradiction during an entity rename", async () => {
		insertEntity("rename-partition", "Rename partition project", "rename partition project", "ant", 1);
		partitionFixture();
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id = 91 WHERE id = 'rename-partition'").run();
			db.prepare(`INSERT INTO ontology_contradictions
				(id, agent_id, entity_id, entity_name, aspect_name, claim_key, left_content, right_content,
				detector, reason, detected_at, created_at, updated_at, compartment_id)
				VALUES ('unrelated-hidden', 'ant', 'rename-partition', 'Rename partition project', 'Hidden facts', 'hidden', 'Enabled', 'Disabled', 'lexical', 'Hidden conflict', datetime('now'), datetime('now'), datetime('now'), 93)`).run();
		});
		const renamed = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: "rename_entity",
			payload: { entity_id: "rename-partition", new_name: "Renamed partition project" },
		});
		expect(renamed.proposal.status).toBe("applied");
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status, compartment_id FROM ontology_contradictions WHERE id = 'unrelated-hidden'").get(),
			),
		).toEqual({ status: "active", compartment_id: 93 });
	});

	it("records proposal copy edges to the semantic claim it mutates", async () => {
		const claim = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "add_claim_value",
			payload: { entity: "Proposal copy project", aspect: "facts", claim_key: "copy", value: "A copied claim" },
		});
		const archived = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "archive_claim_value",
			payload: { attribute_id: claim.result?.attributeId },
		});
		const citations = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					"SELECT evidence_kind, evidence_id FROM evidence_citations WHERE derived_kind = 'proposal' AND derived_id = ?",
				)
				.all(archived.proposal.id),
		);
		expect(citations).toContainEqual({ evidence_kind: "attribute", evidence_id: claim.result?.attributeId });
		expect(citations).toContainEqual({ evidence_kind: "memory", evidence_id: claim.result?.memoryId });
	});

	it("updates an existing entity's pass provenance when a wider current partition mutates it", async () => {
		partitionFixture();
		const created = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-alpha",
			operation: "create_entity",
			payload: { name: "Pass provenance project" },
		});
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare("UPDATE entities SET dreaming_pass_id = 'pass-alpha', compartment_id = 93 WHERE id = ?")
				.run(created.result?.entityId),
		);
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			passId: "pass-both",
			operation: "rename_entity",
			payload: { entity_id: created.result?.entityId, new_name: "Updated pass provenance project" },
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id, dreaming_pass_id FROM entities WHERE id = ?").get(created.result?.entityId),
			),
		).toEqual({ compartment_id: 93, dreaming_pass_id: "pass-both" });
	});

	it("attributes a proposal to the unambiguous author of its summary evidence", async () => {
		partitionFixture();
		getDbAccessor().withWriteTx((db) =>
			db
				.prepare(
					"INSERT INTO session_summaries (id, depth, kind, content, earliest_at, latest_at, agent_id, author_user_id, created_at) VALUES ('authored-summary', 0, 'session', 'A summary attributed to Alice.', datetime('now'), datetime('now'), 'ant', 'alice', datetime('now'))",
				)
				.run(),
		);
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			passId: "pass-alpha",
			operation: "create_entity",
			payload: { name: "Summary authorship project" },
			evidence: [{ source_ref: "summary:authored-summary", quote: "A summary attributed to Alice." }],
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT author_user_id FROM ontology_proposals WHERE id = ?").get(proposal.id),
			),
		).toEqual({ author_user_id: "alice" });
	});

	it("records canonical proposal and materialized claim citations atomically", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(`INSERT INTO memories
				(id, content, agent_id, memory_kind, created_at, updated_at, author_user_id)
				VALUES ('citation-source', 'A durable claim', 'ant', 'episodic', datetime('now'), datetime('now'), 'alice')`).run();
		});
		const applied = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "dreaming",
			operation: "add_claim_value",
			payload: { entity: "Citation project", aspect: "facts", claim_key: "durable", value: "A durable claim" },
			evidence: [{ source_ref: "memory:citation-source", quote: "A durable claim" }],
		});
		const stored = getDbAccessor().withReadDb((db) =>
			db
				.prepare(
					"SELECT derived_kind FROM evidence_citations WHERE evidence_kind = 'memory' AND evidence_id = 'citation-source' ORDER BY derived_kind",
				)
				.all(),
		);
		expect(stored).toEqual([
			{ derived_kind: "aspect" },
			{ derived_kind: "attribute" },
			{ derived_kind: "entity" },
			{ derived_kind: "memory" },
			{ derived_kind: "proposal" },
		]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT author_user_id FROM ontology_proposals WHERE id = ?").get(applied.proposal.id),
			),
		).toEqual({ author_user_id: "alice" });
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT actor_user_id, actor_credential FROM audit_events WHERE action = 'memory.created'").get(),
			),
		).toEqual({ actor_user_id: null, actor_credential: "system" });

		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT author_user_id FROM memories WHERE id = ?").get(applied.result?.memoryId),
			),
		).toEqual({ author_user_id: "alice" });
	});

	it("rejects foreign episodic provenance without leaving partial source links", () => {
		getDbAccessor().withWriteTx((db) => {
			for (const [id, agent] of [
				["derived-target", "ant"],
				["own-source", "ant"],
				["foreign-source", "bee"],
			]) {
				db.prepare(`INSERT INTO memories (id, content, agent_id, created_at, updated_at)
					VALUES (?, 'Evidence', ?, datetime('now'), datetime('now'))`).run(id, agent);
			}
		});
		expect(() =>
			getDbAccessor().withWriteTx((db) =>
				linkDerivedMemorySourcesInTx(db, {
					derivedMemoryId: "derived-target",
					agentId: "ant",
					createdAt: "2026-11-25T00:00:00.000Z",
					sources: [
						{ sourceKind: "memory", sourceId: "own-source" },
						{ sourceKind: "memory", sourceId: "foreign-source" },
					],
				}),
			),
		).toThrow("authorized agent scope");
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS count FROM derived_memory_sources").get()),
		).toEqual({ count: 0 });
	});

	it("applies an add_claim_value proposal into a grouped claim slot with provenance", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Ontology extraction preserves provenance before mutating semantic state.",
			},
			confidence: 0.92,
			rationale: "Explicit architecture decision from transcript evidence.",
			evidence: [{ source: "transcript:test", message_ids: ["m1"] }],
			sourceKind: "transcript",
			sourceId: "transcript:test",
			sourcePath: "memory/test-transcript.jsonl",
			createdBy: "test",
		});

		expect(proposal.status).toBe("pending");

		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: proposal.id,
			actor: "ant",
		});

		expect(applied.status).toBe("applied");
		expect(applied.appliedBy).toBe("ant");
		expect(typeof applied.result?.attributeId).toBe("string");

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.agent_id, e.entity_type, asp.name AS aspect, attr.group_key,
							        attr.claim_key, attr.content, attr.confidence, attr.source_kind,
							        attr.proposal_id, attr.proposal_evidence
							 FROM entity_attributes attr
							 JOIN entity_aspects asp ON asp.id = attr.aspect_id
							 JOIN entities e ON e.id = asp.entity_id
						 WHERE e.name = ? AND e.agent_id = ?`,
					)
					.get("Signet", "ant") as
					| {
							agent_id: string;
							entity_type: string;
							aspect: string;
							group_key: string;
							claim_key: string;
							content: string;
							confidence: number;
							source_kind: string;
							proposal_id: string;
							proposal_evidence: string;
					  }
					| undefined,
		);

		expect(row?.agent_id).toBe("ant");
		expect(row?.entity_type).toBe("project");
		expect(row?.aspect).toBe("architecture");
		expect(row?.group_key).toBe("ontology");
		expect(row?.claim_key).toBe("proposal_loop");
		expect(row?.content).toContain("preserves provenance");
		expect(row?.confidence).toBeCloseTo(0.92);
		expect(row?.source_kind).toBe("transcript");
		expect(row?.proposal_id).toBe(proposal.id);

		const projection = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT attr.id AS attribute_id, attr.memory_id, mem.content, mem.type, mem.memory_kind,
						        mem.source_type, mem.source_id,
						        (SELECT COUNT(*) FROM memory_entity_mentions WHERE memory_id = attr.memory_id) AS mentions
						 FROM entity_attributes attr
						 JOIN entity_aspects asp ON asp.id = attr.aspect_id
						 JOIN memories mem ON mem.id = attr.memory_id
						 WHERE asp.entity_id = (SELECT id FROM entities WHERE name = 'Signet' AND agent_id = 'ant')`,
					)
					.get() as
					| {
							attribute_id: string;
							memory_id: string;
							content: string;
							type: string;
							memory_kind: string | null;
							source_type: string;
							source_id: string;
							mentions: number;
					  }
					| undefined,
		);
		expect(projection).toMatchObject({
			attribute_id: projection?.memory_id,
			content: "Ontology extraction preserves provenance before mutating semantic state.",
			type: "semantic",
			memory_kind: "derived",
			source_type: "ant",
			source_id: "transcript:test",
			mentions: 1,
		});
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([{ source: "transcript:test", message_ids: ["m1"] }]);
	});

	it("records canonical episodic lineage and stales aggregate snapshots when a claim changes", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
				 VALUES ('episodic-source', 'Signet is a local-first memory system.', 'fact', 'ant', 'global', 'episodic', ?, ?)`,
			).run("2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
		});
		const initial = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "core",
				claim_key: "purpose",
				value: "Signet is a local-first memory system.",
			},
			evidence: [
				{
					source_ref: "memory:episodic-source",
					source_kind: "manual",
					source_id: "episodic-source",
					quote: "Signet is a local-first memory system.",
				},
			],
			sourceKind: "manual",
			sourceId: "episodic-source",
		});
		const claimId = initial.result?.attributeId;
		if (typeof claimId !== "string") throw new Error("Missing claim id");

		getDbAccessor().withWriteTx((db) => {
			txIngestEnvelope(db, {
				author: { userId: null, credential: "system" },
				id: "aggregate-snapshot",
				content: "Signet is a local-first memory system.",
				contentHash: "aggregate-snapshot",
				who: "signet",
				why: "aggregate recall",
				project: null,
				importance: 0.7,
				type: "semantic",
				tags: "aggregate,recall",
				pinned: 0,
				sourceType: "aggregate-recall",
				sourceId: "aggregate-snapshot",
				agentId: "ant",
				visibility: "private",
				createdAt: "2026-08-04T00:00:00.000Z",
			});
			linkDerivedMemorySourcesInTx(db, {
				derivedMemoryId: "aggregate-snapshot",
				agentId: "ant",
				sources: [{ sourceKind: "ontology_claim", sourceId: claimId }],
				createdAt: "2026-08-04T00:00:00.000Z",
			});
		});

		const lineage = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT source_kind, source_id FROM derived_memory_sources WHERE derived_memory_id = ? ORDER BY source_kind",
					)
					.all(claimId) as Array<{ source_kind: string; source_id: string }>,
		);
		expect(lineage).toEqual([{ source_kind: "memory", source_id: "episodic-source" }]);

		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "core",
				claim_key: "purpose",
				value: "Signet is a local-first memory system with a semantic layer.",
			},
			evidence: [
				{
					source_ref: "memory:episodic-source",
					source_kind: "manual",
					source_id: "episodic-source",
					quote: "Signet is a local-first memory system.",
				},
			],
			sourceKind: "manual",
			sourceId: "episodic-source",
		});

		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT stale_at FROM memories WHERE id = ? AND agent_id = ?").get("aggregate-snapshot", "ant"),
			),
		).toMatchObject({ stale_at: expect.any(String) });
	});

	it("rejects invalid proposal source_refs before creating proposals or semantic memory provenance (#1343)", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
				 VALUES
				 ('valid-source', 'Valid same-scope evidence.', 'fact', 'ant', 'global', 'episodic', ?, ?),
				 ('pending-source', 'Evidence for a pending proposal.', 'fact', 'ant', 'global', 'episodic', ?, ?),
				 ('other-source', 'Other agent evidence.', 'fact', 'other', 'global', 'episodic', ?, ?)`,
			).run(
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
			);
		});
		const payload = (claimKey: string) => ({
			entity: "Strict Provenance",
			entity_type: "project",
			aspect: "evidence",
			claim_key: claimKey,
			value: "Source resolution must precede semantic memory materialization.",
		});
		const counts = () =>
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT
							 (SELECT COUNT(*) FROM ontology_proposals WHERE agent_id = 'ant') AS proposals,
							 (SELECT COUNT(*) FROM entity_attributes WHERE agent_id = 'ant') AS attributes,
							 (SELECT COUNT(*) FROM memories WHERE agent_id = 'ant' AND memory_kind = 'derived') AS derived,
							 (SELECT COUNT(*) FROM derived_memory_sources WHERE agent_id = 'ant') AS links`,
						)
						.get() as { proposals: number; attributes: number; derived: number; links: number },
			);

		const valid = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "set_claim_value",
			payload: payload("valid"),
			evidence: [{ source_ref: "memory:valid-source" }],
		});
		expect(valid.result?.memoryId).toBe(valid.result?.attributeId);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_kind, source_id FROM derived_memory_sources WHERE derived_memory_id = ?")
						.get(valid.result?.memoryId) as { source_kind: string; source_id: string } | undefined,
			),
		).toEqual({ source_kind: "memory", source_id: "valid-source" });

		const deduped = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "set_claim_value",
			payload: payload("valid"),
			evidence: [{ source_ref: "memory:valid-source" }],
		});
		expect(deduped.result?.deduped).toBe(true);
		expect(deduped.result?.attributeId).toBe(valid.result?.attributeId);
		expect(counts()).toEqual({ proposals: 2, attributes: 1, derived: 1, links: 1 });

		const beforeRejectedWrites = counts();
		await expect(
			createOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				operation: "set_claim_value",
				payload: payload("missing"),
				evidence: [{ source_ref: "memory:missing-source" }],
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref was not found: memory:missing-source", 409));
		await expect(
			createOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				operation: "set_claim_value",
				payload: payload("cross_scope"),
				evidence: [{ source_ref: "memory:other-source" }],
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref crosses the authorized agent scope", 409));
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "set_claim_value",
				payload: payload("blank"),
				evidence: [{ source_ref: "memory:" }],
				propose: true,
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref must name a canonical episodic source", 409));
		await expect(
			applyOntologyOperationBatch(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				propose: true,
				operations: [
					{
						operation: "set_claim_value",
						payload: payload("batch_valid"),
						evidence: [{ source_ref: "memory:valid-source" }],
					},
					{
						operation: "set_claim_value",
						payload: payload("batch_missing"),
						evidence: [{ source_ref: "memory:missing-source" }],
					},
				],
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref was not found: memory:missing-source", 409));
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "set_claim_value",
				payload: payload("direct_missing"),
				evidence: [{ source_ref: "memory:missing-source" }],
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref was not found: memory:missing-source", 409));
		expect(counts()).toEqual(beforeRejectedWrites);

		const pending = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "set_claim_value",
			payload: payload("deleted_before_apply"),
			evidence: [{ source_ref: "memory:pending-source" }],
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = ? AND agent_id = ?").run("pending-source", "ant");
		});
		const beforeDeletedSourceApply = counts();
		await expect(
			applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				id: pending.id,
				actor: "test",
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref was not found: memory:pending-source", 409));
		expect(counts()).toEqual(beforeDeletedSourceApply);
		expect((await getOntologyProposal(getDbAccessor(), pending.id, "ant"))?.status).toBe("pending");
	});

	it("rejects fabricated and cross-agent semantic premise links before persistence (#1343)", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT OR IGNORE INTO memories (id, content, agent_id, created_at, updated_at) VALUES ('derived-premise-target', 'Derived target', 'ant', datetime('now'), datetime('now'))",
			).run();
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('foreign-entity', 'Foreign', 'foreign', 'project', 'other', 1, ?, ?)`,
			).run("2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('foreign-aspect', 'foreign-entity', 'other', 'evidence', 'evidence', 0.8, ?, ?)`,
			).run("2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at)
				 VALUES ('foreign-attribute', 'foreign-aspect', 'other', 'attribute', 'Foreign premise', 'foreign premise', 0.8, 0.7, 'active', ?, ?)`,
			).run("2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
		});

		const link = (sourceId: string) =>
			getDbAccessor().withWriteTx((db) =>
				linkDerivedMemorySourcesInTx(db, {
					derivedMemoryId: "derived-premise-target",
					agentId: "ant",
					sources: [{ sourceKind: "ontology_claim", sourceId }],
					createdAt: "2026-08-04T00:00:00.000Z",
				}),
			);

		expect(() => link("missing-attribute")).toThrow(
			"Derived memory provenance semantic premise is not in the authorized agent scope: missing-attribute",
		);
		expect(() => link("foreign-attribute")).toThrow(
			"Derived memory provenance semantic premise is not in the authorized agent scope: foreign-attribute",
		);
	});

	it("rejects a deduped claim apply whose evidence source disappeared after creation", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
				 VALUES
				 ('dedupe-live', 'Live dedupe evidence.', 'fact', 'ant', 'global', 'episodic', ?, ?),
				 ('dedupe-gone', 'Evidence that will disappear.', 'fact', 'ant', 'global', 'episodic', ?, ?)`,
			).run(
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
				"2026-08-04T00:00:00.000Z",
			);
		});
		const payload = {
			entity: "Dedupe Provenance",
			entity_type: "project",
			aspect: "evidence",
			claim_key: "dedupe_slot",
			value: "Deduped applies must still revalidate their evidence.",
		};

		const first = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "set_claim_value",
			payload,
			evidence: [{ source_ref: "memory:dedupe-live" }],
		});
		expect(first.proposal.status).toBe("applied");
		expect(first.result?.attributeId).toBeTypeOf("string");

		const pending = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "set_claim_value",
			payload,
			evidence: [{ source_ref: "memory:dedupe-gone" }],
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = ? AND agent_id = ?").run("dedupe-gone", "ant");
		});

		const before = getDbAccessor().withReadDb((db) => {
			const attributeCount = (
				db.prepare("SELECT COUNT(*) AS c FROM entity_attributes WHERE agent_id = ?").get("ant") as { c: number }
			).c;
			const derivedCount = (
				db.prepare("SELECT COUNT(*) AS c FROM memories WHERE agent_id = ? AND memory_kind = 'derived'").get("ant") as {
					c: number;
				}
			).c;
			return { attributeCount, derivedCount };
		});
		await expect(
			applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				id: pending.id,
				actor: "test",
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref was not found: memory:dedupe-gone", 409));

		const after = getDbAccessor().withReadDb((db) => {
			const attributeCount = (
				db.prepare("SELECT COUNT(*) AS c FROM entity_attributes WHERE agent_id = ?").get("ant") as { c: number }
			).c;
			const derivedCount = (
				db.prepare("SELECT COUNT(*) AS c FROM memories WHERE agent_id = ? AND memory_kind = 'derived'").get("ant") as {
					c: number;
				}
			).c;
			return { attributeCount, derivedCount };
		});
		expect(after).toEqual(before);
		expect((await getOntologyProposal(getDbAccessor(), pending.id, "ant"))?.status).toBe("pending");
	});

	it("rejects a non-materializing apply whose evidence source disappeared after creation", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
				 VALUES ('entity-gone', 'Entity evidence that will disappear.', 'fact', 'ant', 'global', 'episodic', ?, ?)`,
			).run("2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
		});

		const pending = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "create_entity",
			payload: { name: "Orphaned Evidence Entity", entity_type: "concept" },
			evidence: [{ source_ref: "memory:entity-gone" }],
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = ? AND agent_id = ?").run("entity-gone", "ant");
		});
		await expect(
			applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				id: pending.id,
				actor: "test",
			}),
		).rejects.toThrow(new OntologyProposalError("Evidence source_ref was not found: memory:entity-gone", 409));
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT COUNT(*) AS c FROM entities WHERE agent_id = ? AND name = ?")
						.get("ant", "Orphaned Evidence Entity") as { c: number },
			),
		).toEqual({ c: 0 });
		expect((await getOntologyProposal(getDbAccessor(), pending.id, "ant"))?.status).toBe("pending");
	});

	it("rejects generic entity labels before creating ontology entities", async () => {
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_entity",
				payload: { name: "the", entity_type: "project" },
			}),
		).rejects.toThrow("Entity name rejected: generic_or_scaffolding_name");
		expect(
			getDbAccessor().withReadDb(
				(db) => db.prepare("SELECT COUNT(*) AS count FROM entities WHERE agent_id = ?").get("ant") as { count: number },
			),
		).toEqual({ count: 0 });
	});

	it("creates an unnamed user as a person but not as an untyped label", async () => {
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_entity",
				payload: { name: "User" },
			}),
		).rejects.toThrow("Entity name rejected: metadata_role");
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "User", entity_type: "person" },
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT entity_type FROM entities WHERE agent_id = ? AND name = ?").get("ant", "User") as {
						entity_type: string;
					},
			),
		).toEqual({ entity_type: "person" });
	});

	it("does not archive an aspect that has an active constraint without force", async () => {
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "set_claim_value",
			payload: {
				entity: "Constraint Guard",
				entity_type: "project",
				aspect: "retention",
				claim_key: "source_of_truth",
				value: "Artifacts remain immutable evidence.",
				kind: "constraint",
			},
		});

		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "archive_aspect",
				payload: { entity: "Constraint Guard", selector: "retention" },
			}),
		).rejects.toThrow("Refusing to archive aspect with active constraint attributes without force");
		const applied = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "archive_aspect",
			payload: { entity: "Constraint Guard", selector: "retention", force: true },
		});
		expect(applied.proposal.status).toBe("applied");
	});

	it("rejects a pending proposal without mutating graph state", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Temporary Entity", entity_type: "concept" },
			rationale: "Low confidence extraction.",
		});

		const rejected = await rejectOntologyProposal(getDbAccessor(), {
			agentId: "default",
			id: proposal.id,
			actor: "operator",
			reason: "weak evidence",
		});

		expect(rejected.status).toBe("rejected");
		expect(rejected.result?.reason).toBe("weak evidence");

		const entity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE name = ?").get("Temporary Entity") as { id: string } | undefined,
		);
		expect(entity).toBeNull();
	});

	it("awaits failure status persistence before rethrowing an apply error", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			operation: "unsupported_operation",
			payload: { unsupported: true },
		});

		await expect(
			applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				id: proposal.id,
				actor: "operator",
			}),
		).rejects.toThrow("Unsupported ontology proposal operation: unsupported_operation");

		const failed = await getDbAccessor().withReadDbAsync(
			async (db) =>
				db.prepare("SELECT status FROM ontology_proposals WHERE id = ?").get(proposal.id) as { status: string },
		);
		expect(failed.status).toBe("failed");
	});

	it("returns the rejected proposal body from the HTTP route", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Route Rejection", entity_type: "project" },
		});
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("author", { userId: null, credential: "local" });
			await next();
		});
		registerOntologyRoutes(app);

		const response = await app.request(`/api/ontology/proposals/${proposal.id}/reject?agent_id=default`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ actor: "operator", reason: "route regression" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: proposal.id, status: "rejected" });
	});

	it("rejects empty proposal operations before storage", async () => {
		await expect(
			createOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				operation: "   ",
				payload: { name: "Missing Operation" },
			}),
		).rejects.toThrow(OntologyProposalError);
	});

	it("creates proposal batches atomically in one agent scope", async () => {
		const batch = await createOntologyProposals(getDbAccessor(), [
			{
				agentId: "ant",
				operation: "create_entity",
				payload: { name: "Transcript Artifact", entity_type: "source" },
				sourceKind: "transcript",
				sourceId: "transcript:1",
				createdBy: "importer",
			},
			{
				agentId: "ant",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					claim_key: "maintenance_loop",
					value: "Extraction emits provenance-backed operations before ontology mutation.",
				},
				evidence: [{ transcript_id: "transcript:1", message_ids: ["m1"] }],
				confidence: 0.8,
				sourceKind: "transcript",
				sourceId: "transcript:1",
				createdBy: "importer",
			},
		]);

		expect(batch.count).toBe(2);
		expect(batch.items.map((item) => item.status)).toEqual(["pending", "pending"]);
		expect(batch.items.every((item) => item.agentId === "ant")).toBe(true);
		expect(batch.items[1]?.evidence).toHaveLength(1);

		const listed = await listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "add_claim_value" });
		expect(listed.items).toHaveLength(1);
		expect(listed.items[0]?.createdBy).toBe("importer");
		expect(listed.items[0]?.sourceKind).toBe("transcript");
	});

	it("extracts candidate proposals from explicit transcript extraction JSON", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:extract",
				JSON.stringify({
					claim_values: [
						{
							entity: "Signet",
							aspect: "architecture",
							group_key: "ontology",
							claim_key: "proposal_loop",
							value: "Extraction emits pending proposals.",
							confidence: 0.91,
							evidence: [{ transcript_id: "transcript:extract", quote: "Extraction emits pending proposals." }],
						},
					],
					links: [
						{
							source_entity: "Transcript artifact",
							link_type: "supports_claim",
							target_entity: "Signet",
							reason: "The transcript explicitly supports the claim.",
						},
					],
				}),
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const dryRun = await extractOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			from: "transcript:extract",
		});

		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.count).toBe(2);
		expect(dryRun.writtenCount).toBe(0);
		expect(dryRun.proposals.map((proposal) => proposal.operation)).toEqual(["add_claim_value", "create_link"]);

		const written = await extractOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			from: "transcript:extract",
			writeProposals: true,
			createdBy: "test-extractor",
		});

		expect(written.dryRun).toBe(false);
		expect(written.writtenCount).toBe(2);
		expect(written.items.map((item) => item.createdBy)).toEqual(["test-extractor", "test-extractor"]);
		expect(written.items.every((item) => item.sourceKind === "transcript")).toBe(true);
	});

	it("writes extracted assertions without marking the response as a dry run", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 1);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"assertion-extract",
				JSON.stringify({
					assertions: [
						{
							entity: "Signet",
							predicate: "believes",
							content: "Signet should model who believes what over time.",
							speaker: "Nicholai",
							confidence: 0.91,
							evidence: [{ quote: "who believes what" }],
						},
					],
				}),
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const result = await extractOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			from: "transcript:assertion-extract",
			writeAssertions: true,
		});

		expect(result.dryRun).toBe(false);
		expect(result.writtenCount).toBe(0);
		expect(result.writtenAssertionCount).toBe(1);
		expect(result.assertionItems[0]?.predicate).toBe("believes");
	});

	it("rolls back proposal and assertion extraction when one assertion is invalid", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 1);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"invalid-assertion-extract",
				JSON.stringify({
					proposals: [
						{
							operation: "create_entity",
							payload: { name: "Rollback Candidate", entity_type: "concept" },
							confidence: 0.7,
							rationale: "Candidate from source evidence.",
							evidence: [{ quote: "candidate" }],
						},
					],
					assertions: [
						{
							entity: "Signet",
							predicate: "claims",
							content: "Signet keeps attributed assertions.",
							evidence: [{ quote: "attributed assertions" }],
						},
						{
							entity: "Signet",
							predicate: "maybe",
							content: "This invalid assertion should roll back the batch.",
							evidence: [{ quote: "invalid assertion" }],
						},
					],
				}),
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		await expect(
			extractOntologyProposals(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				from: "transcript:invalid-assertion-extract",
				writeProposals: true,
				writeAssertions: true,
			}),
		).rejects.toThrow("predicate is invalid");

		expect((await listOntologyProposals(getDbAccessor(), { agentId: "ant" })).items).toHaveLength(0);
		expect((await listEpistemicAssertions(getDbAccessor(), { agentId: "ant", status: "all" })).items).toHaveLength(0);
	});

	it("mechanically extracts conservative proposals from plain transcript text", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"plain-extract",
				"Signet should become an agent-first ontology. [[Hermes Agent]] is relevant. Hermes Agent supports Signet proposal loop.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const result = await extractOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			from: "transcript:plain-extract",
		});

		expect(result.proposals.some((proposal) => proposal.operation === "create_entity")).toBe(true);
		expect(result.proposals.some((proposal) => proposal.operation === "add_claim_value")).toBe(true);
		expect(result.proposals.some((proposal) => proposal.operation === "create_link")).toBe(true);
		expect(result.proposals.every((proposal) => proposal.evidence && proposal.evidence.length > 0)).toBe(true);
	});

	it("uses an inference provider for ontology extraction when requested", async () => {
		const prompts: string[] = [];
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"provider-extract",
				"User: Signet ontology extraction should route through the inference registry when explicitly requested.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
		});

		const result = await extractOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			from: "transcript:provider-extract",
			useProvider: true,
			provider: {
				name: "test-provider",
				async available() {
					return true;
				},
				async generate(prompt) {
					prompts.push(prompt);
					return JSON.stringify({
						claim_values: [
							{
								entity: "Signet",
								aspect: "architecture",
								group_key: "ontology",
								claim_key: "provider_extraction",
								value: "Ontology extraction can use the configured inference workload.",
								confidence: 0.88,
								evidence: [
									{
										source_kind: "transcript",
										source_id: "provider-extract",
										quote: "route through the inference registry",
									},
								],
							},
						],
						questions: ["Should provider extraction become the default for strong-model maintenance?"],
					});
				},
			},
		});

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Return ONLY JSON");
		expect(result.extractionMode).toBe("provider");
		expect(result.providerName).toBe("test-provider");
		expect(result.warnings).toHaveLength(0);
		expect(result.questions).toEqual(["Should provider extraction become the default for strong-model maintenance?"]);
		expect(result.proposals).toHaveLength(1);
		expect(result.proposals[0]?.payload.claim_key).toBe("provider_extraction");
	});

	it("consolidates pending proposals through an inference provider without direct mutation", async () => {
		await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Extraction should preserve source evidence first.",
			},
			confidence: 0.72,
			rationale: "Raw extraction candidate.",
		});
		await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Ontology maintenance should apply high-confidence operations with provenance.",
			},
			confidence: 0.8,
			rationale: "Second raw extraction candidate.",
		});

		const dryRun = await consolidateOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			useProvider: true,
			provider: {
				name: "test-consolidator",
				async available() {
					return true;
				},
				async generate(prompt) {
					expect(prompt).toContain("Pending proposals");
					return JSON.stringify({
						summary: "Combined two noisy proposal-loop candidates.",
						proposals: [
							{
								operation: "add_claim_value",
								payload: {
									entity: "Signet",
									aspect: "architecture",
									group_key: "ontology",
									claim_key: "proposal_loop",
									value: "Signet ontology maintenance uses apply-first operations with provenance.",
								},
								confidence: 0.9,
								rationale: "The pending proposals agree on apply-first provenance semantics.",
								evidence: [{ source_kind: "ontology_proposal", source_id: "candidate", quote: "apply first" }],
							},
						],
						rejections: [{ candidate_id: "duplicate", reason: "duplicate" }],
					});
				},
			},
		});

		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.consolidationMode).toBe("provider");
		expect(dryRun.writtenCount).toBe(0);
		expect(dryRun.proposals).toHaveLength(1);
		expect(dryRun.rejections).toHaveLength(1);

		const written = await consolidateOntologyProposals(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			useProvider: true,
			writeProposals: true,
			createdBy: "test-consolidator",
			provider: {
				name: "test-consolidator",
				async available() {
					return true;
				},
				async generate() {
					return JSON.stringify({
						proposals: [
							{
								operation: "add_claim_value",
								payload: {
									entity: "Signet",
									aspect: "architecture",
									group_key: "ontology",
									claim_key: "proposal_loop",
									value: "Signet ontology maintenance uses apply-first operations with provenance.",
								},
							},
						],
					});
				},
			},
		});

		expect(written.dryRun).toBe(false);
		expect(written.writtenCount).toBe(1);
		expect(written.items[0]?.createdBy).toBe("test-consolidator");
		expect(written.items[0]?.sourceKind).toBe("ontology_consolidation");
	});

	it("resolves proposal evidence from transcripts and indexed artifacts", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:1",
				"User: Signet extraction should emit proposals. Assistant: The ontology only mutates after review.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				"memory/codex/transcripts/transcript.jsonl",
				"sha",
				"transcript",
				"session-1",
				"transcript:1",
				"token-1",
				"codex",
				"2026-05-06T00:01:00.000Z",
				"Canonical artifact says applied operations preserve lineage back to source truth.",
				"2026-05-06T00:01:00.000Z",
			);
		});
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				claim_key: "review_loop",
				value: "Ontology proposals are reviewed before mutation.",
			},
			evidence: [
				{
					transcript_id: "transcript:1",
					quote: "ontology only mutates after review",
				},
			],
			sourceKind: "transcript",
			sourceId: "transcript:1",
			sourcePath: "memory/codex/transcripts/transcript.jsonl",
		});

		const evidence = await getOntologyProposalEvidence(getDbAccessor(), proposal.id, "ant");

		expect(evidence.count).toBe(2);
		expect(evidence.items[0]?.kind).toBe("session_transcript");
		expect(evidence.items[0]?.excerpt).toContain("mutates after review");
		expect(evidence.items[1]?.kind).toBe("memory_artifact");
		expect(evidence.items[1]?.excerpt).toContain("preserve lineage");
	});

	it("resolves applied claim evidence from stored attribute provenance", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:claim",
				"User: Signet claims need evidence after proposal application.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				"memory/codex/transcripts/claim.jsonl",
				"sha-claim",
				"transcript",
				"session-claim",
				"transcript:claim",
				"token-claim",
				"codex",
				"2026-05-06T00:01:00.000Z",
				"Artifact source truth says applied claims still need auditable lineage.",
				"2026-05-06T00:01:00.000Z",
			);
		});
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "claim_evidence",
				value: "Applied ontology claims retain source-backed evidence.",
			},
			confidence: 0.88,
			sourceKind: "transcript",
			sourceId: "transcript:claim",
			sourcePath: "memory/codex/transcripts/claim.jsonl",
		});
		await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: proposal.id,
			actor: "ant",
		});

		const evidence = await getOntologyClaimEvidence(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "claim_evidence",
		});

		expect(evidence.count).toBe(1);
		expect(evidence.items[0]?.attribute.sourceKind).toBe("transcript");
		expect(evidence.items[0]?.attribute.sourcePath).toBe("memory/codex/transcripts/claim.jsonl");
		expect(evidence.items[0]?.attribute.proposalId).toBe(proposal.id);
		expect(evidence.items[0]?.evidence.map((item) => item.kind)).toEqual([
			"ontology_proposal",
			"session_transcript",
			"memory_artifact",
			"memory",
		]);
		expect(evidence.items[0]?.evidence[0]?.label).toBe(`proposal:${proposal.id}`);
		expect(evidence.items[0]?.evidence[1]?.excerpt).toContain("evidence after proposal application");
		expect(evidence.items[0]?.evidence[2]?.excerpt).toContain("auditable lineage");
	});

	it("falls back to embedded quotes when source rows are not present", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Quoted Evidence" },
			evidence: [{ transcript_id: "missing", quote: "This quote still explains the proposal." }],
		});

		const evidence = await getOntologyProposalEvidence(getDbAccessor(), proposal.id, "default");

		expect(evidence.items).toHaveLength(1);
		expect(evidence.items[0]?.kind).toBe("provided_quote");
		expect(evidence.items[0]?.excerpt).toBe("This quote still explains the proposal.");
	});

	it("falls back to an embedded quote when a referenced ontology proposal is missing", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			operation: "create_entity",
			payload: { name: "Missing Proposal Evidence" },
			evidence: [{ proposal_id: "missing-proposal", quote: "The embedded proposal quote." }],
		});

		const evidence = await getOntologyProposalEvidence(getDbAccessor(), proposal.id, "default");

		expect(evidence.items).toEqual([
			expect.objectContaining({
				kind: "provided_quote",
				found: true,
				sourceKind: "ontology_proposal",
				sourceId: "missing-proposal",
				excerpt: "The embedded proposal quote.",
			}),
		]);
	});

	it("applies supersede_claim_value by preserving old values and adding replacements", async () => {
		const initial = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "current_loop",
				value: "Extraction writes directly into ontology state.",
			},
			confidence: 0.4,
		});
		const initialApplied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: initial.id,
			actor: "test",
		});
		const oldId = initialApplied.result?.attributeId;
		if (typeof oldId !== "string") throw new Error("initial attribute id was not returned");

		const supersede = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "supersede_claim_value",
			payload: {
				entity: "Signet",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "current_loop",
				old_value: "Extraction writes directly into ontology state.",
				new_value: "Extraction writes provenance-backed operations before ontology mutation.",
				confidence: 0.93,
			},
			sourceKind: "transcript",
			sourceId: "transcript:proposal-loop",
		});

		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: supersede.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		const replacementId = applied.result?.replacementAttributeId;
		if (typeof replacementId !== "string") throw new Error("replacement attribute id was not returned");
		expect(applied.result?.supersededAttributeIds).toEqual([oldId]);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT id, content, status, superseded_by, confidence, source_kind
						 FROM entity_attributes
						 WHERE id IN (?, ?)
						 ORDER BY status DESC`,
					)
					.all(oldId, replacementId) as Array<{
					id: string;
					content: string;
					status: string;
					superseded_by: string | null;
					confidence: number;
					source_kind: string | null;
				}>,
		);

		const old = rows.find((row) => row.id === oldId);
		const replacement = rows.find((row) => row.id === replacementId);
		expect(old?.status).toBe("superseded");
		expect(old?.superseded_by).toBe(replacementId);
		expect(replacement?.status).toBe("active");
		expect(replacement?.content).toContain("provenance-backed operations");
		expect(replacement?.confidence).toBeCloseTo(0.93);
		expect(replacement?.source_kind).toBe("transcript");
		const memoryStates = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, is_deleted, superseded_by FROM memories WHERE id IN (?, ?)")
					.all(oldId, replacementId) as Array<{ id: string; is_deleted: number; superseded_by: string | null }>,
		);
		expect(memoryStates.find((memory) => memory.id === oldId)).toMatchObject({
			is_deleted: 0,
			superseded_by: replacementId,
		});
		expect(memoryStates.find((memory) => memory.id === replacementId)).toMatchObject({
			is_deleted: 0,
			superseded_by: null,
		});
	});

	it("applies semantic create_link proposal roles from ontology extraction", async () => {
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "create_link",
			payload: {
				source_entity: "Transcript Artifact",
				source_type: "artifact",
				link_type: "supports_claim",
				target_entity: "Signet proposal loop",
				target_type: "concept",
				reason: "Transcript evidence supports the reviewed claim.",
				confidence: 0.86,
			},
			sourceKind: "transcript",
			sourceId: "transcript:semantic-link",
		});

		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: proposal.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		expect(typeof applied.result?.dependencyId).toBe("string");
		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT dep.dependency_type, dep.confidence, dep.source_kind,
							        dep.proposal_id, dep.proposal_evidence,
							        src.entity_type AS source_type, dst.entity_type AS target_type
							 FROM entity_dependencies dep
							 JOIN entities src ON src.id = dep.source_entity_id
						 JOIN entities dst ON dst.id = dep.target_entity_id
						 WHERE dep.id = ?`,
					)
					.get(applied.result?.dependencyId as string) as
					| {
							dependency_type: string;
							confidence: number;
							source_kind: string | null;
							proposal_id: string | null;
							proposal_evidence: string;
							source_type: string;
							target_type: string;
					  }
					| undefined,
		);
		expect(row?.dependency_type).toBe("supports_claim");
		expect(row?.confidence).toBeCloseTo(0.86);
		expect(row?.source_kind).toBe("transcript");
		expect(row?.proposal_id).toBe(proposal.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([]);
		expect(row?.source_type).toBe("artifact");
		expect(row?.target_type).toBe("concept");
	});

	it("resolves applied link evidence from stored dependency provenance", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"transcript:link",
				"User: Transcript Artifact supports the Signet proposal loop claim.",
				"codex",
				"/tmp/signet",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:01:00.000Z",
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				"memory/codex/transcripts/link.jsonl",
				"sha-link",
				"transcript",
				"session-link",
				"transcript:link",
				"token-link",
				"codex",
				"2026-05-06T00:01:00.000Z",
				"Artifact source truth says this transcript supports the proposal-loop claim.",
				"2026-05-06T00:01:00.000Z",
			);
		});
		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "create_link",
			payload: {
				source_entity: "Transcript Artifact",
				source_type: "artifact",
				link_type: "supports_claim",
				target_entity: "Signet proposal loop",
				target_type: "concept",
				reason: "Transcript supports the claim.",
			},
			sourceKind: "transcript",
			sourceId: "transcript:link",
			sourcePath: "memory/codex/transcripts/link.jsonl",
		});
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: proposal.id,
			actor: "test",
		});
		const dependencyId = applied.result?.dependencyId;
		expect(typeof dependencyId).toBe("string");

		const evidence = await getOntologyLinkEvidence(getDbAccessor(), {
			agentId: "ant",
			id: dependencyId as string,
		});

		expect(evidence.dependency.sourceKind).toBe("transcript");
		expect(evidence.dependency.proposalId).toBe(proposal.id);
		expect(evidence.items.map((item) => item.kind)).toEqual([
			"ontology_proposal",
			"session_transcript",
			"memory_artifact",
		]);
		expect(evidence.items[0]?.label).toBe(`proposal:${proposal.id}`);
		expect(evidence.items[1]?.excerpt).toContain("supports the Signet proposal loop");
		expect(evidence.items[2]?.excerpt).toContain("supports the proposal-loop claim");
	});

	it("groups pending add_claim_value conflicts by claim slot", async () => {
		await createOntologyProposals(getDbAccessor(), [
			{
				agentId: "ant",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					group_key: "ontology",
					claim_key: "mutation_policy",
					value: "Extraction writes directly into the graph.",
				},
				confidence: 0.4,
			},
			{
				agentId: "ant",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					group_key: "ontology",
					claim_key: "mutation_policy",
					value: "Extraction writes provenance-backed operations before graph mutation.",
				},
				confidence: 0.93,
			},
			{
				agentId: "dot",
				operation: "add_claim_value",
				payload: {
					entity: "Signet",
					aspect: "architecture",
					group_key: "ontology",
					claim_key: "mutation_policy",
					value: "Different agent scope should not join conflicts.",
				},
			},
		]);

		const conflicts = await listOntologyProposalConflicts(getDbAccessor(), { agentId: "ant" });
		const other = await listOntologyProposalConflicts(getDbAccessor(), { agentId: "dot" });

		expect(conflicts.count).toBe(1);
		expect(conflicts.items[0]?.entity).toBe("Signet");
		expect(conflicts.items[0]?.claimKey).toBe("mutation_policy");
		expect(conflicts.items[0]?.values).toHaveLength(2);
		expect(other.count).toBe(0);
	});

	it("applies merge_entities by moving aspects and deleting duplicate sources", async () => {
		const target = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "identity",
				group_key: "product",
				claim_key: "category",
				value: "Agent-first ontology",
			},
		});
		await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: target.id,
			actor: "test",
		});

		const duplicate = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet AI",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "mutation_policy",
				value: "Proposal-first mutation loop",
			},
		});
		await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: duplicate.id,
			actor: "test",
		});

		const merge = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity: "Signet",
				source_entities: ["Signet AI"],
			},
			rationale: "Both names refer to the same product entity.",
		});

		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: merge.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		expect(applied.result?.mergedEntities).toHaveLength(1);
		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT e.name AS entity_name, asp.name AS aspect, attr.content
						 FROM entity_attributes attr
						 JOIN entity_aspects asp ON asp.id = attr.aspect_id
						 JOIN entities e ON e.id = asp.entity_id
						 WHERE e.agent_id = ? AND e.name = ?
						 ORDER BY asp.name`,
					)
					.all("ant", "Signet") as Array<{ entity_name: string; aspect: string; content: string }>,
		);
		const duplicateEntity = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ? AND status='active'")
					.get("ant", "Signet AI") as { id: string } | undefined,
		);

		expect(duplicateEntity).toBeNull();
		expect(rows.map((row) => row.aspect)).toEqual(["architecture", "identity"]);
		expect(rows.map((row) => row.content)).toContain("Proposal-first mutation loop");
	});

	it("carries aliases and assertions through merge_entities without touching unrelated relations", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 2);
		insertEntity("entity-signet-ai", "Signet AI", "signet ai", "ant", 1);
		insertEntity("entity-daemon", "Daemon", "daemon", "ant", 1);
		insertEntity("entity-dot", "Dot Project", "dot project", "dot", 1);
		getDbAccessor().withWriteTx((db) => {
			const alias = db.prepare(
				`INSERT INTO entity_aliases (id, entity_id, agent_id, alias, canonical_alias, status)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			);
			alias.run("alias-target-active", "entity-signet", "ant", "Sig", "sig", "active");
			alias.run("alias-target-archived", "entity-signet", "ant", "Old Signet", "old signet", "archived");
			alias.run("alias-source-active", "entity-signet-ai", "ant", "SAI", "sai", "active");
			alias.run("alias-source-archived-dup", "entity-signet-ai", "ant", "old signet", "old signet", "archived");
			alias.run("alias-source-archived", "entity-signet-ai", "ant", "Sig", "sig", "archived");
			alias.run("alias-dot", "entity-dot", "dot", "SAI", "sai", "active");
			const assertion = db.prepare(
				`INSERT INTO epistemic_assertions
				 (id, agent_id, subject_entity_id, predicate, content, normalized_content, asserted_at)
				 VALUES (?, ?, ?, 'claims', ?, ?, '2026-05-06T00:00:00.000Z')`,
			);
			assertion.run("assertion-target", "ant", "entity-signet", "Target claim", "target claim");
			assertion.run("assertion-source", "ant", "entity-signet-ai", "Source claim", "source claim");
			assertion.run("assertion-dot", "dot", "entity-dot", "Dot claim", "dot claim");
			const relation = db.prepare(
				`INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, created_at, agent_id)
				 SELECT ?, ?, ?, 'related_to', '2026-05-06T00:00:00.000Z',agent_id FROM entities WHERE id=?`,
			);
			relation.run("relation-source-target", "entity-signet-ai", "entity-signet", "entity-signet-ai");
			relation.run("relation-target-source", "entity-signet", "entity-signet-ai", "entity-signet");
			relation.run("relation-source-daemon", "entity-signet-ai", "entity-daemon", "entity-signet-ai");
			relation.run("relation-target-self", "entity-signet", "entity-signet", "entity-signet");
			relation.run("relation-dot-self", "entity-dot", "entity-dot", "entity-dot");
		});

		const merge = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: { target_entity_id: "entity-signet", source_entity_ids: ["entity-signet-ai"] },
		});
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: merge.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		const state = getDbAccessor().withReadDb((db) => ({
			aliases: db.prepare("SELECT id, entity_id, agent_id, status FROM entity_aliases ORDER BY id").all() as Array<{
				id: string;
				entity_id: string;
				agent_id: string;
				status: string;
			}>,
			assertions: db
				.prepare("SELECT id, subject_entity_id, agent_id FROM epistemic_assertions ORDER BY id")
				.all() as Array<{ id: string; subject_entity_id: string; agent_id: string }>,
			relations: db.prepare("SELECT id, source_entity_id, target_entity_id FROM relations ORDER BY id").all() as Array<{
				id: string;
				source_entity_id: string;
				target_entity_id: string;
			}>,
		}));

		expect(state.aliases).toEqual([
			{ id: "alias-dot", entity_id: "entity-dot", agent_id: "dot", status: "active" },
			{ id: "alias-source-active", entity_id: "entity-signet", agent_id: "ant", status: "active" },
			{ id: "alias-source-archived", entity_id: "entity-signet", agent_id: "ant", status: "archived" },
			{ id: "alias-target-active", entity_id: "entity-signet", agent_id: "ant", status: "active" },
			{ id: "alias-target-archived", entity_id: "entity-signet", agent_id: "ant", status: "archived" },
		]);
		expect(state.assertions).toEqual([
			{ id: "assertion-dot", subject_entity_id: "entity-dot", agent_id: "dot" },
			{ id: "assertion-source", subject_entity_id: "entity-signet", agent_id: "ant" },
			{ id: "assertion-target", subject_entity_id: "entity-signet", agent_id: "ant" },
		]);
		expect(state.relations).toEqual([
			{ id: "relation-dot-self", source_entity_id: "entity-dot", target_entity_id: "entity-dot" },
			{ id: "relation-source-daemon", source_entity_id: "entity-signet", target_entity_id: "entity-daemon" },
			{ id: "relation-target-self", source_entity_id: "entity-signet", target_entity_id: "entity-signet" },
		]);
	});

	it("applies ID-first merge_entities when entity names are ambiguous", async () => {
		const target = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "identity",
				group_key: "product",
				claim_key: "category",
				value: "Context substrate",
			},
		});
		await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: target.id,
			actor: "test",
		});

		const source = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Signet Alias",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "proposal_loop",
				value: "Proposal-first maintenance.",
			},
		});
		await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: source.id,
			actor: "test",
		});

		const ids = getDbAccessor().withWriteTx((db) => {
			const targetRow = db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Signet") as {
				id: string;
			};
			const sourceRow = db
				.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?")
				.get("ant", "Signet Alias") as { id: string };
			db.prepare("UPDATE entities SET canonical_name = ? WHERE id = ?").run("signet", sourceRow.id);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
			).run(
				"entity-signet-skill",
				"signet",
				"signet",
				"skill",
				"ant",
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:00:00.000Z",
			);
			return { targetId: targetRow.id, sourceId: sourceRow.id };
		});

		const merge = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity: "Signet",
				target_entity_id: ids.targetId,
				source_entities: ["Signet Alias"],
				source_entity_ids: [ids.sourceId],
			},
		});

		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: merge.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		expect(applied.result?.targetEntityId).toBe(ids.targetId);
		expect(applied.result?.mergedEntities).toEqual([{ name: "Signet Alias", entityId: ids.sourceId, movedAspects: 1 }]);
	});

	it("deduplicates dependency edges while merging entities", async () => {
		insertEntity("entity-target", "Target", "target", "ant", 8);
		insertEntity("entity-source", "Source", "source", "ant", 4);
		insertEntity("entity-dependency-target", "Dependency Target", "dependency target", "ant", 2);
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			insert.run(
				"dep-target",
				"entity-target",
				"entity-dependency-target",
				"ant",
				"built",
				1,
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:00:00.000Z",
			);
			insert.run(
				"dep-source",
				"entity-source",
				"entity-dependency-target",
				"ant",
				"built",
				1,
				"2026-05-06T00:00:00.000Z",
				"2026-05-06T00:00:00.000Z",
			);
		});

		const proposal = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity_id: "entity-target",
				source_entity_ids: ["entity-source"],
			},
		});
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: proposal.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		const edges = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_entity_id, target_entity_id, dependency_type
						 FROM entity_dependencies
						 WHERE agent_id = ? AND dependency_type = ?`,
					)
					.all("ant", "built") as Array<{
					source_entity_id: string;
					target_entity_id: string;
					dependency_type: string;
				}>,
		);
		expect(edges).toEqual([
			{ source_entity_id: "entity-target", target_entity_id: "entity-dependency-target", dependency_type: "built" },
		]);
	});

	it("treats a merge proposal as applied when its source was already merged", async () => {
		insertEntity("entity-target", "Target", "target", "ant", 8);
		insertEntity("entity-source", "Source", "source", "ant", 4);
		const first = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity_id: "entity-target",
				source_entities: ["Source"],
				source_entity_ids: ["entity-source"],
			},
		});
		await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: first.id,
			actor: "test",
		});

		const retry = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity_id: "entity-target",
				source_entities: ["Source"],
				source_entity_ids: ["entity-source"],
			},
		});
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: retry.id,
			actor: "test",
		});

		expect(applied.status).toBe("applied");
		expect(applied.result?.mergedEntities).toEqual([]);
		expect(applied.result?.alreadyMergedEntities).toEqual(["Source"]);

		const nameOnlyRetry = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity_id: "entity-target",
				source_entities: ["Source"],
			},
		});
		const nameOnlyApplied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: nameOnlyRetry.id,
			actor: "test",
		});

		expect(nameOnlyApplied.status).toBe("applied");
		expect(nameOnlyApplied.result?.mergedEntities).toEqual([]);
		expect(nameOnlyApplied.result?.alreadyMergedEntities).toEqual(["Source"]);
	});

	it("rejects merge_entities when supplied IDs and names disagree", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8);
		insertEntity("entity-other", "Other", "other", "ant", 4);
		insertEntity("entity-alias", "Signet Alias", "signet alias", "ant", 1);

		const merge = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "merge_entities",
			payload: {
				target_entity: "Other",
				target_entity_id: "entity-signet",
				source_entity_ids: ["entity-alias"],
			},
		});

		await expect(
			applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				id: merge.id,
				actor: "test",
			}),
		).rejects.toThrow(OntologyProposalError);
	});

	it("dry-runs duplicate entity repair candidates without creating proposals", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, true);
		insertEntity("entity-signet-upper", "SIGNET", "signet", "ant", 3);
		insertEntity("entity-signet-ai", "signet.ai", "signet", "ant", 1);
		insertEntity("entity-other", "Other Project", "other project", "ant", 4);

		const result = await proposeDuplicateEntityMerges(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			limit: 10,
		});

		expect(result.dryRun).toBe(true);
		expect(result.writtenCount).toBe(0);
		expect(result.count).toBe(1);
		expect(result.items[0]?.operation).toBe("merge_entities");
		expect(result.items[0]?.canonicalName).toBe("signet");
		expect(result.items[0]?.target.name).toBe("Signet");
		expect(result.items[0]?.sources.map((source) => source.name).sort()).toEqual(["SIGNET", "signet.ai"]);

		const listed = await listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(0);
	});

	it("blocks mixed-type duplicate entity repair proposals by default", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, true, "project");
		insertEntity("entity-signet-skill", "signet", "signet", "ant", 3, false, "skill");

		const result = await proposeDuplicateEntityMerges(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			limit: 10,
			writeProposals: true,
			createdBy: "repair-test",
		});

		expect(result.count).toBe(1);
		expect(result.writtenCount).toBe(0);
		expect(result.skippedCount).toBe(1);
		expect(result.items[0]?.blocked).toBe(true);
		expect(result.items[0]?.warnings.join("\n")).toContain("differs from target type");
		const listed = await listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(0);
	});

	it("writes duplicate entity repair candidates as pending merge proposals only once", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, true);
		insertEntity("entity-signet-upper", "SIGNET", "signet", "ant", 3);

		const result = await proposeDuplicateEntityMerges(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			limit: 10,
			writeProposals: true,
			createdBy: "repair-test",
		});
		const second = await proposeDuplicateEntityMerges(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			limit: 10,
			writeProposals: true,
			createdBy: "repair-test",
		});

		expect(result.dryRun).toBe(false);
		expect(result.writtenCount).toBe(1);
		expect(result.proposals[0]?.operation).toBe("merge_entities");
		expect(result.proposals[0]?.createdBy).toBe("repair-test");
		expect(result.proposals[0]?.payload.repair_kind).toBe("duplicate_entities");
		expect(result.proposals[0]?.payload.target_entity).toBe("Signet");
		expect(result.proposals[0]?.payload.source_entities).toEqual(["SIGNET"]);
		expect(second.count).toBe(0);
		expect(second.writtenCount).toBe(0);

		const listed = await listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(1);
	});

	it("previews and writes manual entity merge plans with ID-first payloads", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8);
		insertEntity("entity-alias", "Signet Alias", "signet alias", "ant", 2);

		const preview = await createEntityMergePlan(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			targetEntityId: "entity-signet",
			sourceEntityIds: ["entity-alias"],
		});

		expect(preview.dryRun).toBe(true);
		expect(preview.proposal).toBeUndefined();
		expect(preview.payload.target_entity_id).toBe("entity-signet");
		expect(preview.payload.source_entity_ids).toEqual(["entity-alias"]);

		const written = await createEntityMergePlan(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			targetEntityId: "entity-signet",
			sourceEntityIds: ["entity-alias"],
			writeProposal: true,
			createdBy: "merge-plan-test",
		});

		expect(written.dryRun).toBe(false);
		expect(written.proposal?.operation).toBe("merge_entities");
		expect(written.proposal?.createdBy).toBe("merge-plan-test");
		expect(written.proposal?.payload.target_entity_id).toBe("entity-signet");
	});

	it("keeps blocked manual merge-plan writes reported as dry-runs", async () => {
		insertEntity("entity-signet", "Signet", "signet", "ant", 8, false, "project");
		insertEntity("entity-signet-skill", "signet", "signet", "ant", 2, false, "skill");

		const result = await createEntityMergePlan(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			targetEntityId: "entity-signet",
			sourceEntityIds: ["entity-signet-skill"],
			writeProposal: true,
			createdBy: "merge-plan-test",
		});

		expect(result.blocked).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.proposal).toBeUndefined();
		const listed = await listOntologyProposals(getDbAccessor(), { agentId: "ant", operation: "merge_entities" });
		expect(listed.items).toHaveLength(0);
	});

	it("rejects invalid proposal batches without partial writes", async () => {
		await expect(
			createOntologyProposals(getDbAccessor(), [
				{ agentId: "default", operation: "create_entity", payload: { name: "Valid" } },
				{ agentId: "default", operation: " ", payload: { name: "Invalid" } },
			]),
		).rejects.toThrow(OntologyProposalError);

		const listed = await listOntologyProposals(getDbAccessor(), { agentId: "default" });
		expect(listed.items).toHaveLength(0);
	});

	it("keeps proposal listing scoped to agent_id", async () => {
		await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "create_entity",
			payload: { name: "Ant Project" },
		});
		await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "dot",
			operation: "create_entity",
			payload: { name: "Dot Project" },
		});

		const ant = await listOntologyProposals(getDbAccessor(), { agentId: "ant" });
		const dot = await listOntologyProposals(getDbAccessor(), { agentId: "dot" });

		expect(ant.items).toHaveLength(1);
		expect(dot.items).toHaveLength(1);
		expect(ant.items[0]?.payload.name).toBe("Ant Project");
		expect(dot.items[0]?.payload.name).toBe("Dot Project");
	});

	it("applies policy, action, and interface operations through existing graph primitives", async () => {
		const policy = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			actor: "operator",
			operation: "create_policy",
			payload: {
				target_entity: "Signet",
				kind: "storage",
				content: "Use SQLite for application state.",
			},
		});
		expect(policy.proposal.status).toBe("applied");
		const action = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			actor: "operator",
			operation: "create_action_type",
			payload: { action_type: "Deploy release" },
		});
		const iface = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			actor: "operator",
			operation: "create_interface",
			payload: { name: "Memory provider" },
		});
		const attachment = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "default",
			actor: "operator",
			operation: "attach_interface",
			payload: { entity: "Signet", interface: "Memory provider" },
		});

		expect(action.result).toMatchObject({ entity: "Deploy release" });
		expect(iface.result).toMatchObject({ entity: "Memory provider" });
		expect(attachment.result).toMatchObject({ updated: false });
		const graph = getDbAccessor().withReadDb((db) => ({
			policy: db
				.prepare(
					`SELECT ea.kind, ea.group_key, ea.claim_key, ea.content
					 FROM entity_attributes ea JOIN entity_aspects asp ON asp.id = ea.aspect_id
					 JOIN entities e ON e.id = asp.entity_id
					 WHERE e.agent_id = 'default' AND e.name = 'Signet' AND asp.name = 'policy'`,
				)
				.get(),
			action: db
				.prepare("SELECT entity_type FROM entities WHERE agent_id = 'default' AND name = 'Deploy release'")
				.get(),
			interface: db
				.prepare("SELECT entity_type FROM entities WHERE agent_id = 'default' AND name = 'Memory provider'")
				.get(),
			link: db.prepare("SELECT dependency_type FROM entity_dependencies WHERE agent_id = 'default'").get(),
		}));
		expect(graph.policy).toMatchObject({ kind: "constraint", group_key: "policy", claim_key: "storage" });
		expect(graph.action).toMatchObject({ entity_type: "action" });
		expect(graph.interface).toMatchObject({ entity_type: "interface" });
		expect(graph.link).toMatchObject({ dependency_type: "implements" });
	});

	it("applies direct operations by creating an applied proposal and graph mutation atomically", async () => {
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "control_plane",
				value: "Direct ontology operations are audited through applied proposals.",
			},
			reason: "operator asserted audited control plane behavior",
			evidence: [{ source_kind: "test", quote: "audited control plane" }],
			confidence: 0.94,
		});

		expect(result.dryRun).toBe(false);
		expect(result.proposed).toBe(false);
		expect(result.proposal.status).toBe("applied");
		expect(result.proposal.appliedBy).toBe("operator");
		expect(result.result?.version).toBe(1);

		const attrs = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "control_plane",
		});
		expect(attrs.count).toBe(1);
		expect(attrs.items[0]?.proposalId).toBe(result.proposal.id);
		expect(attrs.items[0]?.content).toContain("audited");
	});

	it("dry-runs direct operations without writing proposals or graph state", async () => {
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "create_entity",
			payload: { name: "Dry Run Entity", entity_type: "project" },
			dryRun: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.proposal.status).toBe("applied");
		const proposal = await getOntologyProposal(getDbAccessor(), result.proposal.id, "ant");
		const entity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Dry Run Entity") as
					| { id: string }
					| undefined,
		);
		expect(proposal).toBeNull();
		expect(entity).toBeNull();
	});

	it("exercises dry-run, apply, propose, reject, evidence, and immutable source artifacts end to end", async () => {
		const sourcePath = "memory/codex/transcripts/control-plane-e2e.jsonl";
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id,
				  session_key, session_token, harness, captured_at, content, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"ant",
				sourcePath,
				"sha-control-plane-e2e",
				"transcript",
				"session-control-plane-e2e",
				"control-plane-e2e",
				"token-control-plane-e2e",
				"codex",
				"2026-05-16T00:01:00.000Z",
				"Raw artifact says ontology control-plane mutations apply first with provenance.",
				"2026-05-16T00:01:00.000Z",
			);
		});
		const sourceBefore = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("ant", sourcePath) as { content: string } | undefined,
		);

		const payload = {
			entity: "Signet",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
			claim_key: "control_plane_e2e",
			value: "Ontology control-plane mutations apply first with provenance.",
		};
		const dryRun = await applyOntologyOperationBatch(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			dryRun: true,
			operations: [{ operation: "set_claim_value", payload }],
		});
		expect(dryRun.dryRun).toBe(true);
		expect((await listOntologyProposals(getDbAccessor(), { agentId: "ant" })).items).toHaveLength(0);

		const applied = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload,
			sourceKind: "transcript",
			sourceId: "control-plane-e2e",
			sourcePath,
			evidence: [{ source_kind: "memory_artifact", source_path: sourcePath, quote: "apply first with provenance" }],
		});
		const proposed = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "create_entity",
			payload: { name: "Rejected Candidate", entity_type: "project" },
			propose: true,
		});
		const rejected = await rejectOntologyProposal(getDbAccessor(), {
			agentId: "ant",
			id: proposed.proposal.id,
			actor: "operator",
			reason: "proposal review rejected this candidate",
		});
		const evidence = await getOntologyClaimEvidence(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "control_plane_e2e",
		});
		const sourceAfter = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT content FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
					.get("ant", sourcePath) as { content: string } | undefined,
		);

		expect(applied.proposal.status).toBe("applied");
		expect(rejected.status).toBe("rejected");
		expect(evidence.items[0]?.attribute.proposalId).toBe(applied.proposal.id);
		expect(evidence.items[0]?.evidence.map((item) => item.kind)).toContain("memory_artifact");
		expect(sourceAfter?.content).toBe(sourceBefore?.content);
	});

	it("proposes direct operations without mutating graph state", async () => {
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "create_entity",
			payload: { name: "Proposed Entity", entity_type: "project" },
			propose: true,
		});

		expect(result.proposed).toBe(true);
		expect(result.proposal.status).toBe("pending");
		const entity = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT id FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Proposed Entity") as
					| { id: string }
					| undefined,
		);
		expect(entity).toBeNull();
	});

	it("set_claim_value creates queryable version chains and restore switches the active version", async () => {
		const payload = {
			entity: "Signet",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
			claim_key: "versioned_claim",
		};
		const v1 = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Version one." },
		});
		const v2 = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Version two." },
		});
		const v3 = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Version three." },
		});

		expect(v1.result?.version).toBe(1);
		expect(v2.result?.version).toBe(2);
		expect(v3.result?.version).toBe(3);
		const versions = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "versioned_claim",
		});
		expect(versions.items.map((item) => item.version)).toEqual([3, 2, 1]);
		expect(versions.items.map((item) => item.status)).toEqual(["active", "superseded", "superseded"]);

		const shown = await getClaimVersion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "versioned_claim",
			version: 2,
		});
		expect(shown?.content).toBe("Version two.");

		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "restore_claim_version",
			payload: { attribute_id: shown?.id },
		});
		const restored = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "versioned_claim",
		});
		expect(restored.items.find((item) => item.version === 2)?.status).toBe("active");
		expect(restored.items.find((item) => item.version === 3)?.status).toBe("superseded");
		const restoredMemoryState = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, is_deleted, superseded_by FROM memories WHERE id IN (?, ?)")
					.all(shown?.id, v3.result?.attributeId) as Array<{
					id: string;
					is_deleted: number;
					superseded_by: string | null;
				}>,
		);
		expect(restoredMemoryState.find((memory) => memory.id === shown?.id)).toMatchObject({
			is_deleted: 0,
			superseded_by: null,
		});
		expect(restoredMemoryState.find((memory) => memory.id === v3.result?.attributeId)?.superseded_by).toBe(shown?.id);
	});

	it("records the applying actor on projected claim memories and their history", async () => {
		const claim = {
			entity: "Signet",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
		};
		const apply = (operation: string, payload: Record<string, unknown>) =>
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "operator",
				operation,
				payload,
			});

		const added = await apply("add_claim_value", { ...claim, claim_key: "added", value: "Added value." });
		const first = await apply("set_claim_value", { ...claim, claim_key: "set", value: "First value." });
		const second = await apply("set_claim_value", { ...claim, claim_key: "set", value: "Second value." });
		const superseded = await apply("supersede_claim_value", {
			...claim,
			claim_key: "added",
			attribute_id: added.result?.attributeId,
			new_value: "Superseding value.",
		});
		await apply("restore_claim_version", { attribute_id: first.result?.attributeId });
		await apply("archive_claim_value", { attribute_id: superseded.result?.replacementAttributeId });

		const memoryIds = [
			added.result?.attributeId,
			first.result?.attributeId,
			second.result?.attributeId,
			superseded.result?.replacementAttributeId,
		];
		expect(memoryIds.every((id) => typeof id === "string")).toBe(true);
		const placeholders = memoryIds.map(() => "?").join(", ");
		const memories = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(`SELECT who, updated_by, source_type FROM memories WHERE id IN (${placeholders})`)
					.all(...memoryIds) as Array<{ who: string; updated_by: string; source_type: string }>,
		);
		expect(memories).toHaveLength(4);
		for (const memory of memories) {
			expect(memory).toEqual({ who: "operator", updated_by: "operator", source_type: "operator" });
		}
		const history = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT memory_id, event, changed_by FROM memory_history
						 WHERE memory_id IN (${placeholders}) ORDER BY memory_id, event`,
					)
					.all(...memoryIds) as Array<{ memory_id: string; event: string; changed_by: string }>,
		);
		expect(history.map((row) => row.event).sort()).toEqual([
			"deleted",
			"recovered",
			"superseded",
			"superseded",
			"superseded",
		]);
		expect(history.every((row) => row.changed_by === "operator")).toBe(true);
	});

	it("archives claim values and hides them from default active reads", async () => {
		const applied = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "archive_claim",
				value: "Archive me.",
			},
		});
		const attributeId = applied.result?.attributeId as string;
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "archive_claim_value",
			payload: { attribute_id: attributeId, reason: "obsolete" },
		});

		const active = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS n FROM entity_attributes WHERE id = ? AND status = 'active'")
					.get(attributeId) as { n: number },
		);
		const versions = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "archive_claim",
		});
		expect(active.n).toBe(0);
		expect(versions.items[0]?.status).toBe("deleted");
		const memory = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get(attributeId) as
					| { is_deleted: number }
					| undefined,
		);
		expect(memory?.is_deleted).toBe(1);
	});

	it("restores an archived semantic claim memory and honors an explicit force", async () => {
		const applied = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "restore_archived_claim",
				value: "This semantic claim can be restored.",
			},
		});
		const attributeId = applied.result?.attributeId as string;
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET pinned = 1 WHERE id = ?").run(attributeId);
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "archive_claim_value",
			payload: { attribute_id: attributeId, force: true },
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "restore_claim_version",
			payload: { attribute_id: attributeId },
		});
		const restored = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT attr.status, mem.is_deleted, mem.superseded_by
						 FROM entity_attributes attr JOIN memories mem ON mem.id = attr.memory_id
						 WHERE attr.id = ?`,
					)
					.get(attributeId) as { status: string; is_deleted: number; superseded_by: string | null } | undefined,
		);
		expect(restored).toEqual({ status: "active", is_deleted: 0, superseded_by: null });
	});

	it("continues claim version chains after the active value is archived", async () => {
		const payload = {
			entity: "Archive Version Chain",
			entity_type: "project",
			aspect: "architecture",
			group_key: "ontology",
			claim_key: "archived_chain",
		};
		const first = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Archived first version." },
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "archive_claim_value",
			payload: { attribute_id: first.result?.attributeId, reason: "retired" },
		});
		const second = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: { ...payload, value: "Replacement after archive." },
		});

		const versions = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Archive Version Chain",
			aspect: "architecture",
			group: "ontology",
			claim: "archived_chain",
		});

		expect(second.result?.version).toBe(2);
		expect(second.result?.versionRootId).toBe(first.result?.versionRootId);
		expect(second.result?.previousAttributeId).toBe(first.result?.attributeId);
		expect(versions.items.map((item) => item.version)).toEqual([2, 1]);
		expect(versions.items.map((item) => item.status)).toEqual(["active", "deleted"]);
	});

	it("preserves original claim provenance when repeated writes dedupe", async () => {
		const first = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "set_claim_value",
			payload: {
				entity: "Dedupe Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "The original evidence owns this row.",
			},
			evidence: [{ source: "transcript:first", message_ids: ["m1"] }],
			createdBy: "first",
		});
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: first.id,
			actor: "operator",
		});
		const repeated = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "set_claim_value",
			payload: {
				entity: "Dedupe Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "The original evidence owns this row.",
			},
			evidence: [{ source: "transcript:repeat", message_ids: ["m2"] }],
			createdBy: "repeat",
		});

		const second = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: repeated.id,
			actor: "operator",
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT proposal_id, proposal_evidence FROM entity_attributes WHERE id = ?")
					.get(applied.result?.attributeId as string) as
					| { proposal_id: string | null; proposal_evidence: string | null }
					| undefined,
		);
		expect(second.result?.deduped).toBe(true);
		expect(second.result?.attributeId).toBe(applied.result?.attributeId);
		expect(row?.proposal_id).toBe(first.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([{ source: "transcript:first", message_ids: ["m1"] }]);
	});

	it("preserves original additive claim provenance when repeated values dedupe", async () => {
		const first = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Additive Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "Repeated additive values keep the first source.",
			},
			evidence: [{ source: "transcript:first-add", message_ids: ["m1"] }],
			createdBy: "first",
		});
		const applied = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: first.id,
			actor: "operator",
		});
		const repeated = await createOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			operation: "add_claim_value",
			payload: {
				entity: "Additive Provenance",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "source_truth",
				value: "Repeated additive values keep the first source.",
			},
			evidence: [{ source: "transcript:repeat-add", message_ids: ["m2"] }],
			createdBy: "repeat",
		});

		const second = await applyOntologyProposal(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			id: repeated.id,
			actor: "operator",
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT proposal_id, proposal_evidence FROM entity_attributes WHERE id = ?")
					.get(applied.result?.attributeId as string) as
					| { proposal_id: string | null; proposal_evidence: string | null }
					| undefined,
		);
		expect(second.result?.deduped).toBe(true);
		expect(second.result?.attributeId).toBe(applied.result?.attributeId);
		expect(row?.proposal_id).toBe(first.id);
		expect(JSON.parse(row?.proposal_evidence ?? "[]")).toEqual([
			{ source: "transcript:first-add", message_ids: ["m1"] },
		]);
	});

	it("records the applying actor when pending archive proposals are applied", async () => {
		const entity = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "creator",
			operation: "create_entity",
			payload: { name: "Archive Actor Entity", entity_type: "project" },
		});
		const claim = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "creator",
			operation: "set_claim_value",
			payload: {
				entity: "Archive Actor Claim",
				entity_type: "project",
				aspect: "audit",
				group_key: "ontology",
				claim_key: "actor",
				value: "Archive me.",
			},
		});
		const link = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "creator",
			operation: "create_link",
			payload: {
				source_entity: "Archive Actor Source",
				source_type: "project",
				link_type: "related_to",
				target_entity: "Archive Actor Target",
				target_type: "project",
				reason: "Audit actor fixture.",
			},
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "creator",
			operation: "set_claim_value",
			payload: {
				entity: "Archive Actor Aspect",
				entity_type: "project",
				aspect: "retire_me",
				group_key: "ontology",
				claim_key: "actor",
				value: "Archive my aspect.",
			},
		});

		const proposals = await createOntologyProposals(getDbAccessor(), [
			{
				agentId: "ant",
				operation: "archive_entity",
				payload: { selector: entity.result?.entityId },
				createdBy: "creator",
			},
			{
				agentId: "ant",
				operation: "archive_claim_value",
				payload: { attribute_id: claim.result?.attributeId },
				createdBy: "creator",
			},
			{
				agentId: "ant",
				operation: "archive_link",
				payload: { id: link.result?.dependencyId },
				createdBy: "creator",
			},
			{
				agentId: "ant",
				operation: "archive_aspect",
				payload: { entity: "Archive Actor Aspect", selector: "retire_me" },
				createdBy: "creator",
			},
		]);

		for (const proposal of proposals.items) {
			await applyOntologyProposal(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				id: proposal.id,
				actor: "reviewer",
			});
		}

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT
						 (SELECT archived_by FROM entities WHERE id = ?) AS entity_actor,
						 (SELECT archived_by FROM entity_attributes WHERE id = ?) AS claim_actor,
						 (SELECT archived_by FROM entity_dependencies WHERE id = ?) AS link_actor,
						 (SELECT asp.archived_by
						    FROM entity_aspects asp
						    JOIN entities ent ON ent.id = asp.entity_id
						   WHERE ent.agent_id = ? AND ent.name = ? AND asp.name = ?) AS aspect_actor,
						 (SELECT attr.archived_by
						    FROM entity_attributes attr
						    JOIN entity_aspects asp ON asp.id = attr.aspect_id
						    JOIN entities ent ON ent.id = asp.entity_id
						   WHERE ent.agent_id = ? AND ent.name = ? AND asp.name = ?) AS aspect_attr_actor`,
					)
					.get(
						entity.result?.entityId as string,
						claim.result?.attributeId as string,
						link.result?.dependencyId as string,
						"ant",
						"Archive Actor Aspect",
						"retire_me",
						"ant",
						"Archive Actor Aspect",
						"retire_me",
					) as {
					entity_actor: string | null;
					claim_actor: string | null;
					link_actor: string | null;
					aspect_actor: string | null;
					aspect_attr_actor: string | null;
				},
		);
		expect(row).toEqual({
			entity_actor: "reviewer",
			claim_actor: "reviewer",
			link_actor: "reviewer",
			aspect_actor: "reviewer",
			aspect_attr_actor: "reviewer",
		});
	});

	it("reactivates archived aspects when creating claims for the same aspect slot", async () => {
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Aspect Restore",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "old_claim",
				value: "Before archive.",
			},
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "archive_aspect",
			payload: { entity: "Aspect Restore", selector: "architecture", reason: "retired" },
		});
		const recreated = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Aspect Restore",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "new_claim",
				value: "After archive.",
			},
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT asp.status AS aspect_status, asp.archived_by, attr.status AS claim_status
						 FROM entity_aspects asp
						 JOIN entity_attributes attr ON attr.aspect_id = asp.id
						 WHERE asp.id = ? AND attr.id = ?`,
					)
					.get(recreated.result?.aspectId as string, recreated.result?.attributeId as string) as
					| { aspect_status: string; archived_by: string | null; claim_status: string }
					| undefined,
		);
		expect(row?.aspect_status).toBe("active");
		expect(row?.archived_by).toBeNull();
		expect(row?.claim_status).toBe("active");
	});

	it("reactivates archived links when creating the same link again", async () => {
		const created = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "create_link",
			payload: {
				source_entity: "Archived Link Source",
				source_type: "project",
				link_type: "related_to",
				target_entity: "Archived Link Target",
				target_type: "project",
				reason: "Initial relationship.",
			},
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "archive_link",
			payload: { id: created.result?.dependencyId, reason: "retired" },
		});
		const recreated = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "create_link",
			payload: {
				source_entity: "Archived Link Source",
				source_type: "project",
				link_type: "related_to",
				target_entity: "Archived Link Target",
				target_type: "project",
				reason: "Restored relationship.",
				strength: 0.9,
			},
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT status, archived_by, reason, strength FROM entity_dependencies WHERE id = ?")
					.get(created.result?.dependencyId as string) as
					| { status: string; archived_by: string | null; reason: string; strength: number }
					| undefined,
		);
		expect(recreated.result?.dependencyId).toBe(created.result?.dependencyId);
		expect(recreated.result?.reactivated).toBe(true);
		expect(row?.status).toBe("active");
		expect(row?.archived_by).toBeNull();
		expect(row?.reason).toBe("Restored relationship.");
		expect(row?.strength).toBeCloseTo(0.9);
	});

	it("keeps claim version history readable after archiving its parent entity", async () => {
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "set_claim_value",
			payload: {
				entity: "Signet",
				entity_type: "project",
				aspect: "architecture",
				group_key: "ontology",
				claim_key: "archived_parent_history",
				value: "History survives entity archival.",
			},
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			operation: "archive_entity",
			payload: { selector: "Signet", reason: "retired" },
		});

		const versions = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "archived_parent_history",
		});
		const version = await getClaimVersion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			aspect: "architecture",
			group: "ontology",
			claim: "archived_parent_history",
			version: 1,
		});
		expect(versions.count).toBe(1);
		expect(version?.content).toBe("History survives entity archival.");
	});

	it("requires strict claim-version entity selectors across archived duplicates", async () => {
		insertEntity("archived-history", "Duplicate History A", "duplicate history", "ant", 1);
		insertEntity("active-history", "Duplicate History B", "duplicate history", "ant", 2);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?").run("archived-history");
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run("archived-history-aspect", "archived-history", "ant", "architecture", "architecture");
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
			).run("active-history-aspect", "active-history", "ant", "architecture", "architecture");
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content,
				  confidence, importance, status, group_key, claim_key,
				  version, version_root_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
			).run(
				"archived-history-attr",
				"archived-history-aspect",
				"ant",
				"Archived entity history.",
				"archived entity history.",
				"ontology",
				"lineage",
				"archived-history-attr",
			);
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content,
				  confidence, importance, status, group_key, claim_key,
				  version, version_root_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'attribute', ?, ?, 0.8, 0.5, 'active', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
			).run(
				"active-history-attr",
				"active-history-aspect",
				"ant",
				"Active entity history.",
				"active entity history.",
				"ontology",
				"lineage",
				"active-history-attr",
			);
		});

		await expect(
			listClaimVersions(getDbAccessor(), {
				agentId: "ant",
				entity: "duplicate history",
				aspect: "architecture",
				group: "ontology",
				claim: "lineage",
			}),
		).rejects.toThrow("ambiguous");
		const archivedVersions = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "archived-history",
			aspect: "archived-history-aspect",
			group: "ontology",
			claim: "lineage",
		});
		const activeVersions = await listClaimVersions(getDbAccessor(), {
			agentId: "ant",
			entity: "active-history",
			aspect: "active-history-aspect",
			group: "ontology",
			claim: "lineage",
		});
		expect(archivedVersions.items.map((item) => item.content)).toEqual(["Archived entity history."]);
		expect(activeVersions.items.map((item) => item.content)).toEqual(["Active entity history."]);
	});

	it("rolls back an operation batch when one operation is invalid", async () => {
		await expect(
			applyOntologyOperationBatch(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "operator",
				operations: [
					{ operation: "create_entity", payload: { name: "Batch Good", entity_type: "project" } },
					{ operation: "rename_entity", payload: { selector: "Missing", new_name: "Nope" } },
				],
			}),
		).rejects.toThrow(OntologyProposalError);
		const count = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND name = ?").get("ant", "Batch Good") as {
					n: number;
				},
		);
		expect(count.n).toBe(0);
		expect((await listOntologyProposals(getDbAccessor(), { agentId: "ant" })).items).toHaveLength(0);
	});

	it("returns per-line dry-run batch validation errors without writing", async () => {
		const result = await applyOntologyOperationBatch(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "operator",
			dryRun: true,
			operations: [
				{ operation: "create_entity", payload: { name: "Batch Preview", entity_type: "project" } },
				{ operation: "rename_entity", payload: { selector: "Missing", new_name: "Nope" } },
			],
		});
		const count = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS n FROM entities WHERE agent_id = ? AND name = ?")
					.get("ant", "Batch Preview") as {
					n: number;
				},
		);

		expect(result.dryRun).toBe(true);
		expect(result.items).toHaveLength(1);
		expect(result.errors).toEqual([
			{
				index: 1,
				line: 2,
				operation: "rename_entity",
				error: "Entity not found: Missing",
				status: 404,
			},
		]);
		expect(count.n).toBe(0);
		expect((await listOntologyProposals(getDbAccessor(), { agentId: "ant" })).items).toHaveLength(0);
	});

	it("rejects ambiguous same-agent entity selectors", async () => {
		insertEntity("one", "Signet A", "signet", "ant", 1);
		insertEntity("two", "Signet B", "signet", "ant", 2);

		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "operator",
				operation: "rename_entity",
				payload: { selector: "signet", new_name: "Signet" },
			}),
		).rejects.toThrow("ambiguous");
	});
	it("rejects add_claim_value past the attribute cap with a teaching error", async () => {
		const cap = { maxAspectsPerEntity: 10, maxAttributesPerAspect: 2 };
		const common = {
			agentId: "ant",
			actor: "test",
			operation: "add_claim_value",
		} as const;

		for (let i = 0; i < 2; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				...common,
				payload: {
					entity: "Capped",
					entity_type: "project",
					aspect: "facts",
					claim_key: `fact_${i}`,
					value: `fact number ${i}`,
				},
				writeCaps: cap,
			});
		}

		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				...common,
				payload: {
					entity: "Capped",
					entity_type: "project",
					aspect: "facts",
					claim_key: "fact_overflow",
					value: "this should be rejected",
				},
				writeCaps: cap,
			}),
		).rejects.toThrow(/attribute cap \(2\/2\).*supersede or expire/);
	});

	it("does not enforce attribute cap when writeCaps is omitted (backward compat)", async () => {
		for (let i = 0; i < 5; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "add_claim_value",
				payload: {
					entity: "Uncapped",
					entity_type: "project",
					aspect: "facts",
					claim_key: `fact_${i}`,
					value: `fact number ${i}`,
				},
			});
		}

		const count = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT COUNT(*) AS c FROM entity_attributes WHERE agent_id = ? AND status = 'active'")
					.get("ant") as { c: number },
		);
		expect(count.c).toBe(5);
	});

	it("rejects create_aspect past the aspect cap with a teaching error", async () => {
		const cap = { maxAspectsPerEntity: 2, maxAttributesPerAspect: 25 };
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "CappedEnt", entity_type: "project" },
		});

		for (let i = 0; i < 2; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_aspect",
				payload: { entity: "CappedEnt", entity_type: "project", name: `aspect_${i}` },
				writeCaps: cap,
			});
		}

		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_aspect",
				payload: { entity: "CappedEnt", entity_type: "project", name: "overflow_aspect" },
				writeCaps: cap,
			}),
		).rejects.toThrow(/aspect cap \(2\/2\).*merge_aspects.*rename_aspect.*Existing aspects: aspect_0 \(.+\); aspect_1/);
	});

	it("allows adding to an existing aspect that already exists past the cap (idempotent resolve)", async () => {
		const cap = { maxAspectsPerEntity: 1, maxAttributesPerAspect: 25 };

		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "Single", entity_type: "project" },
		});

		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_aspect",
			payload: { entity: "Single", entity_type: "project", name: "only_aspect" },
			writeCaps: cap,
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_aspect",
			payload: { entity: "Single", entity_type: "project", name: "only_aspect" },
			writeCaps: cap,
		});
	});

	it("deduplicates exact-value claims before enforcing the attribute cap", async () => {
		const cap = { maxAspectsPerEntity: 10, maxAttributesPerAspect: 1 };

		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "add_claim_value",
			payload: {
				entity: "Dedup",
				entity_type: "project",
				aspect: "facts",
				claim_key: "same_key",
				value: "identical content",
			},
			writeCaps: cap,
		});
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "add_claim_value",
			payload: {
				entity: "Dedup",
				entity_type: "project",
				aspect: "facts",
				claim_key: "same_key",
				value: "identical content",
			},
			writeCaps: cap,
		});
		expect(result.result?.deduped).toBe(true);
	});
	async function seedAspectClaims(entity: string, aspect: string, count: number): Promise<void> {
		for (let i = 0; i < count; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "add_claim_value",
				payload: {
					entity,
					entity_type: "project",
					aspect,
					claim_key: `${aspect}_key_${i}`,
					value: `${aspect} value number ${i}`,
				},
			});
		}
	}

	function aspectRowCount(aspectName: string): number {
		return getDbAccessor().withReadDb((db) => {
			const aspect = db
				.prepare(
					"SELECT id FROM entity_aspects WHERE agent_id = ? AND name = ? AND COALESCE(status, 'active') = 'active'",
				)
				.get("ant", aspectName) as { id: string } | undefined;
			if (aspect === undefined) return -1;
			return (
				db
					.prepare(
						"SELECT COUNT(*) AS c FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND status = 'active'",
					)
					.get(aspect.id, "ant") as {
					c: number;
				}
			).c;
		});
	}

	it("merges aspects by moving attributes into the target and archiving sources", async () => {
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "MergeEnt", entity_type: "project" },
		});
		await seedAspectClaims("MergeEnt", "status_history", 3);
		await seedAspectClaims("MergeEnt", "changelog", 4);

		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "merge_aspects",
			payload: {
				entity: "MergeEnt",
				target: "status_history",
				sources: ["changelog"],
				new_name: "timeline",
			},
		});

		expect(result.result?.targetAspect).toBe("timeline");
		expect(result.result?.totalAttributesMoved).toBe(4);
		expect(aspectRowCount("timeline")).toBe(7);
		const sourceStatus = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT status FROM entity_aspects WHERE agent_id = ? AND name = ?").get("ant", "changelog"),
		);
		expect(sourceStatus).toEqual({ status: "archived" });
	});

	it("lets the merged aspect exceed the attribute cap (consolidation is exempt)", async () => {
		const cap = { maxAspectsPerEntity: 10, maxAttributesPerAspect: 5 };

		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "FatEnt", entity_type: "project" },
		});
		await seedAspectClaims("FatEnt", "a", 5);
		await seedAspectClaims("FatEnt", "b", 5);
		const result = await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "merge_aspects",
			payload: { entity: "FatEnt", target: "a", sources: ["b"] },
			writeCaps: cap,
		});
		expect(result.result?.totalAttributesMoved).toBe(5);
		expect(aspectRowCount("a")).toBe(10);
	});

	it("rejects merge_aspects without entity, target, or sources", async () => {
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "merge_aspects",
				payload: { entity: "Whatever", target: "x", sources: [] },
			}),
		).rejects.toThrow(/sources is required/);
	});
	it("does not bypass the aspect cap via add_claim_value with a new aspect name (E1)", async () => {
		const cap = { maxAspectsPerEntity: 2, maxAttributesPerAspect: 25 };
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "E1Ent", entity_type: "project" },
		});
		for (let i = 0; i < 2; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_aspect",
				payload: { entity: "E1Ent", name: `aspect_${i}` },
				writeCaps: cap,
			});
		}
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "add_claim_value",
				payload: {
					entity: "E1Ent",
					aspect: "aspect_overflow",
					claim_key: "k",
					value: "v",
				},
				writeCaps: cap,
			}),
		).rejects.toThrow(/aspect cap \(2\/2\)/);
	});

	it("does not bypass the attribute cap via set_claim_value with a new claim_key (E2)", async () => {
		const cap = { maxAspectsPerEntity: 10, maxAttributesPerAspect: 2 };
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "E2Ent", entity_type: "project" },
		});
		for (let i = 0; i < 2; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "set_claim_value",
				payload: { entity: "E2Ent", aspect: "facts", claim_key: `k_${i}`, value: `v ${i}` },
				writeCaps: cap,
			});
		}
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "set_claim_value",
				payload: { entity: "E2Ent", aspect: "facts", claim_key: "k_overflow", value: "v overflow" },
				writeCaps: cap,
			}),
		).rejects.toThrow(/attribute cap \(2\/2\)/);
	});

	it("allows reactivating an archived aspect within cap but rejects a new aspect at cap (E3)", async () => {
		const cap = { maxAspectsPerEntity: 2, maxAttributesPerAspect: 25 };
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_entity",
			payload: { name: "E3Ent", entity_type: "project" },
		});
		for (let i = 0; i < 2; i++) {
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_aspect",
				payload: { entity: "E3Ent", name: `aspect_${i}` },
				writeCaps: cap,
			});
		}
		const aspect = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT id FROM entity_aspects WHERE agent_id = ? AND name = ?").get("ant", "aspect_1"),
		) as { id: string };
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "archive_aspect",
			payload: { entity: "E3Ent", selector: aspect.id },
		});
		await applyOntologyOperation(getDbAccessor(), {
			author: { userId: null, credential: "system" },
			agentId: "ant",
			actor: "test",
			operation: "create_aspect",
			payload: { entity: "E3Ent", name: "aspect_1" },
			writeCaps: cap,
		});
		await expect(
			applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "ant",
				actor: "test",
				operation: "create_aspect",
				payload: { entity: "E3Ent", name: "aspect_new" },
				writeCaps: cap,
			}),
		).rejects.toThrow(/aspect cap \(2\/2\)/);
	});
	describe("claim event time", () => {
		const slot = {
			entity: "User",
			entity_type: "person",
			aspect: "events",
			group_key: "general",
			claim_key: "charity_walk",
		};

		function attributeTime(id: string): Record<string, unknown> | undefined {
			return getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						`SELECT status, superseded_by, occurred_start, occurred_end, valid_from, valid_until, time_precision
						 FROM entity_attributes WHERE id = ?`,
					)
					.get(id),
			) as Record<string, unknown> | undefined;
		}

		function edgesFor(memoryId: string): Array<Record<string, unknown>> {
			return getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						`SELECT facet, start_at, end_at, metadata_json FROM temporal_edges
						 WHERE subject_type = 'memory' AND subject_id = ? ORDER BY facet`,
					)
					.all(memoryId),
			) as Array<Record<string, unknown>>;
		}

		it("stores event time on the claim and derives occurred edges that temporal recall can find", async () => {
			const applied = await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "set_claim_value",
				payload: {
					...slot,
					value: "On 2023-03-19 the user completed the Walk for Hunger.",
					occurred_at: "2023-03-19",
				},
			});
			const id = applied.result?.attributeId;
			if (typeof id !== "string") throw new Error("attribute id was not returned");

			expect(attributeTime(id)).toMatchObject({
				status: "active",
				occurred_start: "2023-03-19T00:00:00.000Z",
				occurred_end: null,
				time_precision: "day",
			});
			const edges = edgesFor(id);
			expect(edges).toHaveLength(1);
			expect(edges[0]).toMatchObject({
				facet: "occurred",
				start_at: "2023-03-19T00:00:00.000Z",
				end_at: "2023-03-19T23:59:59.999Z",
			});
			expect(JSON.parse(String(edges[0]?.metadata_json))).toMatchObject({ attributeId: id, precision: "day" });

			const versions = await listClaimVersions(getDbAccessor(), {
				agentId: "default",
				entity: "User",
				aspect: "events",
				group: "general",
				claim: "charity_walk",
			});
			expect(versions.items[0]?.occurredStart).toBe("2023-03-19T00:00:00.000Z");
			expect(versions.items[0]?.timePrecision).toBe("day");

			const recalled = resolveTemporalRecall({ query: "which charity event did I do on 2023-03-19?", limit: 10 });
			expect(recalled.candidateIds).toContain(id);
		});

		it("spans an approximate claim time across its day so a day query still finds it", async () => {
			const applied = await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "set_claim_value",
				payload: {
					...slot,
					claim_key: "concert",
					value: "In mid-April 2023 the user saw Queen live with their parents.",
					occurred_at: "2023-04-15",
					time_precision: "approximate",
				},
			});
			const id = applied.result?.attributeId;
			if (typeof id !== "string") throw new Error("attribute id was not returned");

			expect(edgesFor(id)[0]).toMatchObject({
				facet: "occurred",
				start_at: "2023-04-15T00:00:00.000Z",
				end_at: "2023-04-15T23:59:59.999Z",
			});
			const recalled = resolveTemporalRecall({ query: "who did I see a concert with on 2023-04-15?", limit: 10 });
			expect(recalled.candidateIds).toContain(id);
		});

		it("orders same-day claims by when their sources were captured, not by write order", async () => {
			getDbAccessor().withWriteTx((db) => {
				const source = db.prepare(
					`INSERT INTO memories
					 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
					 VALUES (?, ?, 'fact', 'default', 'global', 'episodic', ?, ?)`,
				);
				source.run(
					"morning-source",
					"I have 1250 followers now.",
					"2023-05-25T05:26:00.000Z",
					"2023-05-25T05:26:00.000Z",
				);
				source.run(
					"later-source",
					"I think I'm close to 1300 now.",
					"2023-05-25T09:28:00.000Z",
					"2023-05-25T09:28:00.000Z",
				);
			});
			const followers = { ...slot, aspect: "social media", claim_key: "instagram_followers" };
			const file = async (sourceId: string, value: string) =>
				await applyOntologyOperation(getDbAccessor(), {
					author: { userId: null, credential: "system" },
					agentId: "default",
					actor: "dreaming",
					operation: "set_claim_value",
					payload: { ...followers, value, valid_from: "2023-05-25" },
					evidence: [{ source_ref: `memory:${sourceId}`, source_kind: "manual", source_id: sourceId }],
					sourceKind: "memory",
					sourceId,
				});
			const later = await file("later-source", "As of 2023-05-25 the user had close to 1,300 Instagram followers.");
			const morning = await file("morning-source", "On 2023-05-25 the user had 1,250 Instagram followers.");
			const laterId = later.result?.attributeId;
			const morningId = morning.result?.attributeId;
			if (typeof laterId !== "string" || typeof morningId !== "string")
				throw new Error("attribute ids were not returned");

			expect(morning.result?.supersededByNewerEvidence).toBe(laterId);
			expect(attributeTime(laterId)?.status).toBe("active");
			expect(attributeTime(morningId)).toMatchObject({ status: "superseded", superseded_by: laterId });
		});

		it("keeps the newer claim current when an older claim arrives later", async () => {
			const residence = { ...slot, aspect: "home", claim_key: "city" };
			const newer = await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "set_claim_value",
				payload: {
					...residence,
					value: "The user has lived in Denver since May 2024.",
					valid_from: "2024-05-01",
					time_precision: "month",
				},
			});
			const older = await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "set_claim_value",
				payload: {
					...residence,
					value: "The user lived in Boston in January 2023.",
					valid_from: "2023-01-01",
					time_precision: "month",
				},
			});
			const newerId = newer.result?.attributeId;
			const olderId = older.result?.attributeId;
			if (typeof newerId !== "string" || typeof olderId !== "string")
				throw new Error("attribute ids were not returned");

			expect(older.result?.supersededByNewerEvidence).toBe(newerId);
			expect(attributeTime(newerId)?.status).toBe("active");
			expect(attributeTime(olderId)).toMatchObject({ status: "superseded", superseded_by: newerId });
			const olderMemory = getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(olderId),
			) as { superseded_by: string | null } | undefined;
			expect(olderMemory?.superseded_by).toBe(newerId);

			const latest = await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "set_claim_value",
				payload: { ...residence, value: "The user has lived in Austin since June 2025.", valid_from: "2025-06-01" },
			});
			const latestId = latest.result?.attributeId;
			if (typeof latestId !== "string") throw new Error("attribute id was not returned");
			expect(attributeTime(latestId)?.status).toBe("active");
			expect(attributeTime(newerId)).toMatchObject({ status: "superseded", superseded_by: latestId });
		});

		it("forwards review time and event time through supersede_claim_value", async () => {
			const plan = { ...slot, aspect: "plans", claim_key: "marathon" };
			await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "set_claim_value",
				payload: { ...plan, value: "The user plans to run a marathon in 2024." },
			});
			const replaced = await applyOntologyOperation(getDbAccessor(), {
				author: { userId: null, credential: "system" },
				agentId: "default",
				actor: "dreaming",
				operation: "supersede_claim_value",
				payload: {
					...plan,
					old_value: "The user plans to run a marathon in 2024.",
					new_value: "The user registered for the Denver Marathon on 2024-10-20.",
					review_after: "2024-10-21T00:00:00.000Z",
					occurred_at: "2024-10-20",
					time_precision: "day",
				},
			});
			const id = replaced.result?.replacementAttributeId;
			if (typeof id !== "string") throw new Error("replacement attribute id was not returned");
			expect(attributeTime(id)).toMatchObject({ occurred_start: "2024-10-20T00:00:00.000Z", time_precision: "day" });
			const memory = getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT review_after FROM memories WHERE id = ?").get(id),
			) as { review_after: string | null } | undefined;
			expect(memory?.review_after).toBe("2024-10-21T00:00:00.000Z");
			expect(edgesFor(id).map((edge) => edge.facet)).toEqual(["occurred"]);
		});

		it("rejects malformed claim time", async () => {
			const attempt = (extra: Record<string, unknown>) =>
				applyOntologyOperation(getDbAccessor(), {
					author: { userId: null, credential: "system" },
					agentId: "default",
					actor: "dreaming",
					operation: "set_claim_value",
					payload: { ...slot, value: "The user walked for charity on 2023-03-19.", ...extra },
				});
			await expect(attempt({ occurred_at: "not a date" })).rejects.toThrow(/occurred_at must be a valid ISO/);
			await expect(attempt({ occurred_until: "2023-03-20" })).rejects.toThrow(/occurred_until requires/);
			await expect(attempt({ occurred_at: "2023-03-19", time_precision: "hourly" })).rejects.toThrow(
				/time_precision must be one of/,
			);
			await expect(attempt({ valid_from: "2023-03-19", valid_until: "2023-03-01" })).rejects.toThrow(
				/valid_until must be after/,
			);
		});
	});
});

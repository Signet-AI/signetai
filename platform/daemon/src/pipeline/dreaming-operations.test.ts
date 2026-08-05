import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { enqueueDreamingAttentionInTx } from "./dreaming-attention";
import { applyDreamingOperations } from "./dreaming-operations";

describe("dreaming operations", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-dreaming-operations-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
				 VALUES ('summary-1', 'agent-a', 'Atlas runs the deployment workflow.', 8, 0, 'session', 'summary', datetime('now'), datetime('now'), datetime('now'))`,
			).run();
		});
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a scoped canonical citation without a Pi session", () => {
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "acpx",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Atlas", entity_type: "project" },
					reason: "The summary names the project.",
					evidence: [
						{
							source_ref: "summary:summary-1",
							source_kind: "summary",
							source_id: "summary-1",
							quote: "Atlas runs the deployment workflow.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT source_id FROM ontology_proposals WHERE agent_id = 'agent-a'").get(),
			),
		).toMatchObject({ source_id: "summary-1" });
	});

	it("rejects a citation outside the caller's agent scope", () => {
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-b",
			actor: "acpx",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Atlas" },
					evidence: [
						{
							source_ref: "summary:summary-1",
							source_kind: "summary",
							source_id: "summary-1",
							quote: "Atlas runs the deployment workflow.",
						},
					],
				},
			],
		});
		expect(result).toMatchObject({
			ok: false,
			error: "Every operation must cite an exact quote from scoped episodic evidence",
		});
	});

	it("does not replace an existing entity's provenance with later cited evidence", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, source_id, source_root, created_at, updated_at)
				 VALUES ('atlas-existing', 'Atlas', 'atlas', 'project', 'agent-a', 1, 'user:manual', 'user', datetime('now'), datetime('now'))`,
			).run();
		});
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "create_entity",
					payload: { name: "Atlas", entity_type: "project" },
					evidence: [
						{
							source_ref: "summary:summary-1",
							source_kind: "summary",
							source_id: "summary-1",
							quote: "Atlas runs the deployment workflow.",
						},
					],
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT source_id, source_root FROM entities WHERE id = 'atlas-existing'").get(),
			),
		).toEqual({ source_id: "user:manual", source_root: "user" });
	});

	it("allows an attention-cited archive only for the flagged scoped target", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', 'agent-a', 5, datetime('now'), datetime('now'))`,
			).run();
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "entity:legacy-husk",
				details: { entityId: "legacy-husk", reason: "zero_active_attributes" },
				priority: 90,
			});
		});
		const attentionId = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT id FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as { id: string },
		).id;
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "archive_entity",
					payload: { entity_id: "legacy-husk", reason: "No active attributes remain." },
					provenance: `attention:${attentionId}`,
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("legacy-husk")),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT evidence FROM ontology_proposals WHERE agent_id = ?").get("agent-a") as {
						evidence: string;
					},
			).evidence,
		).toContain(`attention:${attentionId}`);
	});

	it("accepts an attention-cited archive that echoes the flagged name alongside entity_id", () => {
		// Regression: the Dreaming agent submitted archive_entity payloads with
		// both `entity: <name>` (echoed from attention details) and the required
		// `entity_id`. The id match pins the flagged target, so the redundant
		// selector must not reject the op.
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('legacy-husk', 'Legacy Husk', 'legacy husk', 'project', 'agent-a', 5, datetime('now'), datetime('now'))`,
			).run();
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "entity:legacy-husk",
				details: { entityId: "legacy-husk", name: "Legacy Husk", reason: "zero_active_attributes" },
				priority: 90,
			});
		});
		const attentionId = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT id FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as { id: string },
		).id;
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "archive_entity",
					payload: { entity: "Legacy Husk", entity_id: "legacy-husk", force: false },
					provenance: `attention:${attentionId}`,
					confidence: 1,
				},
			],
		});
		expect(result.ok).toBe(true);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("legacy-husk")),
		).toEqual({ status: "archived" });
	});

	it("does not let attention provenance create claims or archive unrelated entities", () => {
		getDbAccessor().withWriteTx((db) => {
			for (const id of ["flagged", "unrelated"]) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', 'agent-a', 1, datetime('now'), datetime('now'))`,
				).run(id, id, id);
			}
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "entity:flagged",
				details: { entityId: "flagged", reason: "zero_active_attributes" },
			});
		});
		const attentionId = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT id FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as { id: string },
		).id;
		for (const operation of [
			{ operation: "archive_entity", payload: { entity_id: "unrelated" } },
			{ operation: "create_entity", payload: { name: "Uncited", entity_type: "project" } },
		] as const) {
			const result = applyDreamingOperations({
				accessor: getDbAccessor(),
				agentId: "agent-a",
				actor: "dreaming",
				operations: [{ ...operation, provenance: `attention:${attentionId}` }],
			});
			expect(result).toMatchObject({
				ok: false,
				error: "Every operation must cite an exact quote from scoped episodic evidence",
			});
		}
	});

	it("allows only the exact flagged aspect and attribute archive targets", () => {
		getDbAccessor().withWriteTx((db) => {
			for (const entityId of ["aspect-entity", "claim-entity"]) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', 'agent-a', 1, datetime('now'), datetime('now'))`,
				).run(entityId, entityId, entityId);
			}
			for (const [aspectId, entityId] of [
				["stale-aspect", "aspect-entity"],
				["claim-aspect", "claim-entity"],
			] as const) {
				db.prepare(
					`INSERT INTO entity_aspects
					 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES (?, ?, 'agent-a', 'General', 'general', 0.5, datetime('now'), datetime('now'))`,
				).run(aspectId, entityId);
			}
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status,
				  group_key, claim_key, version, created_at, updated_at)
				 VALUES ('stale-claim', 'claim-aspect', 'agent-a', 'attribute', 'Stale claim.', 'stale claim.',
				  0.8, 0.5, 'active', 'general', 'stale', 1, datetime('now'), datetime('now'))`,
			).run();
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "aspect:stale-aspect",
				details: { entityId: "aspect-entity", aspectId: "stale-aspect", reason: "generic_aspect" },
			});
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "attribute:stale-claim",
				details: {
					entityId: "claim-entity",
					aspectId: "claim-aspect",
					attributeId: "stale-claim",
					reason: "missing_claim_key",
				},
			});
		});
		const attention = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, subject_ref FROM dreaming_attention WHERE agent_id = ? ORDER BY subject_ref")
					.all("agent-a") as Array<{ id: string; subject_ref: string }>,
		);
		const aspectAttention = attention.find((item) => item.subject_ref === "aspect:stale-aspect")?.id;
		const claimAttention = attention.find((item) => item.subject_ref === "attribute:stale-claim")?.id;
		if (!aspectAttention || !claimAttention) throw new Error("Missing hygiene attention");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "archive_aspect",
					payload: { entity_id: "aspect-entity", aspect_id: "stale-aspect" },
					provenance: `attention:${aspectAttention}`,
				},
				{
					operation: "archive_claim_value",
					payload: { attribute_id: "stale-claim" },
					provenance: `attention:${claimAttention}`,
				},
			],
		});
		expect(result.items.map((item) => item.ok)).toEqual([true, true]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entity_aspects WHERE id = ?").get("stale-aspect"),
			),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entity_attributes WHERE id = ?").get("stale-claim"),
			),
		).toEqual({ status: "deleted" });
	});

	it("allows hygiene-cited link archive and duplicate merge only for their flagged graph subjects", () => {
		getDbAccessor().withWriteTx((db) => {
			for (const [id, name, canonical] of [
				["link-source", "Link source", "link source"],
				["link-target", "Link target", "link target"],
				["merge-target", "Acme", "acme"],
				["merge-source", "ACME", "acme"],
			] as const) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', 'agent-a', 1, datetime('now'), datetime('now'))`,
				).run(id, name, canonical);
			}
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, reason, created_at, updated_at)
				 VALUES ('generic-link', 'link-source', 'link-target', 'agent-a', 'related_to', 0.5, 'legacy generic relation', datetime('now'), datetime('now'))`,
			).run();
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "link:generic-link",
				details: { linkId: "generic-link", reason: "generic_related_to" },
			});
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "duplicate:acme",
				details: { canonicalName: "acme", reason: "duplicate_entities" },
			});
		});
		const attentions = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, subject_ref FROM dreaming_attention WHERE agent_id = ? ORDER BY subject_ref")
					.all("agent-a") as Array<{ id: string; subject_ref: string }>,
		);
		const linkAttention = attentions.find((item) => item.subject_ref === "link:generic-link")?.id;
		const mergeAttention = attentions.find((item) => item.subject_ref === "duplicate:acme")?.id;
		if (!linkAttention || !mergeAttention) throw new Error("Missing hygiene attention");
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{ operation: "archive_link", payload: { id: "generic-link" }, provenance: `attention:${linkAttention}` },
				{
					operation: "merge_entities",
					payload: { target_entity_id: "merge-target", source_entity_ids: ["merge-source"] },
					provenance: `attention:${mergeAttention}`,
				},
			],
		});
		expect(result.items.map((item) => item.ok)).toEqual([true, true]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entity_dependencies WHERE id = ?").get("generic-link"),
			),
		).toEqual({ status: "archived" });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT id FROM entities WHERE id = ?").get("merge-source")),
		).toBeNull();
	});

	it("rejects alternate destructive selectors alongside attention-targeted IDs", () => {
		getDbAccessor().withWriteTx((db) => {
			for (const id of ["flagged", "victim"]) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', 'agent-a', 1, datetime('now'), datetime('now'))`,
				).run(id, id, id);
			}
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "entity:flagged",
				details: { entityId: "flagged", reason: "zero_active_attributes" },
			});
		});
		const attentionId = getDbAccessor().withReadDb(
			(db) => db.prepare("SELECT id FROM dreaming_attention WHERE agent_id = ?").get("agent-a") as { id: string },
		).id;
		const result = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "archive_entity",
					payload: { entity_id: "flagged", selector: "victim" },
					provenance: `attention:${attentionId}`,
				},
			],
		});
		expect(result).toMatchObject({
			ok: false,
			error: "Every operation must cite an exact quote from scoped episodic evidence",
		});
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("victim")),
		).toEqual({ status: "active" });
		const forced = applyDreamingOperations({
			accessor: getDbAccessor(),
			agentId: "agent-a",
			actor: "dreaming",
			operations: [
				{
					operation: "archive_entity",
					payload: { entity_id: "flagged", force: true },
					provenance: `attention:${attentionId}`,
				},
			],
		});
		expect(forced).toMatchObject({
			ok: false,
			error: "Every operation must cite an exact quote from scoped episodic evidence",
		});
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM entities WHERE id = ?").get("flagged")),
		).toEqual({ status: "active" });
	});

	it("rejects alternate aspect and merge selectors alongside attention-targeted IDs", () => {
		getDbAccessor().withWriteTx((db) => {
			for (const [id, name, canonical] of [
				["flagged-entity", "Flagged entity", "flagged entity"],
				["victim-entity", "Victim entity", "victim entity"],
				["merge-target", "Acme", "acme"],
				["merge-source", "ACME", "acme"],
				["merge-victim", "Victim merge", "victim merge"],
			] as const) {
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES (?, ?, ?, 'project', 'agent-a', 1, datetime('now'), datetime('now'))`,
				).run(id, name, canonical);
			}
			for (const [id, entityId, name] of [
				["flagged-aspect", "flagged-entity", "Flagged aspect"],
				["victim-aspect", "victim-entity", "Victim aspect"],
			] as const) {
				db.prepare(
					`INSERT INTO entity_aspects
					 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
					 VALUES (?, ?, 'agent-a', ?, ?, 0.5, datetime('now'), datetime('now'))`,
				).run(id, entityId, name, name.toLowerCase());
			}
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "aspect:flagged-aspect",
				details: { entityId: "flagged-entity", aspectId: "flagged-aspect", reason: "generic_aspect" },
			});
			enqueueDreamingAttentionInTx(db, {
				agentId: "agent-a",
				kind: "hygiene",
				subjectRef: "duplicate:acme",
				details: { canonicalName: "acme", reason: "duplicate_canonical_name" },
			});
		});
		const attentions = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT id, subject_ref FROM dreaming_attention WHERE agent_id = ? ORDER BY subject_ref")
					.all("agent-a") as Array<{ id: string; subject_ref: string }>,
		);
		const aspectAttention = attentions.find((item) => item.subject_ref === "aspect:flagged-aspect")?.id;
		const mergeAttention = attentions.find((item) => item.subject_ref === "duplicate:acme")?.id;
		if (!aspectAttention || !mergeAttention) throw new Error("Missing hygiene attention");
		for (const operation of [
			{
				operation: "archive_aspect",
				payload: {
					entity_id: "flagged-entity",
					aspect_id: "flagged-aspect",
					entity: "Victim entity",
					aspect: "Victim aspect",
				},
				provenance: `attention:${aspectAttention}`,
			},
			{
				operation: "merge_entities",
				payload: {
					target_entity_id: "merge-target",
					source_entity_ids: ["merge-source"],
					source_entity_id: "merge-victim",
				},
				provenance: `attention:${mergeAttention}`,
			},
		] as const) {
			const result = applyDreamingOperations({
				accessor: getDbAccessor(),
				agentId: "agent-a",
				actor: "dreaming",
				operations: [operation],
			});
			expect(result).toMatchObject({
				ok: false,
				error: "Every operation must cite an exact quote from scoped episodic evidence",
			});
		}
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM entity_aspects WHERE id = ?").get("victim-aspect"),
			),
		).toEqual({ status: "active" });
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT id FROM entities WHERE id = ?").get("merge-victim")),
		).toEqual({ id: "merge-victim" });
	});
});

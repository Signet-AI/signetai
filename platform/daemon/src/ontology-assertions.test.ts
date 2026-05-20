import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	OntologyAssertionError,
	archiveEpistemicAssertion,
	createEpistemicAssertion,
	getEpistemicAssertion,
	linkEpistemicAssertionClaim,
	listEpistemicAssertions,
	supersedeEpistemicAssertion,
} from "./ontology-assertions";
import { registerOntologyRoutes } from "./routes/ontology-routes";

describe("epistemic assertions", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-ontology-assertions-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-signet', 'Signet', 'signet', 'project', 'ant', 1, ?, ?)`,
			).run("2026-05-16T00:00:00.000Z", "2026-05-16T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-other', 'Other', 'other', 'project', 'dot', 1, ?, ?)`,
			).run("2026-05-16T00:00:00.000Z", "2026-05-16T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-rival', 'Rival', 'rival', 'project', 'ant', 1, ?, ?)`,
			).run("2026-05-16T00:00:00.000Z", "2026-05-16T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-signet', 'entity-signet', 'ant', 'architecture', 'architecture', 0.7, ?, ?)`,
			).run("2026-05-16T00:00:00.000Z", "2026-05-16T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
				  status, group_key, claim_key, created_at, updated_at)
				 VALUES ('attr-signet', 'aspect-signet', 'ant', 'attribute', 'Signet has epistemic assertions.',
				  'signet has epistemic assertions.', 0.9, 0.8, 'active', 'ontology', 'epistemic_assertions', ?, ?)`,
			).run("2026-05-16T00:00:00.000Z", "2026-05-16T00:00:00.000Z");
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance,
				  status, group_key, claim_key, created_at, updated_at)
				 VALUES ('attr-superseded', 'aspect-signet', 'ant', 'attribute', 'Old assertion claim.',
				  'old assertion claim.', 0.5, 0.4, 'superseded', 'ontology', 'epistemic_assertions', ?, ?),
				 ('attr-deleted', 'aspect-signet', 'ant', 'attribute', 'Deleted assertion claim.',
				  'deleted assertion claim.', 0.5, 0.4, 'deleted', 'ontology', 'epistemic_assertions', ?, ?)`,
			).run(
				"2026-05-16T00:00:00.000Z",
				"2026-05-16T00:00:00.000Z",
				"2026-05-16T00:00:00.000Z",
				"2026-05-16T00:00:00.000Z",
			);
		});
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates, lists, and reads a source-attributed assertion", () => {
		const assertion = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			predicate: "believes",
			content: "Signet should model who believes what over time.",
			speaker: "Nicholai",
			assertedAt: "2026-05-16T19:36:00.000Z",
			confidence: 0.91,
			evidence: [{ quote: "who believes what" }],
			sourceKind: "transcript",
			sourceId: "session-1",
			createdBy: "test",
		});

		expect(assertion.subjectEntityName).toBe("Signet");
		expect(assertion.predicate).toBe("believes");
		expect(assertion.confidence).toBeCloseTo(0.91);
		expect(assertion.evidence).toEqual([{ quote: "who believes what" }]);

		const list = listEpistemicAssertions(getDbAccessor(), { agentId: "ant", speaker: "Nicholai" });
		expect(list.items).toHaveLength(1);
		expect(list.items[0]?.id).toBe(assertion.id);
		expect(getEpistemicAssertion(getDbAccessor(), { agentId: "ant", id: assertion.id })?.content).toContain(
			"believes what",
		);
		expect(listEpistemicAssertions(getDbAccessor(), { agentId: "dot", status: "all" }).items).toHaveLength(0);
	});

	it("links assertions to same-agent claim attributes and rejects cross-entity links", () => {
		const assertion = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entityId: "entity-signet",
			predicate: "claims",
			content: "Signet has epistemic assertions.",
			evidence: [{ source_kind: "test", quote: "assertion" }],
		});

		const linked = linkEpistemicAssertionClaim(getDbAccessor(), {
			agentId: "ant",
			id: assertion.id,
			attributeId: "attr-signet",
		});
		expect(linked.claimAttributeId).toBe("attr-signet");

		expect(() =>
			linkEpistemicAssertionClaim(getDbAccessor(), {
				agentId: "dot",
				id: assertion.id,
				attributeId: "attr-signet",
			}),
		).toThrow(OntologyAssertionError);
	});

	it("rejects links to inactive claim attribute versions", () => {
		const assertion = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entityId: "entity-signet",
			predicate: "claims",
			content: "Signet has active assertion claims.",
			evidence: [{ source_kind: "test", quote: "active claim" }],
		});

		for (const attributeId of ["attr-superseded", "attr-deleted"]) {
			expect(() =>
				linkEpistemicAssertionClaim(getDbAccessor(), {
					agentId: "ant",
					id: assertion.id,
					attributeId,
				}),
			).toThrow(OntologyAssertionError);
		}

		expect(() =>
			createEpistemicAssertion(getDbAccessor(), {
				agentId: "ant",
				entityId: "entity-signet",
				predicate: "claims",
				content: "Signet should not point new assertions at inactive claim rows.",
				evidence: [{ source_kind: "test", quote: "inactive claim" }],
				claimAttributeId: "attr-superseded",
			}),
		).toThrow(OntologyAssertionError);
	});

	it("archives and supersedes assertions without deleting evidence", () => {
		const first = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			predicate: "claims",
			content: "Signet only needs similar text search.",
			evidence: [{ quote: "similar text" }],
			sourceKind: "transcript",
		});

		const next = supersedeEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			oldAssertionId: first.id,
			entity: "Signet",
			predicate: "claims",
			content: "Signet needs attributed assertions in addition to similarity.",
			evidence: [{ quote: "who believes what" }],
			sourceKind: "transcript",
		});

		expect(next.supersedesAssertionId).toBe(first.id);
		expect(getEpistemicAssertion(getDbAccessor(), { agentId: "ant", id: first.id })?.status).toBe("superseded");

		const archived = archiveEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			id: next.id,
			actor: "test",
			reason: "replaced by claim",
		});
		expect(archived.status).toBe("archived");
		expect(archived.evidence).toEqual([{ quote: "who believes what" }]);
	});

	it("rejects supersede requests that change the subject entity", () => {
		const first = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			predicate: "believes",
			content: "Signet should keep assertion history entity-scoped.",
			evidence: [{ quote: "entity-scoped history" }],
			sourceKind: "transcript",
		});

		expect(() =>
			supersedeEpistemicAssertion(getDbAccessor(), {
				agentId: "ant",
				oldAssertionId: first.id,
				entityId: "entity-rival",
				predicate: "believes",
				content: "Rival should not enter Signet's assertion history.",
				evidence: [{ quote: "different entity" }],
				sourceKind: "transcript",
			}),
		).toThrow(OntologyAssertionError);

		expect(getEpistemicAssertion(getDbAccessor(), { agentId: "ant", id: first.id })?.status).toBe("active");
	});

	it("preserves the old predicate when route supersede omits a replacement predicate", async () => {
		const first = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entity: "Signet",
			predicate: "believes",
			content: "Signet should preserve epistemic predicates.",
			evidence: [{ quote: "preserve predicates" }],
			sourceKind: "transcript",
		});
		const app = new Hono();
		registerOntologyRoutes(app);

		const res = await app.request(`/api/ontology/assertions/${first.id}/supersede?agent_id=ant`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				content: "Signet still preserves epistemic predicates.",
				evidence: [{ quote: "still preserves" }],
			}),
		});

		expect(res.status).toBe(200);
		const next = (await res.json()) as { readonly predicate?: string; readonly supersedesAssertionId?: string };
		expect(next.predicate).toBe("believes");
		expect(next.supersedesAssertionId).toBe(first.id);
	});

	it("rejects invalid assertions before writing", () => {
		expect(() =>
			createEpistemicAssertion(getDbAccessor(), {
				agentId: "ant",
				entity: "Signet",
				predicate: "maybe",
				content: "Invalid predicate.",
				evidence: [{ quote: "invalid" }],
			}),
		).toThrow(OntologyAssertionError);

		expect(() =>
			createEpistemicAssertion(getDbAccessor(), {
				agentId: "ant",
				entity: "Signet",
				predicate: "claims",
				content: "No provenance.",
			}),
		).toThrow(OntologyAssertionError);
	});
});

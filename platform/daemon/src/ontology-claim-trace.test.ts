import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createEpistemicAssertion, linkEpistemicAssertionClaim } from "./ontology-assertions";
import { OntologyClaimTraceError, explainOntologyClaim } from "./ontology-claim-trace";
import { registerOntologyRoutes } from "./routes/ontology-routes";

const now = "2026-08-10T00:00:00.000Z";

function insertMemory(
	db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
	input: {
		readonly id: string;
		readonly content: string;
		readonly agentId: string;
		readonly memoryKind: "episodic" | "derived";
		readonly isDeleted?: number;
	},
): void {
	db.prepare(
		`INSERT INTO memories
		 (id, content, type, agent_id, updated_by, memory_kind, visibility, scope, is_deleted, created_at, updated_at)
		 VALUES (?, ?, 'fact', ?, 'test', ?, 'global', NULL, ?, ?, ?)`,
	).run(input.id, input.content, input.agentId, input.memoryKind, input.isDeleted ?? 0, now, now);
}

function insertAttribute(
	db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
	input: {
		readonly id: string;
		readonly memoryId: string;
		readonly status: "active" | "superseded" | "deleted";
		readonly content: string;
		readonly version: number;
		readonly previousId: string | null;
		readonly evidence: readonly unknown[];
		readonly groupKey?: string;
		readonly claimKey?: string;
	},
): void {
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
		  confidence, importance, status, group_key, claim_key, version, version_root_id,
		  previous_attribute_id, proposal_evidence, created_at, updated_at)
		 VALUES (?, 'aspect-1', 'ant', ?, 'attribute', ?, ?, 0.9, 0.8, ?, ?,
		         ?, ?, 'attr-old', ?, ?, ?, ?)`,
	).run(
		input.id,
		input.memoryId,
		input.content,
		input.content.toLowerCase(),
		input.status,
		input.groupKey ?? "preferences",
		input.claimKey ?? "editor",
		input.version,
		input.previousId,
		JSON.stringify(input.evidence),
		now,
		now,
	);
}

function linkSource(
	db: { prepare(sql: string): { run(...params: unknown[]): unknown } },
	derivedMemoryId: string,
	sourceKind: string,
	sourceId: string,
): void {
	db.prepare(
		`INSERT INTO derived_memory_sources
		 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
		 VALUES (?, ?, ?, NULL, 'ant', ?)`,
	).run(derivedMemoryId, sourceKind, sourceId, now);
}

describe("authorized ontology claim traces", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-ontology-claim-trace-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-1', 'Editor', 'editor', 'tool', 'ant', 1, ?, ?)`,
			).run(now, now);
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('aspect-1', 'entity-1', 'ant', 'preferences', 'preferences', 0.8, ?, ?)`,
			).run(now, now);
			insertMemory(db, {
				id: "source-a",
				content: "The user prefers the editor to open files in tabs.",
				agentId: "ant",
				memoryKind: "episodic",
			});
			insertMemory(db, {
				id: "derived-old",
				content: "The editor opens files in tabs.",
				agentId: "ant",
				memoryKind: "derived",
			});
			insertMemory(db, {
				id: "derived-current",
				content: "The user prefers the editor to open files in tabs.",
				agentId: "ant",
				memoryKind: "derived",
			});
			insertMemory(db, {
				id: "derived-dependent",
				content: "The editor tab behavior is a current preference.",
				agentId: "ant",
				memoryKind: "derived",
			});
			insertAttribute(db, {
				id: "attr-old",
				memoryId: "derived-old",
				status: "superseded",
				content: "The editor opens files in tabs.",
				version: 1,
				previousId: null,
				evidence: [{ source_ref: "memory:source-a", quote: "open files in tabs" }],
			});
			insertAttribute(db, {
				id: "attr-current",
				memoryId: "derived-current",
				status: "active",
				content: "The user prefers the editor to open files in tabs.",
				version: 2,
				previousId: "attr-old",
				evidence: [{ source_ref: "memory:source-a", quote: "prefers the editor to open files in tabs" }],
			});
			db.prepare("UPDATE entity_attributes SET superseded_by = 'attr-current' WHERE id = 'attr-old'").run();
			insertAttribute(db, {
				id: "attr-dependent",
				memoryId: "derived-dependent",
				status: "active",
				content: "The editor tab behavior is a current preference.",
				version: 1,
				previousId: null,
				evidence: [],
				groupKey: "other",
				claimKey: "dependent",
			});
			linkSource(db, "derived-old", "memory", "source-a");
			linkSource(db, "derived-current", "memory", "source-a");
			linkSource(db, "derived-dependent", "memory", "derived-current");
		});
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns current truth, history, exact premises, assertions, and bounded reverse lineage", () => {
		const assertion = createEpistemicAssertion(getDbAccessor(), {
			agentId: "ant",
			entityId: "entity-1",
			predicate: "denies",
			content: "The editor should not open files in tabs.",
			evidence: [{ source_ref: "memory:source-a", quote: "prefers the editor" }],
		});
		linkEpistemicAssertionClaim(getDbAccessor(), {
			agentId: "ant",
			id: assertion.id,
			attributeId: "attr-current",
		});

		const trace = explainOntologyClaim(getDbAccessor(), {
			agentId: "ant",
			entity: "Editor",
			aspect: "preferences",
			group: "preferences",
			claim: "editor",
			versionLimit: 10,
			premiseLimit: 10,
			reverseLimit: 10,
			maxDepth: 2,
		});

		expect(trace.current.status).toBe("active");
		expect(trace.current.items.map((item) => item.attribute.id)).toEqual(["attr-current"]);
		expect(trace.versions.items.map((item) => item.attribute.id)).toEqual(["attr-current", "attr-old"]);
		expect(trace.versions.items[1]?.history.supersededBy).toBe("attr-current");
		expect(trace.premises.items).toHaveLength(3);
		expect(trace.premises.items.map((item) => item.evidence.exactQuote)).toEqual([
			"prefers the editor to open files in tabs",
			"open files in tabs",
			"prefers the editor",
		]);
		expect(trace.premises.items[0]?.evidence.excerpt).toContain("prefers the editor");
		expect(trace.integrity.status).toBe("verified");
		expect(trace.competing.contradictoryAssertions.map((item) => item.id)).toEqual([assertion.id]);
		expect(trace.reverse.items).toEqual([
			expect.objectContaining({
				memoryId: "derived-dependent",
				attributeId: "attr-dependent",
				depth: 1,
			}),
		]);
		expect(trace.traversal.bounded).toBe(true);
		expect(trace.traversal.limits.maxDepth).toBe(2);
	});

	it("keeps project-scoped reverse lineage within the authorized project", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE memories SET project = 'project-a' WHERE id IN ('source-a', 'derived-old', 'derived-current')",
			).run();
			db.prepare("UPDATE memories SET project = 'project-b' WHERE id = 'derived-dependent'").run();
		});

		const trace = explainOntologyClaim(getDbAccessor(), {
			agentId: "ant",
			entity: "Editor",
			aspect: "preferences",
			group: "preferences",
			claim: "editor",
			project: "project-a",
		});
		expect(trace.reverse.items).toHaveLength(0);
	});

	it("rejects a project-scoped claim whose semantic memory is outside the project", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET project = 'project-b' WHERE id = 'derived-current'").run();
		});
		expect(() =>
			explainOntologyClaim(getDbAccessor(), {
				agentId: "ant",
				entity: "Editor",
				aspect: "preferences",
				group: "preferences",
				claim: "editor",
				project: "project-a",
			}),
		).toThrowError(new OntologyClaimTraceError("Claim is outside the authorized project scope", 403));
	});

	it("resolves exact artifact spans without returning artifact session tokens", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"DELETE FROM derived_memory_sources WHERE derived_memory_id IN ('derived-old', 'derived-current')",
			).run();
			db.prepare(
				"UPDATE entity_attributes SET proposal_evidence = '[]' WHERE id IN ('attr-old', 'attr-current')",
			).run();
			db.prepare("UPDATE entity_attributes SET proposal_evidence = ? WHERE id = 'attr-current'").run(
				JSON.stringify([
					"artifact-secret-token",
					{
						source_ref: "artifact:sources/claim.md",
						quote: "The artifact confirms tabs.",
						session_token: "artifact-secret-token",
					},
				]),
			);
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/claim.md', 'sha-claim', 'source_obsidian_markdown',
				         'artifact-session', 'artifact-session', 'artifact-secret-token', ?,
				         'The artifact confirms tabs.', ?, 0)`,
			).run(now, now);
		});

		const trace = explainOntologyClaim(getDbAccessor(), {
			agentId: "ant",
			entity: "Editor",
			aspect: "preferences",
			group: "preferences",
			claim: "editor",
		});
		expect(trace.integrity.status).toBe("verified");
		expect(JSON.stringify(trace)).not.toContain("artifact-secret-token");
		expect(trace.premises.items[0]?.evidence).toMatchObject({
			sourceKind: "artifact",
			sourceId: "sources/claim.md",
			exactQuote: "The artifact confirms tabs.",
			scope: { sessionKeys: [] },
		});
	});

	it("does not treat legacy noncanonical lineage metadata as source evidence", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"DELETE FROM derived_memory_sources WHERE derived_memory_id IN ('derived-old', 'derived-current')",
			).run();
			db.prepare(
				"UPDATE entity_attributes SET proposal_evidence = '[]' WHERE id IN ('attr-old', 'attr-current')",
			).run();
			linkSource(db, "derived-current", "ontology_claim", "attr-old");
		});

		const trace = explainOntologyClaim(getDbAccessor(), {
			agentId: "ant",
			entity: "Editor",
			aspect: "preferences",
			group: "preferences",
			claim: "editor",
		});
		expect(trace.premises.items).toHaveLength(0);
		expect(trace.integrity.status).toBe("unverified");
	});

	it("rejects fabricated and cross-agent premise ids", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM derived_memory_sources WHERE derived_memory_id = 'derived-current'").run();
			linkSource(db, "derived-current", "memory", "missing-source");
		});
		expect(() =>
			explainOntologyClaim(getDbAccessor(), {
				agentId: "ant",
				entity: "Editor",
				aspect: "preferences",
				group: "preferences",
				claim: "editor",
			}),
		).toThrowError(new OntologyClaimTraceError("Claim premise 'memory:missing-source' was not found", 409));

		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM derived_memory_sources WHERE derived_memory_id = 'derived-current'").run();
			insertMemory(db, {
				id: "shared-id",
				content: "Other agent evidence.",
				agentId: "other",
				memoryKind: "episodic",
			});
			linkSource(db, "derived-current", "memory", "shared-id");
		});
		expect(() =>
			explainOntologyClaim(getDbAccessor(), {
				agentId: "ant",
				entity: "Editor",
				aspect: "preferences",
				group: "preferences",
				claim: "editor",
			}),
		).toThrowError(new OntologyClaimTraceError("Claim premise crosses the authorized agent scope", 403));
	});

	it("rejects an exact-quote claim that is not present in the source", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entity_attributes SET proposal_evidence = ? WHERE id = 'attr-current'").run(
				JSON.stringify([{ source_ref: "memory:source-a", quote: "This sentence was never recorded." }]),
			);
		});
		expect(() =>
			explainOntologyClaim(getDbAccessor(), {
				agentId: "ant",
				entity: "Editor",
				aspect: "preferences",
				group: "preferences",
				claim: "editor",
			}),
		).toThrowError(new OntologyClaimTraceError("Claim premise quote does not match the immutable source", 409));
	});

	it("reports deleted evidence as invalidated and rejects a session boundary crossing", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET is_deleted = 1 WHERE id = 'source-a'").run();
		});
		const invalidated = explainOntologyClaim(getDbAccessor(), {
			agentId: "ant",
			entity: "Editor",
			aspect: "preferences",
			group: "preferences",
			claim: "editor",
		});
		expect(invalidated.integrity.status).toBe("invalidated");
		expect(invalidated.premises.items[0]?.evidence.state).toBe("deleted");

		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM derived_memory_sources WHERE derived_memory_id = 'derived-current'").run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at, completed_at)
				 VALUES ('session-a', 'The user prefers the editor.', 'test', '/repo', 'ant', ?, ?, ?)`,
			).run(now, now, now);
			linkSource(db, "derived-current", "transcript", "session-a");
		});
		expect(() =>
			explainOntologyClaim(getDbAccessor(), {
				agentId: "ant",
				entity: "Editor",
				aspect: "preferences",
				group: "preferences",
				claim: "editor",
				sessionKey: "session-b",
			}),
		).toThrowError(new OntologyClaimTraceError("Claim trace premise crosses the authorized session boundary", 403));
	});

	it("serves the trace through the read-only HTTP route", async () => {
		const app = new Hono();
		registerOntologyRoutes(app);
		const response = await app.request(
			"/api/ontology/claims/explain?entity=Editor&aspect=preferences&group=preferences&claim=editor&agent_id=ant",
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { readonly integrity?: { readonly status?: string } };
		expect(body.integrity?.status).toBe("verified");

		const conflict = await app.request(
			"/api/ontology/claims/explain?entity=Editor&aspect=preferences&group=preferences&claim=editor&session_key=one",
			{ headers: { "x-signet-session-key": "two" } },
		);
		expect(conflict.status).toBe(400);
	});
});

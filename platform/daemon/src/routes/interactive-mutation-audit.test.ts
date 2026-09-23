/**
 * Behavior tests for the #913 hard cutover of LIVE interactive semantic
 * mutations onto the daemon-owned audited ontology apply path.
 *
 * Pin/unpin entity and create/archive entity alias now flow through
 * "applyOntologyOperation" (the audited apply path) rather than direct
 * knowledge-graph writers. Each migrated route/operation must both change the
 * underlying data AND create an applied ontology proposal audit record.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { OntologyProposalError, applyOntologyOperation, listOntologyProposals } from "../ontology-proposals";
import { registerKnowledgeRoutes } from "./knowledge-routes";
import { registerOntologyRoutes } from "./ontology-routes";

type ProposalRow = {
	readonly id: string;
	readonly operation: string;
	readonly status: string;
};

function proposalsFor(agentId: string, operation: string): readonly ProposalRow[] {
	return listOntologyProposals(getDbAccessor(), { agentId, operation, limit: 200 }).items.map((item) => ({
		id: item.id,
		operation: item.operation,
		status: item.status,
	}));
}

describe("interactive semantic mutation cutover", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-mutation-audit-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			const now = "2026-06-10T00:00:00.000Z";
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('ent-audit', 'Audit Entity', 'audit entity', 'project', 'ant', 1, ?, ?)`,
			).run(now, now);
		});
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	describe("pin/unpin via audited operation", () => {
		it("pin_entity changes data and writes an applied proposal", () => {
			const before = proposalsFor("ant", "pin_entity");
			expect(before).toHaveLength(0);

			const { proposal, result } = applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "pin_entity",
				payload: { id: "ent-audit" },
			});

			expect(proposal.status).toBe("applied");
			expect(proposal.operation).toBe("pin_entity");
			expect(result?.pinned).toBe(true);
			expect(typeof result?.pinnedAt).toBe("string");

			const pinned = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT pinned, pinned_at, proposal_id FROM entities WHERE id = ?").get("ent-audit") as
						| { pinned: number; pinned_at: string | null; proposal_id: string | null }
						| undefined,
			);
			expect(pinned?.pinned).toBe(1);
			expect(pinned?.pinned_at).toBe(result?.pinnedAt);
			expect(pinned?.proposal_id).toBe(proposal.id);
		});

		it("unpin_entity clears pinned state and writes an applied proposal", () => {
			applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "pin_entity",
				payload: { id: "ent-audit" },
			});

			const { proposal, result } = applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "unpin_entity",
				payload: { id: "ent-audit" },
			});

			expect(proposal.status).toBe("applied");
			expect(proposal.operation).toBe("unpin_entity");
			expect(result?.pinned).toBe(false);

			const after = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT pinned, pinned_at FROM entities WHERE id = ?").get("ent-audit") as
						| { pinned: number; pinned_at: string | null }
						| undefined,
			);
			expect(after?.pinned).toBe(0);
			expect(after?.pinned_at).toBeNull();
		});

		it("pin_entity on a missing entity throws 404 and writes no applied proposal", () => {
			expect(() =>
				applyOntologyOperation(getDbAccessor(), {
					agentId: "ant",
					actor: "operator",
					operation: "pin_entity",
					payload: { id: "missing" },
				}),
			).toThrow(OntologyProposalError);

			expect(proposalsFor("ant", "pin_entity").filter((p) => p.status === "applied")).toHaveLength(0);
		});
	});

	describe("entity aliases via audited operation", () => {
		it("create_entity_alias writes the alias and an applied proposal", () => {
			const { proposal, result } = applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "create_entity_alias",
				payload: { entity_id: "ent-audit", alias: "Audit Alias", source: "test" },
			});

			expect(proposal.status).toBe("applied");
			expect(proposal.operation).toBe("create_entity_alias");
			expect(typeof result?.aliasId).toBe("string");
			expect(result?.entityId).toBe("ent-audit");

			const alias = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT alias, canonical_alias, status, source FROM entity_aliases WHERE id = ?")
						.get(result?.aliasId) as
						| { alias: string; canonical_alias: string; status: string; source: string | null }
						| undefined,
			);
			expect(alias?.alias).toBe("Audit Alias");
			expect(alias?.canonical_alias).toBe("audit alias");
			expect(alias?.status).toBe("active");
			expect(alias?.source).toBe("test");
		});

		it("create_entity_alias on a missing entity throws 404", () => {
			expect(() =>
				applyOntologyOperation(getDbAccessor(), {
					agentId: "ant",
					actor: "operator",
					operation: "create_entity_alias",
					payload: { entity_id: "missing", alias: "Nope" },
				}),
			).toThrow(OntologyProposalError);
		});

		it("archive_entity_alias archives the alias and writes an applied proposal", () => {
			const created = applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "create_entity_alias",
				payload: { entity_id: "ent-audit", alias: "Archive Me" },
			});
			const aliasId = created.result?.aliasId as string;

			const { proposal, result } = applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "archive_entity_alias",
				payload: { entity_id: "ent-audit", alias_id: aliasId },
			});

			expect(proposal.status).toBe("applied");
			expect(proposal.operation).toBe("archive_entity_alias");
			expect(result?.archived).toBe(true);

			const alias = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status FROM entity_aliases WHERE id = ?").get(aliasId) as { status: string } | undefined,
			);
			expect(alias?.status).toBe("archived");
		});

		it("archive_entity_alias scoped to the owning entity throws 404 for a mismatched entity", () => {
			getDbAccessor().withWriteTx((db) => {
				const now = "2026-06-10T00:00:00.000Z";
				db.prepare(
					`INSERT INTO entities
					 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
					 VALUES ('ent-other', 'Other Entity', 'other entity', 'project', 'ant', 1, ?, ?)`,
				).run(now, now);
			});
			const created = applyOntologyOperation(getDbAccessor(), {
				agentId: "ant",
				actor: "operator",
				operation: "create_entity_alias",
				payload: { entity_id: "ent-audit", alias: "Scoped" },
			});
			const aliasId = created.result?.aliasId as string;

			expect(() =>
				applyOntologyOperation(getDbAccessor(), {
					agentId: "ant",
					actor: "operator",
					operation: "archive_entity_alias",
					payload: { entity_id: "ent-other", alias_id: aliasId },
				}),
			).toThrow(OntologyProposalError);
		});
	});

	describe("migrated routes over HTTP preserve response contracts", () => {
		it("POST /api/knowledge/entities/:id/pin pins and returns the pinnedAt", async () => {
			const app = new Hono();
			registerKnowledgeRoutes(app);

			const res = await app.request("/api/knowledge/entities/ent-audit/pin?agent_id=ant", { method: "POST" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { readonly pinned: boolean; readonly pinnedAt: string };
			expect(body.pinned).toBe(true);
			expect(typeof body.pinnedAt).toBe("string");

			expect(proposalsFor("ant", "pin_entity").filter((p) => p.status === "applied")).toHaveLength(1);
		});

		it("POST /api/knowledge/entities/:id/pin on a missing entity returns 404", async () => {
			const app = new Hono();
			registerKnowledgeRoutes(app);

			const res = await app.request("/api/knowledge/entities/missing/pin?agent_id=ant", { method: "POST" });
			expect(res.status).toBe(404);
		});

		it("DELETE /api/knowledge/entities/:id/pin unpins idempotently", async () => {
			const app = new Hono();
			registerKnowledgeRoutes(app);

			const res = await app.request("/api/knowledge/entities/ent-audit/pin?agent_id=ant", { method: "DELETE" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { readonly pinned: boolean };
			expect(body.pinned).toBe(false);

			expect(proposalsFor("ant", "unpin_entity").filter((p) => p.status === "applied")).toHaveLength(1);
		});

		it("POST /api/ontology/entities/:id/aliases creates an alias and returns the item", async () => {
			const app = new Hono();
			registerOntologyRoutes(app);

			const res = await app.request("/api/ontology/entities/ent-audit/aliases?agent_id=ant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ alias: "Route Alias", source: "route" }),
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as {
				readonly item: { readonly id: string; readonly alias: string; readonly status: string };
			};
			expect(body.item.alias).toBe("Route Alias");
			expect(body.item.status).toBe("active");

			expect(proposalsFor("ant", "create_entity_alias").filter((p) => p.status === "applied")).toHaveLength(1);
		});

		it("POST /api/ontology/entities/:id/aliases on a missing entity returns 404", async () => {
			const app = new Hono();
			registerOntologyRoutes(app);

			const res = await app.request("/api/ontology/entities/missing/aliases?agent_id=ant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ alias: "Nope" }),
			});
			expect(res.status).toBe(404);
		});

		it("POST /api/ontology/entities/:id/aliases on a duplicate returns 409", async () => {
			const app = new Hono();
			registerOntologyRoutes(app);

			await app.request("/api/ontology/entities/ent-audit/aliases?agent_id=ant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ alias: "Duplicate" }),
			});
			const res = await app.request("/api/ontology/entities/ent-audit/aliases?agent_id=ant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ alias: "Duplicate" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { readonly error: string };
			expect(body.error).toBe("alias already exists");
		});

		it("DELETE /api/ontology/entities/:id/aliases/:aliasId archives and returns the item", async () => {
			const app = new Hono();
			registerOntologyRoutes(app);

			const created = await app.request("/api/ontology/entities/ent-audit/aliases?agent_id=ant", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ alias: "To Archive" }),
			});
			const createdBody = (await created.json()) as { readonly item: { readonly id: string } };

			const res = await app.request(`/api/ontology/entities/ent-audit/aliases/${createdBody.item.id}?agent_id=ant`, {
				method: "DELETE",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				readonly item: { readonly status: string };
			};
			expect(body.item.status).toBe("archived");

			expect(proposalsFor("ant", "archive_entity_alias").filter((p) => p.status === "applied")).toHaveLength(1);
		});

		it("DELETE /api/ontology/entities/:id/aliases/:aliasId on a missing alias returns 404", async () => {
			const app = new Hono();
			registerOntologyRoutes(app);

			const res = await app.request("/api/ontology/entities/ent-audit/aliases/missing?agent_id=ant", {
				method: "DELETE",
			});
			expect(res.status).toBe(404);
		});
	});

	describe("retired direct writers are gone", () => {
		it("knowledge-graph no longer exports pinEntity/unpinEntity/createEntityAlias/archiveEntityAlias", async () => {
			const mod = await import("../knowledge-graph");
			expect(mod.pinEntity).toBeUndefined();
			expect(mod.unpinEntity).toBeUndefined();
			expect(mod.createEntityAlias).toBeUndefined();
			expect(mod.archiveEntityAlias).toBeUndefined();
		});
	});
});

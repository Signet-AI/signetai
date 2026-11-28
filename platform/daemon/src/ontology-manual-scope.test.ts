import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up as upgradeDreamingPartitions } from "../../core/src/migrations/179-dreaming-evidence-leases";
import { executeClassification } from "./classification-owner";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { consolidateOntologyProposals } from "./ontology-consolidation";
import { extractOntologyProposals } from "./ontology-extraction";
import { applyOntologyProposal, createOntologyProposal } from "./ontology-proposals";
import { applyDreamingOperations } from "./pipeline/dreaming-operations";
import {
	createEpistemicAssertion,
	archiveEpistemicAssertion,
	linkEpistemicAssertionClaim,
	supersedeEpistemicAssertion,
} from "./ontology-assertions";
import { Hono } from "hono";
import { localPrincipal } from "./auth/principal";
import { bindPrincipalAccess } from "./auth/agent-access";
import { registerOntologyRoutes } from "./routes/ontology-routes";
import type { ReadScope } from "./read-scope";

const author = { userId: null, credential: "system" };
const hiddenScope: ReadScope = { reach: { kind: "own", agentId: "team" }, compartments: [], projects: null };
const readableScope: ReadScope = { ...hiddenScope, compartments: [91] };

describe("manual ontology compartment boundaries", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ontology-manual-scope-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			upgradeDreamingPartitions(db);
			db.exec(`INSERT INTO compartments (id,key,created_at) VALUES (91,'cls_hr',datetime('now'));
			INSERT INTO compartment_members (compartment_id,classification_id) VALUES (91,'cls_hr');
			INSERT INTO memories (id,content,source_type,memory_kind,visibility,agent_id,compartment_id,created_at,updated_at)
			VALUES ('m-hr','Alice Smith is being laid off next month; severance 40k.','manual','episodic','normal','team',91,datetime('now'),datetime('now'));`);
		});
	});
	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	const operation = { operation: "rename_entity", payload: { entity_id: "target", name: "Renamed" } };
	const mutationRoutes = [
		["POST", "entities/target/aliases", { alias: "alias" }],
		["DELETE", "entities/target/aliases/alias", {}],
		["POST", "proposals/repair/duplicates", {}],
		["POST", "proposals/repair/merge-plan", { target_entity_id: "target", source_entity_ids: ["source"] }],
		["POST", "extract", { from: "memory:m-hr", write_proposals: true }],
		["POST", "consolidate", {}],
		[
			"POST",
			"assertions",
			{ entity_id: "target", predicate: "believes", content: "new", evidence: [{ quote: "new" }] },
		],
		["POST", "assertions/assertion/link-claim", { attribute_id: "attribute" }],
		["POST", "assertions/assertion/archive", {}],
		["POST", "assertions/assertion/supersede", { predicate: "believes", content: "new", evidence: [{ quote: "new" }] }],
		["POST", "operations/apply", operation],
		["POST", "operations/batch", { operations: [operation] }],
		["POST", "proposals", operation],
		["POST", "proposals/batch", { proposals: [operation] }],
		["POST", "proposals/proposal/apply", {}],
		["POST", "proposals/proposal/reject", {}],
	] as const;
	it.each(mutationRoutes)("hides classified rows across %s %s", async (method, path, body) => {
		getDbAccessor().withWriteTx((db) =>
			db.exec(`
		INSERT INTO entities (id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at) VALUES ('target','Hidden','hidden','project','team',91,datetime('now'),datetime('now'));
		INSERT INTO epistemic_assertions(id,agent_id,subject_entity_id,predicate,content,normalized_content,asserted_at,created_by,created_at,updated_at,compartment_id) VALUES ('assertion','team','target','believes','hidden','hidden',datetime('now'),'test',datetime('now'),datetime('now'),91);
		INSERT INTO ontology_proposals(id,agent_id,operation,status,payload,confidence,rationale,evidence,created_by,created_at,updated_at,compartment_id) VALUES ('proposal','team','create_entity','pending','{"name":"Hidden proposed"}',0.9,'hidden','[]','test',datetime('now'),datetime('now'),91);`),
		);
		const principal = {
			...localPrincipal(),
			kind: "user" as const,
			userId: "member",
			role: "operator" as const,
			boundAgentId: "team",
			groupIds: ["group"],
		};
		bindPrincipalAccess(principal, {
			agentModel: "personal",
			personalAgentsSelfService: true,
			organizationAgentId: "default",
			personalAgentId: null,
			defaultReadAgentId: "team",
			agents: [{ id: "team", kind: "team", owner_user_id: null, owner_group_id: "group", archived_at: null }],
		});
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("principal", principal);
			c.set("organization", true);
			c.set("author", author);
			await next();
		});
		registerOntologyRoutes(app);
		const request = () =>
			app.request(`/api/ontology/${path}?agent_id=team`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const hidden = await request();
		const hiddenBody: unknown = await hidden.json();
		getDbAccessor().withWriteTx((db) =>
			db.exec(
				"DELETE FROM ontology_proposals; DELETE FROM epistemic_assertions; DELETE FROM entities; DELETE FROM memories",
			),
		);
		const absent = await request();
		expect([hidden.status, hiddenBody]).toEqual([absent.status, await absent.json()]);
		expect(JSON.stringify(hiddenBody)).not.toContain("Hidden");
	});

	it("hides classified assertion subjects by name and id", () => {
		getDbAccessor().withWriteTx((db) =>
			db.exec(
				`INSERT INTO entities (id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at) VALUES ('e-hr','Layoff plan','layoff plan','project','team',91,datetime('now'),datetime('now'));`,
			),
		);
		for (const selector of [{ entity: "Layoff plan" }, { entityId: "e-hr" }]) {
			expect(() =>
				createEpistemicAssertion(getDbAccessor(), {
					agentId: "team",
					readScope: hiddenScope,
					...selector,
					predicate: "believes",
					content: "confidential",
					evidence: [{ source_kind: "memory", source_id: "m-hr", quote: "Alice Smith" }],
				}),
			).toThrow(selector.entityId ? "entity_id was not found" : "entity was not found");
		}
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM epistemic_assertions").get()),
		).toEqual({ n: 0 });
	});

	it("inherits assertion target and evidence labels and citations", () => {
		getDbAccessor().withWriteTx((db) =>
			db.exec(
				`INSERT INTO entities (id,name,canonical_name,entity_type,agent_id,compartment_id,created_at,updated_at) VALUES ('e-hr','Layoff plan','layoff plan','project','team',91,datetime('now'),datetime('now'));`,
			),
		);
		const assertion = createEpistemicAssertion(getDbAccessor(), {
			agentId: "team",
			readScope: readableScope,
			entityId: "e-hr",
			predicate: "believes",
			content: "confidential",
			evidence: [{ source_kind: "memory", source_id: "m-hr", quote: "Alice Smith" }],
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT compartment_id FROM epistemic_assertions WHERE id=?").get(assertion.id),
			),
		).toEqual({ compartment_id: 91 });
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='assertion'").all(),
			),
		).toEqual([{ evidence_kind: "memory", evidence_id: "m-hr" }]);
	});

	it("refuses a NULL-label assertion mutation pointing at a classified subject", () => {
		getDbAccessor().withWriteTx((db) =>
			db.exec(`INSERT INTO entities(id,name,entity_type,agent_id,compartment_id,created_at,updated_at) VALUES ('e-hr','HR','project','team',91,'now','now');
		INSERT INTO epistemic_assertions(id,agent_id,subject_entity_id,predicate,content,normalized_content,asserted_at,created_by,created_at,updated_at) VALUES ('malformed','team','e-hr','believes','bad label','bad label','now','test','now','now')`),
		);
		expect(() =>
			archiveEpistemicAssertion(getDbAccessor(), {
				agentId: "team",
				id: "malformed",
				actor: "test",
				readScope: readableScope,
			}),
		).toThrow("compartment_mismatch");
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT status FROM epistemic_assertions WHERE id='malformed'").get(),
			),
		).toEqual({ status: "active" });
	});

	it("hides classified assertions across link archive and supersede", () => {
		getDbAccessor().withWriteTx((db) =>
			db.exec(`INSERT INTO entities (id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES ('e-public','Public','public','project','team',datetime('now'),datetime('now'));
		INSERT INTO epistemic_assertions (id,agent_id,subject_entity_id,predicate,content,normalized_content,asserted_at,created_by,created_at,updated_at,compartment_id) VALUES ('a-hr','team','e-public','believes','secret','secret',datetime('now'),'test',datetime('now'),datetime('now'),91);`),
		);
		for (const id of ["a-hr", "absent"]) {
			const base = { agentId: "team", readScope: hiddenScope, id };
			expect(() => archiveEpistemicAssertion(getDbAccessor(), { ...base, actor: "test" })).toThrow(
				"assertion was not found",
			);
			expect(() => linkEpistemicAssertionClaim(getDbAccessor(), { ...base, attributeId: "absent" })).toThrow(
				"assertion was not found",
			);
			expect(() =>
				supersedeEpistemicAssertion(getDbAccessor(), {
					...base,
					oldAssertionId: id,
					predicate: "believes",
					content: "new",
					evidence: [{ quote: "new" }],
				}),
			).toThrow("assertion was not found");
		}
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT status FROM epistemic_assertions").all())).toEqual([
			{ status: "active" },
		]);
	});

	it("does not consolidate hidden proposals into counts or provider prompts", async () => {
		await extractOntologyProposals(getDbAccessor(), {
			agentId: "team",
			from: "memory:m-hr",
			readScope: readableScope,
			writeProposals: true,
			author,
		});
		await createOntologyProposal(getDbAccessor(), {
			agentId: "team",
			readScope: hiddenScope,
			operation: "create_entity",
			payload: { name: "Public candidate" },
			author,
		});
		let prompt = "";
		const result = await consolidateOntologyProposals(getDbAccessor(), {
			agentId: "team",
			readScope: hiddenScope,
			useProvider: true,
			provider: {
				name: "probe",
				available: async () => true,
				generate: async (value) => {
					prompt = value;
					return "{}";
				},
			},
		});
		expect(result.sourceProposalCount).toBe(1);
		expect(prompt).toContain("Public candidate");
		expect(prompt).not.toContain("Alice Smith");
		expect(result.proposals).toEqual([]);
	});

	it("does not use hidden attention ids as manual evidence authorization", async () => {
		getDbAccessor().withWriteTx((db) =>
			db.exec(
				"INSERT INTO dreaming_attention(id,agent_id,kind,subject_ref,details_json,compartment_id) VALUES('attention-hidden','team','hygiene','entity:hidden','{}',91)",
			),
		);
		const evidence = [
			{
				source_ref: "attention:attention-hidden",
				source_kind: "attention",
				source_id: "attention-hidden",
				source_root: "dreaming_attention",
			},
		];
		for (const state of ["hidden", "absent"]) {
			if (state === "absent") getDbAccessor().withWriteTx((db) => db.exec("DELETE FROM dreaming_attention"));
			await expect(
				createOntologyProposal(getDbAccessor(), {
					agentId: "team",
					readScope: { ...hiddenScope, organizationMode: true },
					operation: "create_entity",
					payload: { name: "Never minted" },
					evidence,
					author,
				}),
			).rejects.toThrow("Evidence source_ref must name a canonical episodic source");
		}
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM ontology_proposals").get()),
		).toEqual({ n: 0 });
	});

	it("makes hidden foreign and absent citations identical before effects", async () => {
		const errors: unknown[] = [];
		const proposalErrors: string[] = [];
		for (const state of ["hidden", "foreign", "absent"]) {
			if (state === "foreign")
				getDbAccessor().withWriteTx((db) =>
					db.exec("UPDATE memories SET agent_id='private-colleague' WHERE id='m-hr'"),
				);
			if (state === "absent") getDbAccessor().withWriteTx((db) => db.exec("DELETE FROM memories WHERE id='m-hr'"));
			const operation = {
				operation: "create_entity",
				payload: { name: "Must not exist" },
				evidence: [{ source_ref: "memory:m-hr", quote: "Alice Smith" }],
			};
			errors.push(
				await applyDreamingOperations({
					accessor: getDbAccessor(),
					agentId: "team",
					actor: "test",
					operations: [operation],
				}),
			);
			try {
				await createOntologyProposal(getDbAccessor(), {
					agentId: "team",
					readScope: hiddenScope,
					author,
					...operation,
				});
			} catch (error) {
				proposalErrors.push(error instanceof Error ? error.message : String(error));
			}
		}
		expect(errors).toHaveLength(3);
		expect(errors[0]).toMatchObject({ ok: false, items: [] });
		expect(errors[0]).toEqual(errors[1]);
		expect(errors[1]).toEqual(errors[2]);
		expect(proposalErrors).toEqual(Array(3).fill("Evidence source_ref was not found: memory:m-hr"));
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT (SELECT COUNT(*) FROM entities) AS entities,(SELECT COUNT(*) FROM ontology_proposals) AS proposals,(SELECT COUNT(*) FROM dreaming_attention) AS flags",
					)
					.get(),
			),
		).toEqual({ entities: 0, proposals: 0, flags: 0 });
	});

	it("does not extract unreadable evidence or send it to a provider", async () => {
		let calls = 0;
		for (const from of ["memory:m-hr", "memory:missing"]) {
			await expect(
				extractOntologyProposals(getDbAccessor(), {
					agentId: "team",
					from,
					readScope: hiddenScope,
					writeProposals: true,
					author,
					useProvider: true,
					provider: {
						name: "probe",
						available: async () => true,
						generate: async () => {
							calls++;
							return "{}";
						},
					},
				}),
			).rejects.toMatchObject({ message: "Extraction source not found", status: 404 });
		}
		expect(calls).toBe(0);
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM ontology_proposals").get()),
		).toEqual({ n: 0 });
	});

	it("keeps readable extraction pending and cites and labels the applied claim", async () => {
		const result = await extractOntologyProposals(getDbAccessor(), {
			agentId: "team",
			from: "memory:m-hr",
			readScope: readableScope,
			writeProposals: true,
			author,
		});
		expect(result.items.length).toBeGreaterThan(0);
		expect(getDbAccessor().withReadDb((db) => db.prepare("SELECT COUNT(*) AS n FROM entity_attributes").get())).toEqual(
			{ n: 0 },
		);
		for (const item of result.items) {
			expect(item.status).toBe("pending");
			await applyOntologyProposal(getDbAccessor(), {
				agentId: "team",
				id: item.id,
				actor: "human",
				author,
				readScope: readableScope,
			});
		}
		expect(
			getDbAccessor().withReadDb((db) => db.prepare("SELECT compartment_id FROM entity_attributes").all()),
		).toEqual([{ compartment_id: 91 }]);
		expect(
			getDbAccessor().withReadDb((db) =>
				db.prepare("SELECT evidence_kind,evidence_id FROM evidence_citations WHERE derived_kind='attribute'").all(),
			),
		).toEqual([{ evidence_kind: "memory", evidence_id: "m-hr" }]);
		await getDbAccessor().withWriteDbAsync((db) => {
			db.exec(
				"INSERT INTO classifications(id,name) VALUES('cls_new','New'); INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id,applied_by,applied_at) VALUES('memory','m-hr','team','cls_new','test','now')",
			);
			return executeClassification(db, { op: "rebuild", agentId: "team" });
		});
		expect(
			getDbAccessor().withReadDb((db) =>
				db
					.prepare(
						"SELECT a.compartment_id=m.compartment_id AS inherited FROM entity_attributes a JOIN memories m ON m.id='m-hr' AND m.agent_id=a.agent_id",
					)
					.all(),
			),
		).toEqual([{ inherited: 1 }]);
	});
});

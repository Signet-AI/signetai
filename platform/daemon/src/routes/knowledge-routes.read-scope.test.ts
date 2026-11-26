import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureCompartmentShards } from "@signet/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import { localPrincipal, type Principal } from "../auth/principal";
import { closeDbAccessor, getDbAccessor, getDbAccessorPath, initDbAccessor } from "../db-accessor";
import { ownerReadAll } from "../db-owner-sql";
import { getDbOwner } from "../db-owner-runtime";
import { knowledgeReadOwner } from "../knowledge-graph-hygiene";
import { resolveFocalEntitiesViaOwner } from "../pipeline/graph-traversal";
import { resolveReadScope } from "../read-scope";
import { registerKnowledgeRoutes } from "./knowledge-routes";
import { registerOntologyRoutes } from "./ontology-routes";

const NOW = "2026-11-25T00:00:00.000Z";

async function appFor(
	userId = "reader",
	agentId = "default",
	projects: readonly string[] | null = null,
): Promise<Hono> {
	const principal: Principal = {
		...localPrincipal(),
		kind: "user",
		userId,
		role: "member",
		credential: { kind: "session", id: userId },
		allowedProjects: projects,
	};
	bindPrincipalAccess(principal, {
		agentModel: "personal",
		personalAgentsSelfService: true,
		organizationAgentId: "default",
		personalAgentId: null,
		defaultReadAgentId: agentId,
		agents: ["default", "peer"].map((id) => ({
			id,
			kind: id === "default" ? "organization" : "personal",
			owner_user_id: id === "peer" ? "audience" : null,
			owner_group_id: null,
			archived_at: null,
		})),
	});
	const organization = await readOrganization();
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("principal", principal);
		c.set("organization", organization);
		await next();
	});
	registerKnowledgeRoutes(app);
	registerOntologyRoutes(app);
	return app;
}

function seed(hidden = false): void {
	getDbAccessor().withWriteTx((db) => {
		const id = hidden ? "hidden" : "public";
		const agent = hidden ? "peer" : "default";
		const compartment = hidden ? 9 : null;
		db.prepare(
			"INSERT INTO entities (id,name,canonical_name,entity_type,agent_id,mentions,pinned,created_at,updated_at,compartment_id) VALUES (?,?,?,'project',?,10,1,?,?,?)",
		).run(id, `${id} needle`, `${id} needle`, agent, NOW, NOW, compartment);
		db.prepare(
			"INSERT INTO entity_aspects (id,entity_id,agent_id,name,canonical_name,weight,created_at,updated_at,compartment_id) VALUES (?,?,?,'details','details',1,?,?,?)",
		).run(`${id}-aspect`, id, agent, NOW, NOW, compartment);
		db.prepare(
			"INSERT INTO entity_attributes (id,aspect_id,agent_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,created_at,updated_at,compartment_id) VALUES (?,?,?,'attribute',?,?,'general','claim',1,1,'active',?,?,?)",
		).run(`${id}-attribute`, `${id}-aspect`, agent, `${id} value`, `${id} value`, NOW, NOW, compartment);
		db.prepare(
			"INSERT INTO ontology_proposals (id,agent_id,operation,payload,evidence,rationale,confidence,status,created_at,updated_at,compartment_id) VALUES (?,?,'add_entity','{}','[]',?,1,'pending',?,?,?)",
		).run(`${id}-proposal`, agent, `${id} rationale`, NOW, NOW, compartment);
		db.prepare(
			"INSERT INTO epistemic_assertions (id,agent_id,subject_entity_id,claim_attribute_id,predicate,content,normalized_content,confidence,status,asserted_at,created_at,updated_at,compartment_id) VALUES (?,?,?,?,'claims',?,?,1,'active',?,?,?,?)",
		).run(
			`${id}-assertion`,
			agent,
			id,
			`${id}-attribute`,
			`${id} assertion`,
			`${id} assertion`,
			NOW,
			NOW,
			NOW,
			compartment,
		);
		db.prepare(
			"INSERT INTO memories (id,content,type,memory_kind,agent_id,updated_by,created_at,updated_at,compartment_id) VALUES (?,?,'fact','episodic',?,'test',?,?,?)",
		).run(`${id}-memory`, `${id} memory evidence`, agent, NOW, NOW, compartment);
		db.prepare("UPDATE entity_attributes SET memory_id=?,proposal_evidence=? WHERE id=?").run(
			`${id}-memory`,
			JSON.stringify([{ memory_id: `${id}-memory`, quote: `${id} memory` }]),
			`${id}-attribute`,
		);
		db.prepare(
			"INSERT INTO evidence_citations (derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES ('attribute',?,?,'memory',?)",
		).run(`${id}-attribute`, agent, `${id}-memory`);
		db.prepare(
			"INSERT INTO entity_attributes (id,aspect_id,agent_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,created_at,updated_at,compartment_id) VALUES (?,?,?,'attribute','other value','other value','general','other',1,0.5,'active',?,?,?)",
		).run(`${id}-other`, `${id}-aspect`, agent, NOW, NOW, compartment);
		db.prepare(
			"INSERT INTO entity_dependencies (id,source_entity_id,target_entity_id,agent_id,dependency_type,strength,created_at,updated_at,compartment_id) VALUES (?,?,?,?,'uses',1,?,?,?)",
		).run(`${id}-link`, id, id, agent, NOW, NOW, compartment);
		db.prepare("INSERT INTO entity_aliases (id,entity_id,agent_id,alias,canonical_alias) VALUES (?,?,?,?,?)").run(
			`${id}-alias`,
			id,
			agent,
			`${id} alias`,
			`${id} alias`,
		);
		db.prepare("INSERT INTO entity_communities (id,agent_id,name,member_count,compartment_id) VALUES (?,?,?,1,?)").run(
			`${id}-community`,
			agent,
			`${id} community`,
			compartment,
		);
		db.prepare(
			"INSERT INTO ontology_contradictions (id,agent_id,entity_id,entity_name,aspect_id,aspect_name,claim_key,left_attribute_id,right_attribute_id,left_content,right_content,detector,reason,detected_at,created_at,updated_at,compartment_id) VALUES (?,?,?,?,?,'details','claim',?,?,'value','other','manual','fixture',?,?,?,?)",
		).run(
			`${id}-contradiction`,
			agent,
			id,
			`${id} needle`,
			`${id}-aspect`,
			`${id}-attribute`,
			`${id}-other`,
			NOW,
			NOW,
			NOW,
			compartment,
		);
	});
}

async function capture(app: Hono, paths: readonly string[]): Promise<readonly unknown[]> {
	return Promise.all(
		paths.map(async (path) => {
			const response = await app.request(path);
			const body: unknown = await response.json();
			expect(response.status).toBe(200);
			if (typeof body === "object" && body !== null && "latencyMs" in body) {
				const { latencyMs: _latency, ...stable } = body;
				return stable;
			}
			return body;
		}),
	);
}

describe("knowledge and ontology organization reads", () => {
	test("knowledge expansion checks recall permission before resolving an unauthorized scope", async () => {
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("principal", { ...localPrincipal(), kind: "user", userId: "reader", permissions: new Set() });
			c.set("organization", await readOrganization());
			await next();
		});
		registerKnowledgeRoutes(app);
		const response = await app.request("/api/knowledge/expand", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ entity: "public" }),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ reason: "permission", required: "recall" });
	});
	test("an evidence quote is dropped with its unreadable memory rather than keeping an orphan quote", async () => {
		await getDbAccessor().withWriteTxAsync((db) =>
			db.exec(
				"INSERT INTO memories(id,agent_id,content,created_at,updated_at,compartment_id) VALUES('quote-secret','default','private','now','now',9); UPDATE entity_attributes SET proposal_evidence=json_array(json_object('memory_id','quote-secret','quote','SECRETQUOTE'),json_object('quote','public quote')) WHERE id='public-attribute'",
			),
		);
		const path = "/api/knowledge/entities/public/aspects/public-aspect/attributes";
		const outside = JSON.stringify(await (await (await appFor()).request(path)).json());
		expect(outside).not.toContain("SECRETQUOTE");
		expect(outside).toContain("public quote");
		expect(JSON.stringify(await (await (await appFor("audience")).request(path)).json())).toContain("SECRETQUOTE");
	});

	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-knowledge-read-scope-"));
		initDbAccessor(join(dir, "signet.db"));
		getDbAccessor().withWriteTx((db) => {
			for (const user of ["reader", "audience", "group-reader"])
				db.prepare(
					"INSERT INTO users (id,username,display_name,role,created_at,updated_at) VALUES (?,?,?,'member',?,?)",
				).run(user, user, user, NOW, NOW);
			db.prepare(
				"INSERT INTO agents (id,name,kind,owner_user_id,created_at,updated_at) VALUES ('peer','peer','personal','audience',?,?)",
			).run(NOW, NOW);
			db.prepare(
				"INSERT INTO classifications (id,name,created_at,updated_at) VALUES ('cls_private','Private',?,?)",
			).run(NOW, NOW);
			db.prepare("INSERT INTO classification_audience VALUES ('cls_private','user','audience')").run();
			db.prepare("INSERT INTO groups (id,name,created_at,updated_at) VALUES ('grp_private','private',?,?)").run(
				NOW,
				NOW,
			);
			db.prepare(
				"INSERT INTO group_members (group_id,user_id,role,created_at) VALUES ('grp_private','group-reader','member',?)",
			).run(NOW);
			db.prepare("INSERT INTO classification_audience VALUES ('cls_private','group','grp_private')").run();
			db.prepare("INSERT INTO compartments (id,key,created_at) VALUES (9,'cls_private',?)").run(NOW);
			db.prepare("INSERT INTO compartment_members VALUES (9,'cls_private')").run();
			ensureCompartmentShards(db, 9, 384);
		});
		seed();
	});
	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	test("typed proposal references cannot borrow another table's visibility", async () => {
		seed(true);
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('hidden','visible unrelated memory','default',?,?)",
			).run(NOW, NOW);
			db.exec("UPDATE ontology_proposals SET payload=json_object('entityId','hidden') WHERE id='public-proposal'");
		});
		const path = "/api/ontology/proposals/public-proposal";
		expect(JSON.stringify(await capture(await appFor(), [path]))).not.toContain('"entityId":"hidden"');
		expect(JSON.stringify(await capture(await appFor("audience"), [path]))).toContain('"entityId":"hidden"');
	});

	test("public graph pointers hide unreadable targets and internal fields", async () => {
		seed(true);
		await getDbAccessor().withWriteTxAsync((db) =>
			db.exec(
				"UPDATE entity_attributes SET memory_id='hidden-memory',superseded_by='hidden-attribute',previous_attribute_id='hidden-other',version_root_id='hidden-attribute',status='superseded',version=7,proposal_evidence=json_array(json_object('memory_id','hidden-memory')) WHERE id='public-attribute'",
			),
		);
		const path =
			"/api/knowledge/navigation/attributes?entity=public%20needle&aspect=details&group=general&claim=claim&status=all";
		const outside = await capture(await appFor(), [path]);
		const encoded = JSON.stringify(outside);
		for (const value of [
			"hidden-memory",
			"hidden-attribute",
			"hidden-other",
			"normalizedContent",
			"normalized_content",
			"compartment_id",
			"rowid",
		])
			expect(encoded).not.toContain(value);
		expect(encoded).toContain("public value");
		const active = JSON.stringify(await capture(await appFor(), [path.replace("status=all", "status=active")]));
		expect(active).toContain("public value");
		const audience = JSON.stringify(await capture(await appFor("audience"), [path]));
		expect(audience).toContain("hidden-memory");
		expect(audience).toContain("hidden-attribute");
	});

	test("entity FTS ordering in an isolated reach ignores other-agent index statistics", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES('rank-beta','beta','beta','project','default',?,?),('rank-alpha','alpha','alpha','project','default',?,?)",
			).run(NOW, NOW, NOW, NOW);
		});
		const scope = { reach: { kind: "own" as const, agentId: "default" }, compartments: [], projects: null };
		const query = async () =>
			ownerReadAll<{ id: string }>(
				await knowledgeReadOwner(await getDbOwner(getDbAccessorPath()), scope),
				"SELECT e.id FROM entities_fts JOIN entities e ON e.rowid=entities_fts.rowid WHERE entities_fts MATCH ? AND e.agent_id=? ORDER BY rank LIMIT 20",
				["alpha OR beta", "default"],
				{ operation: "test.entity-fts-statistics", deadlineMs: 3000 },
			);
		const before = await query();
		getDbAccessor().withWriteTx((db) => {
			const insert = db.prepare(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) VALUES(?,?,?,'project','peer',?,?)",
			);
			for (let index = 0; index < 20; index++)
				insert.run(`outside-${index}`, `beta outside ${index}`, `beta outside ${index}`, NOW, NOW);
		});
		expect(await query()).toEqual(before);
	});

	test("named resolution ignores hidden mentions and global rank metadata", async () => {
		await getDbAccessor().withWriteTxAsync((db) =>
			db.exec(
				"UPDATE entities SET name='candidate alpha',canonical_name='candidate alpha',mentions=0 WHERE id='public'; INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,mentions,created_at,updated_at) SELECT 'candidate-beta','candidate beta','candidate beta','project',agent_id,0,created_at,updated_at FROM entities WHERE id='public'",
			),
		);
		const app = await appFor();
		const paths = ["/api/knowledge/navigation/entity?name=candidate"];
		const before = await capture(app, paths);
		expect(JSON.stringify(before)).toContain("candidate alpha");
		await getDbAccessor().withWriteTxAsync((db) =>
			db.exec(
				"INSERT INTO memories(id,agent_id,content,created_at,updated_at,compartment_id) VALUES('hidden-mention','default','hidden mention','2099-01-01','2099-01-01',9); INSERT INTO memory_entity_mentions(memory_id,entity_id) VALUES('hidden-mention','candidate-beta'); UPDATE entities SET mentions=99999,updated_at='2099-01-01' WHERE id='candidate-beta'",
			),
		);
		expect(await capture(app, paths)).toEqual(before);
		expect(JSON.stringify(await capture(await appFor("audience"), paths))).toContain("candidate beta");
		await getDbAccessor().withWriteTxAsync((db) =>
			db.exec("UPDATE entities SET mentions=999999 WHERE id='candidate-beta'"),
		);
		expect(await capture(app, paths)).toEqual(before);
		await getDbAccessor().withWriteTxAsync((db) =>
			db.exec("UPDATE memories SET compartment_id=NULL WHERE id='hidden-mention'"),
		);
		expect(JSON.stringify(await capture(app, paths))).toContain("candidate beta");
	});

	test("mixed-label community and mention aggregates ignore hidden members", async () => {
		getDbAccessor().withWriteTx((db) => {
			db.exec(
				"UPDATE entities SET community_id='public-community',mentions=1 WHERE id='public'; INSERT INTO memory_entity_mentions(memory_id,entity_id) VALUES('public-memory','public')",
			);
		});
		const app = await appFor();
		const paths = ["/api/knowledge/entities/public", "/api/knowledge/communities", "/api/knowledge/constellation"];
		const before = await capture(app, paths);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,community_id,created_at,updated_at,compartment_id) VALUES('hidden-member','Hidden','hidden','project','default','public-community',?,?,9)",
			).run(NOW, NOW);
			db.prepare(
				"INSERT INTO memories(id,agent_id,content,memory_kind,created_at,updated_at,compartment_id) VALUES('hidden-mention','default','hidden memory','episodic',?,?,9)",
			).run(NOW, NOW);
			db.exec(
				"INSERT INTO memory_entity_mentions(memory_id,entity_id) VALUES('hidden-mention','public'); UPDATE entities SET mentions=2 WHERE id='public'; UPDATE entity_communities SET member_count=2,cohesion=1 WHERE id='public-community'",
			);
		});
		expect(await capture(app, paths)).toEqual(before);
		const audience = await appFor("audience");
		const allowed = await capture(audience, paths);
		expect(JSON.stringify(allowed[0])).toContain('"mentions":2');
		expect(JSON.stringify(allowed[1])).toContain('"member_count":2');
	});

	test("hidden insertion, update and reclassification do not change public graph responses", async () => {
		const app = await appFor();
		const paths = [
			"/api/knowledge/entities?limit=1",
			"/api/knowledge/navigation/entities?limit=1",
			"/api/knowledge/navigation/entity?name=public%20needle",
			"/api/knowledge/navigation/tree?entity=public%20needle",
			"/api/knowledge/navigation/aspects?entity=public%20needle",
			"/api/knowledge/navigation/groups?entity=public%20needle&aspect=details",
			"/api/knowledge/navigation/claims?entity=public%20needle&aspect=details&group=general",
			"/api/knowledge/navigation/attributes?entity=public%20needle&aspect=details&group=general&claim=claim",
			"/api/knowledge/entities/public",
			"/api/knowledge/entities/public/aspects",
			"/api/knowledge/entities/public/dependencies",
			"/api/knowledge/stats",
			"/api/knowledge/hygiene",
			"/api/knowledge/entities/health",
			"/api/knowledge/traversal/status",
			"/api/knowledge/entities/public/aspects/public-aspect/attributes?limit=1",
			"/api/knowledge/communities",
			"/api/knowledge/entities/pinned",
			"/api/knowledge/constellation?max_attributes_per_aspect=1",
			"/api/ontology/proposals?limit=1",
			"/api/ontology/proposals/conflicts",
			"/api/ontology/proposals/public-proposal",
			"/api/ontology/proposals/public-proposal/evidence",
			"/api/ontology/assertions?limit=1",
			"/api/ontology/assertions/public-assertion",
			"/api/ontology/contradictions",
			"/api/ontology/entities/public/aliases",
			"/api/ontology/links/public-link/evidence",
			"/api/ontology/contradictions/public-contradiction",
			"/api/ontology/claims/evidence?entity=public%20needle&aspect=details&group=general&claim=claim",
			"/api/ontology/claims/explain?entity=public%20needle&aspect=details&group=general&claim=claim",
			"/api/ontology/claims/version?entity=public&aspect=public-aspect&group=general&claim=claim&version=1",
			"/api/ontology/claims/versions?entity=public&aspect=public-aspect&group=general&claim=claim",
		];
		const before = await capture(app, paths);
		seed(true);
		expect(await capture(app, paths)).toEqual(before);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE entities SET name='changed hidden needle',mentions=99999,updated_at='2099-01-01' WHERE id='hidden'",
			).run();
			db.prepare(
				"UPDATE ontology_proposals SET rationale='changed hidden',updated_at='2099-01-01' WHERE id='hidden-proposal'",
			).run();
			db.prepare(
				"INSERT INTO entity_attributes (id,aspect_id,agent_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,created_at,updated_at,compartment_id) VALUES ('hidden-child','public-aspect','default','attribute','hidden value','hidden value','general','claim',1,100,'active',?,?,9)",
			).run(NOW, NOW);
		});
		expect(await capture(app, paths)).toEqual(before);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entity_attributes SET compartment_id=9 WHERE id='public-attribute'").run();
		});
		const hidden = await app.request(
			"/api/ontology/claims/version?entity=public&aspect=public-aspect&group=general&claim=claim&version=1",
		);
		expect(hidden.status).toBe(404);
	});

	test("direct and group audiences read classified shards and organization reach spans agents", async () => {
		seed(true);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET pinned=0").run();
		});
		for (const user of ["audience", "group-reader"]) {
			const app = await appFor(user);
			const response = await app.request("/api/knowledge/entities");
			expect(await response.json()).toMatchObject({
				items: expect.arrayContaining([expect.objectContaining({ entity: expect.objectContaining({ id: "hidden" }) })]),
			});
			const scope = await resolveReadScope(
				{ reach: { kind: "all" }, projects: null },
				{ userId: user, groupIds: [], local: false },
			);
			const owner = await knowledgeReadOwner(await getDbOwner(getDbAccessorPath()), scope);
			const fts = await ownerReadAll<{ readonly id: string }>(
				owner,
				"SELECT e.id FROM entities_fts CROSS JOIN entities e ON e.rowid=entities_fts.rowid WHERE entities_fts MATCH ? AND e.agent_id=? ORDER BY rank LIMIT 20",
				["needle", "default"],
				{ operation: "test.knowledge.fts" },
			);
			expect(fts.map((row) => row.id)).toContain("hidden");
			const focal = await resolveFocalEntitiesViaOwner(owner, "default", { queryTokens: ["needle"] });
			expect(focal.entityIds).toContain("hidden");
		}
		const reader = await appFor("reader", "peer");
		expect(await (await reader.request("/api/knowledge/entities")).json()).toMatchObject({ items: [] });
		const restricted = await appFor("audience", "default", ["permitted-project"]);
		expect(await (await restricted.request("/api/knowledge/entities")).json()).toMatchObject({ items: [] });
	});

	test("expansion and impact use scoped rows before graph traversal and hydration", async () => {
		const app = await appFor();
		const queries = [
			{ path: "/api/knowledge/expand", body: { entity: "public needle", maxTokens: 1000 } },
			{ path: "/api/knowledge/expand/session", body: { entityName: "public needle" } },
			{ path: "/api/graph/impact", body: { entityId: "public" } },
		];
		const responses = async () =>
			Promise.all(
				queries.map(async ({ path, body }) => {
					const response = await app.request(path, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
					expect(response.status).toBe(200);
					return response.json();
				}),
			);
		const before = await responses();
		expect(before[0]).not.toHaveProperty("partial");
		expect(before[0]).toMatchObject({
			entity: { id: "public" },
			memoryCount: 1,
			memories: [{ id: "public-memory", content: "public memory evidence" }],
		});
		seed(true);
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO entity_attributes (id,aspect_id,agent_id,kind,content,normalized_content,group_key,claim_key,confidence,importance,status,created_at,updated_at,compartment_id) VALUES ('hidden-local','public-aspect','default','constraint','hidden constraint','hidden constraint','general','hidden',1,999,'active',?,?,9)",
			).run(NOW, NOW);
		});
		expect(await responses()).toEqual(before);
	});

	test("pending classification hides cited claims, assertions and proposal copies before batches", async () => {
		const reader = await appFor();
		const audience = await appFor("audience");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO evidence_citations (derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES ('proposal','public-proposal','default','attribute','public-attribute')",
			).run();
			db.prepare(
				"INSERT INTO org_jobs (id,kind,status,params_json,created_by,created_at) VALUES ('scope-job','classify','pending',?,'audience',?)",
			).run(
				JSON.stringify({ id: "cls_private", target: { kind: "memory", id: "public-memory", agentId: "default" } }),
				NOW,
			);
		});
		for (const path of ["/api/ontology/assertions/public-assertion", "/api/ontology/proposals/public-proposal"]) {
			expect((await reader.request(path)).status, path).toBe(404);
			expect((await audience.request(path)).status).toBe(200);
		}
		expect(
			await (
				await reader.request(
					"/api/ontology/claims/versions?entity=public&aspect=public-aspect&group=general&claim=claim",
				)
			).json(),
		).toMatchObject({ items: [], count: 0 });
	});

	test("FTS visibility follows reclassification and immediate group revocation", async () => {
		seed(true);
		const readIds = async (userId: string) => {
			const scope = await resolveReadScope(
				{ reach: { kind: "all" }, projects: null },
				{ userId, groupIds: [], local: false },
			);
			const owner = await knowledgeReadOwner(await getDbOwner(getDbAccessorPath()), scope);
			const rows = await ownerReadAll<{ readonly id: string }>(
				owner,
				"SELECT e.id FROM entities_fts CROSS JOIN entities e ON e.rowid=entities_fts.rowid WHERE entities_fts MATCH ? AND e.agent_id=? ORDER BY rank LIMIT 20",
				["needle", "default"],
				{ operation: "test.knowledge.fts-reclassification" },
			);
			return rows.map((row) => row.id);
		};
		const before = await readIds("reader");
		expect(before).toEqual(["public"]);
		expect(await readIds("group-reader")).toContain("hidden");
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"UPDATE entities SET name='hidden updated needle',canonical_name='hidden updated needle',mentions=999 WHERE id='hidden'",
			).run();
			db.prepare("DELETE FROM group_members WHERE group_id='grp_private' AND user_id='group-reader'").run();
		});
		expect(await readIds("reader")).toEqual(before);
		expect(await readIds("group-reader")).toEqual(before);
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id=NULL WHERE id='hidden'").run();
		});
		expect(await readIds("reader")).toContain("hidden");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE entities SET compartment_id=9 WHERE id='hidden'").run();
		});
		expect(await readIds("reader")).toEqual(before);
	});

	test("an unknown all-agent selector never becomes the default read scope", async () => {
		const app = await appFor();
		for (const path of ["/api/knowledge/entities?agent_id=all", "/api/ontology/proposals?agent_id=all"]) {
			expect((await app.request(path)).status, path).toBe(403);
		}
	});

	test("hidden ids have the same absent response across ontology and impact", async () => {
		const app = await appFor();
		const paths = [
			"/api/knowledge/entities/hidden",
			"/api/ontology/assertions/hidden-assertion",
			"/api/ontology/proposals/hidden-proposal",
			"/api/ontology/proposals/hidden-proposal/evidence",
			"/api/ontology/contradictions/hidden-contradiction",
			"/api/ontology/links/hidden-link/evidence",
			"/api/ontology/claims/evidence?entity=hidden%20needle&aspect=details&group=general&claim=claim",
			"/api/ontology/claims/explain?entity=hidden%20needle&aspect=details&group=general&claim=claim",
		];
		const absent = await Promise.all(
			paths.map(async (path) => {
				const r = await app.request(path);
				return [r.status, await r.text()];
			}),
		);
		const impact = async () => {
			const r = await app.request("/api/graph/impact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ entityId: "hidden" }),
			});
			return [r.status, await r.text()];
		};
		const absentImpact = await impact();
		seed(true);
		expect(
			await Promise.all(
				paths.map(async (path) => {
					const r = await app.request(path);
					return [r.status, await r.text()];
				}),
			),
		).toEqual(absent);
		expect(await impact()).toEqual(absentImpact);
	});
});

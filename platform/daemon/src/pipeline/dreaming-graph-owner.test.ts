import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { ReadScope } from "../read-scope";
import { searchEntitiesInDb, entityDetailInDb, aspectClaimsInDb, validateProposalInDb } from "../classification-owner";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const readScope: ReadScope = { reach: { kind: "own", agentId: "a" }, compartments: [], projects: null };
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(`
		CREATE TABLE entities(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER,name TEXT,canonical_name TEXT,entity_type TEXT,status TEXT,pinned INTEGER,pinned_at TEXT,mentions INTEGER,updated_at TEXT,description TEXT,created_at TEXT,source_id TEXT,proposal_evidence TEXT DEFAULT '[]');
		CREATE TABLE entity_aspects(id TEXT PRIMARY KEY,entity_id TEXT,agent_id TEXT,compartment_id INTEGER,name TEXT,status TEXT,weight REAL);
		CREATE TABLE entity_attributes(id TEXT PRIMARY KEY,aspect_id TEXT,agent_id TEXT,compartment_id INTEGER,kind TEXT,status TEXT,content TEXT,importance REAL,created_at TEXT,confidence REAL,source_id TEXT,source_kind TEXT,proposal_evidence TEXT);
		CREATE TABLE entity_dependencies(id TEXT PRIMARY KEY,source_entity_id TEXT,target_entity_id TEXT,aspect_id TEXT,agent_id TEXT,compartment_id INTEGER,status TEXT,strength REAL,updated_at TEXT,dependency_type TEXT,reason TEXT,created_at TEXT);
		CREATE TABLE ontology_contradictions(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER,entity_id TEXT,aspect_id TEXT,left_attribute_id TEXT,right_attribute_id TEXT,status TEXT,updated_at TEXT,left_content TEXT,right_content TEXT,reason TEXT);
		INSERT INTO entities(id,agent_id,compartment_id,name,canonical_name,entity_type,status,pinned,pinned_at,mentions,updated_at,description,created_at,source_id) VALUES('visible','a',NULL,'Alpha','alpha','project','active',0,NULL,1,'now',NULL,'now',NULL),('peer','a',NULL,'Beta','beta','project','active',0,NULL,0,'now',NULL,'now',NULL);
		INSERT INTO entity_aspects VALUES('aspect','visible','a',NULL,'State','active',1);
		INSERT INTO entity_attributes VALUES('claim','aspect','a',NULL,'attribute','active','The project is enabled',1,'now',1,'memory:visible','memory','[]');
		INSERT INTO entity_dependencies VALUES('link','visible','peer',NULL,'a',NULL,'active',1,'now','related',NULL,'now');
	`);
	return db;
}
function hiddenRows(db: Database) {
	db.exec(`
		INSERT INTO entities(id,agent_id,compartment_id,name,canonical_name,entity_type,status,pinned,pinned_at,mentions,updated_at,description,created_at,source_id) VALUES('hidden','a',1,'Alpha','alpha','project','active',1,'now',100,'now',NULL,'now',NULL),('other','b',NULL,'Alpha','alpha','project','active',1,'now',100,'now',NULL,'now',NULL);
		INSERT INTO entity_aspects VALUES('hidden-aspect','visible','a',1,'Secret','active',100);
		INSERT INTO entity_attributes VALUES('hidden-claim','aspect','a',1,'attribute','active','The project is disabled',100,'now',1,'secret','memory','[]'),('nested-claim','hidden-aspect','a',NULL,'constraint','active','secret constraint',100,'now',1,'secret','memory','[]');
		INSERT INTO entity_dependencies VALUES('hidden-link','visible','hidden',NULL,'a',NULL,'active',100,'now','related','secret','now'),('hidden-aspect-link','visible','peer','hidden-aspect','a',NULL,'active',100,'now','related','secret','now');
		INSERT INTO ontology_contradictions VALUES('hidden-contradiction','a',NULL,'visible','aspect','claim','hidden-claim','active','now','public','secret','secret');
	`);
}
function snapshot(db: Database) {
	const input = { agentId: "a", readScope };
	return {
		search: searchEntitiesInDb(db, { ...input, limit: 1 }),
		detail: entityDetailInDb(db, { ...input, entityId: "visible", include: ["aspects", "links"], limit: 1 }),
		claims: aspectClaimsInDb(db, {
			...input,
			entityId: "visible",
			aspectId: "aspect",
			include: ["contradictions"],
			limit: 1,
		}),
		proposal: validateProposalInDb(db, {
			...input,
			name: "Alpha",
			entityId: "visible",
			aspectId: "aspect",
			value: "The project is disabled",
		}),
	};
}
describe("Dreaming graph model inputs", () => {
	it("keeps pages, nested counts, endpoints, contradictions and duplicates identical when hidden rows are added", () => {
		const db = fixture();
		const before = snapshot(db);
		expect(before.search).toMatchObject({
			ok: true,
			items: [{ id: "visible", aspectCount: 1, attributeCount: 1, dependencyCount: 1 }],
		});
		expect(before.detail).toMatchObject({ ok: true, aspects: [{ id: "aspect" }], links: [{ id: "link" }] });
		expect(before.claims).toMatchObject({ ok: true, items: [{ id: "claim" }] });
		hiddenRows(db);
		expect(snapshot(db)).toEqual(before);
	});
	it("treats hidden entities and aspects as absent and denies project restricted graph reads", () => {
		const db = fixture();
		hiddenRows(db);
		const input = { agentId: "a", readScope };
		expect(entityDetailInDb(db, { ...input, entityId: "hidden" })).toEqual(
			entityDetailInDb(db, { ...input, entityId: "missing" }),
		);
		expect(aspectClaimsInDb(db, { ...input, entityId: "visible", aspectId: "hidden-aspect" })).toEqual(
			aspectClaimsInDb(db, { ...input, entityId: "visible", aspectId: "missing" }),
		);
		expect(searchEntitiesInDb(db, { ...input, readScope: { ...readScope, projects: ["project"] } })).toEqual({
			ok: true,
			items: [],
		});
	});
	it("applies readable subset labels to every nested table", () => {
		const db = fixture();
		hiddenRows(db);
		const scope = { ...readScope, compartments: [1] };
		expect(searchEntitiesInDb(db, { agentId: "a", readScope: scope, limit: 1 })).toMatchObject({
			items: [{ id: "hidden" }],
		});
		expect(
			aspectClaimsInDb(db, {
				agentId: "a",
				readScope: scope,
				entityId: "visible",
				aspectId: "aspect",
				limit: 1,
				include: ["contradictions"],
			}),
		).toMatchObject({
			items: [{ id: "hidden-claim" }],
			contradictions: { count: 1, items: [{ id: "hidden-contradiction" }] },
		});
	});
});

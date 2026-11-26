import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { readScopeSql } from "../read-scope";
import {
	dreamingPassPartitionInDb,
	dreamingReadScopeInDb,
	assertDreamingMutationLabelInDb,
} from "../classification-owner";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	runMigrations(db);
	db.exec(`
		INSERT INTO classifications(id,name) VALUES('a','A'),('b','B'),('c','C');
		INSERT INTO compartments(id,key) VALUES(1,'a'),(2,'b'),(3,'a,b'),(4,'c');
		INSERT INTO compartment_members VALUES(1,'a'),(2,'b'),(3,'a'),(3,'b'),(4,'c');
		INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES('shared','Shared','organization','now','now'),('other','Other','personal','now','now');
		INSERT INTO entities(id,name,entity_type,created_at,updated_at,agent_id,compartment_id)
		VALUES('public','Public','concept','now','now','shared',NULL),('a','A','concept','now','now','shared',1),('b','B','concept','now','now','shared',2),('ab','AB','concept','now','now','shared',3),('c','C','concept','now','now','shared',4),('other','Other','concept','now','now','other',NULL);
		INSERT INTO dreaming_passes(id,agent_id,compartment_id,status,scope_key) VALUES('pass','shared',3,'running','shared');
	`);
	return db;
}

describe("Dreaming derivation partition", () => {
	it("reads only the same agent and classification subsets before paging", () => {
		const db = fixture();
		const scope = dreamingReadScopeInDb(db, "shared", 3);
		const clause = readScopeSql("e", scope, { visibility: null });
		expect(
			db.prepare(`SELECT id FROM entities e WHERE 1=1 ${clause.sql} ORDER BY id LIMIT 10`).all(...clause.args),
		).toEqual([{ id: "a" }, { id: "ab" }, { id: "b" }, { id: "public" }]);
		const unclassified = readScopeSql("e", dreamingReadScopeInDb(db, "shared", null), { visibility: null });
		expect(db.prepare(`SELECT id FROM entities e WHERE 1=1 ${unclassified.sql}`).all(...unclassified.args)).toEqual([
			{ id: "public" },
		]);
	});
	it("rejects cross-label and cross-agent mutations", () => {
		const db = fixture();
		const partition = dreamingPassPartitionInDb(db, "pass", "shared");
		expect(partition).toEqual({ agentId: "shared", compartmentId: 3 });
		assertDreamingMutationLabelInDb(db, "entities", "ab", partition);
		for (const id of ["public", "a", "b", "c", "other"])
			expect(() => assertDreamingMutationLabelInDb(db, "entities", id, partition)).toThrow("compartment_mismatch");
		expect(() => dreamingPassPartitionInDb(db, "pass", "other")).toThrow();
	});
	it("invalidates a pass after a classification transition", () => {
		const db = fixture();
		db.exec(
			"INSERT INTO classification_assignments(target_kind,target_id,agent_id,classification_id) VALUES('agent','shared','shared','a')",
		);
		expect(() => dreamingPassPartitionInDb(db, "pass", "shared")).toThrow("compartment_mismatch");
	});
	it("blocks admission while classification labels are still moving", () => {
		const db = fixture();
		db.exec(
			"INSERT INTO org_jobs(id,kind,status,params_json,created_at) VALUES('job','classify','running','{\"target\":{\"agentId\":\"shared\"}}','now')",
		);
		expect(() => dreamingPassPartitionInDb(db, "pass", "shared")).toThrow("compartment_mismatch");
		db.exec("UPDATE org_jobs SET status='complete'");
		expect(dreamingPassPartitionInDb(db, "pass", "shared").compartmentId).toBe(3);
	});

	it("excludes the organization aggregator only in personal mode", () => {
		const db = fixture();
		db.exec("UPDATE organization SET claimed_at='2026-11-25',agent_model='personal' WHERE id=1");
		expect(() => dreamingPassPartitionInDb(db, "pass", "shared")).toThrow("org_policy");
		db.exec("UPDATE organization SET agent_model='single'");
		expect(dreamingPassPartitionInDb(db, "pass", "shared").agentId).toBe("shared");
	});
});

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readScopeSql } from "../read-scope";
import { dreamingPassPartitionInDb, dreamingReadScopeInDb, assertDreamingMutationLabelInDb } from "../classification-owner";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	db.exec(`
		CREATE TABLE compartments(id INTEGER PRIMARY KEY);
		CREATE TABLE compartment_members(compartment_id INTEGER, classification_id TEXT);
		INSERT INTO compartments VALUES(1),(2),(3),(4);
		INSERT INTO compartment_members VALUES(1,'a'),(2,'b'),(3,'a'),(3,'b'),(4,'c');
		CREATE TABLE entities(id TEXT PRIMARY KEY,agent_id TEXT,compartment_id INTEGER);
		INSERT INTO entities VALUES('public','shared',NULL),('a','shared',1),('b','shared',2),('ab','shared',3),('c','shared',4),('other','other',NULL);
		CREATE TABLE organization(id INTEGER,claimed_at TEXT,agent_model TEXT);
		CREATE TABLE org_jobs(kind TEXT,status TEXT);
		CREATE TABLE agents(id TEXT,kind TEXT,archived_at TEXT);
		INSERT INTO agents VALUES('shared','organization',NULL),('other','personal',NULL);
		CREATE TABLE dreaming_classification_epoch(id INTEGER PRIMARY KEY,epoch INTEGER);
		INSERT INTO dreaming_classification_epoch VALUES(1,7);
		CREATE TABLE dreaming_passes(id TEXT,agent_id TEXT,compartment_id INTEGER,status TEXT,scope_key TEXT,classification_epoch INTEGER);
		INSERT INTO dreaming_passes VALUES('pass','shared',3,'running','shared',7);
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
		db.exec("UPDATE dreaming_classification_epoch SET epoch=8");
		expect(() => dreamingPassPartitionInDb(db, "pass", "shared")).toThrow("compartment_mismatch");
	});
	it("blocks admission while classification labels are still moving", () => {
		const db = fixture();
		db.exec("INSERT INTO org_jobs VALUES('classify','running')");
		expect(() => dreamingPassPartitionInDb(db, "pass", "shared")).toThrow("compartment_mismatch");
		db.exec("UPDATE org_jobs SET status='complete'");
		expect(dreamingPassPartitionInDb(db, "pass", "shared").compartmentId).toBe(3);
	});

	it("excludes the organization aggregator only in personal mode", () => {
		const db = fixture();
		db.exec("INSERT INTO organization VALUES(1,'2026-11-25','personal')");
		expect(() => dreamingPassPartitionInDb(db, "pass", "shared")).toThrow("org_policy");
		db.exec("UPDATE organization SET agent_model='single'");
		expect(dreamingPassPartitionInDb(db, "pass", "shared").agentId).toBe("shared");
	});
});

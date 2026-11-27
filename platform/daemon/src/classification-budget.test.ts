import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient } from "./db-owner-client";
import { executeClassificationJob, type ClassificationRequest } from "./classifications";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { executeClassification } from "./classification-owner";
import { readScopeSql } from "./read-scope";

test("classification yields after its time budget before starting another closure", () => {
	const db = currentClassificationFixture();
	try {
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'); INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES('second','secret','default','now','now')",
		);
		db.exec(
			"CREATE TRIGGER slow_move AFTER UPDATE OF compartment_id ON memories BEGIN SELECT sum(x) FROM (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<600000) SELECT x FROM n); END",
		);
		const value = executeClassification(db, {
			op: "enqueue",
			id: "cls_hr",
			actor,
			target: { kind: "agent", id: "default", agentId: "default" },
			remove: false,
		});
		if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string")
			throw new Error("missing job");
		executeClassification(db, { op: "execute", jobId: value.jobId });
		expect(db.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NOT NULL").get()).toEqual({ n: 1 });
		expect(db.prepare("SELECT status FROM org_jobs WHERE id=?").get(value.jobId)).toEqual({ status: "running" });
	} finally {
		db.close();
	}
});

const actor = {
	userId: "carol",
	groupIds: [],
	local: false,
	compliance: true,
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:test",
};

test("classification bounds expanded rows per owner turn and keeps readers fenced", () => {
	const db = currentClassificationFixture();
	try {
		db.exec(`INSERT INTO classifications(id,name) VALUES('cls_hr','HR');
		WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<512)
		INSERT INTO memories(id,content,agent_id,created_at,updated_at) SELECT 'budget-'||x,'secret','default','now','now' FROM n;
		WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10240)
		INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) SELECT 'derived-'||x,'D'||x,'d'||x,'concept','default','now','now' FROM n;
		INSERT INTO evidence_citations SELECT 'entity',id,'default','memory','budget-'||((rowid-2)%512+1) FROM entities WHERE id LIKE 'derived-%';`);
		const queued = executeClassification(db, {
			op: "enqueue",
			id: "cls_hr",
			actor,
			target: { kind: "agent", id: "default", agentId: "default" },
			remove: false,
		});
		if (typeof queued !== "object" || queued === null || !("jobId" in queued) || typeof queued.jobId !== "string")
			throw new Error("missing job");
		const scope = readScopeSql("m", {
			reach: { kind: "all" },
			compartments: [],
			projects: null,
			inFlightUserId: "bob",
		});
		let previous = 0;
		let turns = 0;
		for (; turns < 20000; turns++) {
			expect(db.prepare(`SELECT count(*) n FROM memories m WHERE 1=1 ${scope.sql}`).get(...scope.args)).toEqual({
				n: 0,
			});
			executeClassification(db, { op: "execute", jobId: queued.jobId });
			const moved = db
				.prepare(
					"SELECT (SELECT count(*) FROM memories WHERE compartment_id IS NOT NULL)+(SELECT count(*) FROM entities WHERE compartment_id IS NOT NULL) n",
				)
				.get();
			if (typeof moved?.n !== "number") throw new Error("missing count");
			expect(moved.n - previous).toBeLessThanOrEqual(1024);
			previous = moved.n;
			if (db.prepare("SELECT status FROM org_jobs WHERE id=?").get(queued.jobId)?.status === "complete") break;
		}
		expect(turns).toBeLessThan(20000);
		expect(previous).toBe(10754);
		expect(db.prepare("SELECT count(*) n FROM entities WHERE compartment_id IS NULL").get()).toEqual({ n: 0 });
	} finally {
		db.close();
	}
}, 120000);

test("agent apply preserves classifications inherited before the job", () => {
	const db = currentClassificationFixture();
	try {
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_hr','HR'),('cls_legal','Legal'); INSERT INTO classification_assignments VALUES('memory','m','default','cls_legal','carol','now')",
		);
		executeClassification(db, { op: "rebuild", agentId: "default" });
		const queued = executeClassification(db, {
			op: "enqueue",
			id: "cls_hr",
			actor,
			target: { kind: "agent", id: "default", agentId: "default" },
			remove: false,
		});
		if (typeof queued !== "object" || queued === null || !("jobId" in queued) || typeof queued.jobId !== "string")
			throw new Error("missing job");
		while (db.prepare("SELECT status FROM org_jobs WHERE id=?").get(queued.jobId)?.status !== "complete")
			executeClassification(db, { op: "execute", jobId: queued.jobId });
		for (const table of ["memories", "entities"])
			expect(
				db
					.prepare(
						`SELECT cm.classification_id FROM ${table} r JOIN compartment_members cm ON cm.compartment_id=r.compartment_id ORDER BY cm.classification_id`,
					)
					.all(),
			).toEqual([{ classification_id: "cls_hr" }, { classification_id: "cls_legal" }]);
	} finally {
		db.close();
	}
});

test("agent apply promotes an oversized evidence closure through the agent fence", () => {
	const db = currentClassificationFixture();
	try {
		db.exec(`INSERT INTO classifications(id,name) VALUES('cls_hr','HR');
		WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200)
		INSERT INTO entities(id,name,canonical_name,entity_type,agent_id,created_at,updated_at) SELECT 'wide-'||x,'W'||x,'w'||x,'concept','default','now','now' FROM n;
		INSERT INTO evidence_citations SELECT 'entity',id,'default','memory','m' FROM entities WHERE id LIKE 'wide-%';`);
		const total = db.prepare("SELECT (SELECT count(*) FROM entities)+(SELECT count(*) FROM memories) n").get();
		const queued = executeClassification(db, {
			op: "enqueue",
			id: "cls_hr",
			actor,
			target: { kind: "agent", id: "default", agentId: "default" },
			remove: false,
		});
		if (typeof queued !== "object" || queued === null || !("jobId" in queued) || typeof queued.jobId !== "string")
			throw new Error("missing job");
		let previous = 0;
		while (db.prepare("SELECT status FROM org_jobs WHERE id=?").get(queued.jobId)?.status !== "complete") {
			executeClassification(db, { op: "execute", jobId: queued.jobId });
			const row = db
				.prepare(
					"SELECT (SELECT count(*) FROM entities WHERE compartment_id IS NOT NULL)+(SELECT count(*) FROM memories WHERE compartment_id IS NOT NULL) n",
				)
				.get();
			if (typeof row?.n !== "number") throw new Error("missing count");
			expect(row.n - previous).toBeLessThanOrEqual(1024);
			previous = row.n;
		}
		expect(previous).toBe(total?.n);
	} finally {
		db.close();
	}
});

test("a polling reader never observes unlabelled classified content between owner turns", async () => {
	const directory = mkdtempSync(join(tmpdir(), "classification-reader-"));
	const path = join(directory, "signet.db");
	const db = currentClassificationFixture();
	db.exec(`INSERT INTO classifications(id,name) VALUES('cls_hr','HR');
		WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000)
		INSERT INTO memories(id,content,agent_id,created_at,updated_at) SELECT 'poll-'||x,'secret','default','now','now' FROM n;`);
	const value = executeClassification(db, {
		op: "enqueue",
		id: "cls_hr",
		actor,
		target: { kind: "agent", id: "default", agentId: "default" },
		remove: false,
	});
	if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string")
		throw new Error("missing job");
	db.prepare("VACUUM INTO ?").run(path);
	db.close();
	const owner = createDbOwnerClient({ dbPath: path });
	const setup = new Database(path);
	setup.exec("PRAGMA journal_mode=WAL");
	setup.close();
	const reader = new Database(path, { readonly: true });
	const scope = readScopeSql("m", { reach: { kind: "all" }, compartments: [], projects: null, inFlightUserId: "bob" });
	const poll = reader.prepare(`SELECT count(*) n FROM memories m WHERE 1=1 ${scope.sql}`);
	const request = (request: ClassificationRequest) =>
		owner.submit(
			{ kind: "classification", request },
			{
				operation: `classification.${request.op}`,
				lane: "maintenance",
				workloadClass: "maintenance",
				deadlineMs: 5000,
			},
		).result;
	let completed = false;
	let samples = 0;
	try {
		await owner.start();
		const job = executeClassificationJob(value.jobId, request).finally(() => {
			completed = true;
		});
		while (!completed) {
			expect(poll.get(...scope.args)).toEqual({ n: 0 });
			expect(
				await owner.submit(
					{ kind: "query", statement: { sql: "SELECT 1 ok", result: "get", readonly: true } },
					{ operation: "organization.read", lane: "read", deadlineMs: 250 },
				).result,
			).toEqual({ ok: 1 });
			samples++;
			await Bun.sleep(1);
		}
		await job;
		expect(samples).toBeGreaterThan(5);
		expect(poll.get(...scope.args)).toEqual({ n: 0 });
		expect(reader.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NOT NULL").get()).toEqual({
			n: 3001,
		});
		expect(reader.prepare("SELECT status FROM org_jobs WHERE id=?").get(value.jobId)).toEqual({ status: "complete" });
	} finally {
		reader.close();
		await owner.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 30000);

import { expect, test } from "bun:test";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { executeClassification } from "./classification-owner";
import type { ClassificationActor } from "./classifications";
const actor: ClassificationActor = {
	userId: "carol",
	local: false,
	compliance: true,
	groupIds: [],
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:test",
};
function fixture(count: number) {
	const db = currentClassificationFixture();
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_hr','HR');WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<" +
			count +
			") INSERT INTO memories(id,content,agent_id,created_at,updated_at) SELECT 'batch-'||printf('%06d',x),'secret','default','now','now' FROM n",
	);
	return db;
}
function enqueue(db: ReturnType<typeof fixture>) {
	const value = executeClassification(db, {
		op: "enqueue",
		id: "cls_hr",
		actor,
		target: { kind: "agent", id: "default", agentId: "default" },
		remove: false,
	});
	if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string")
		throw new Error("job missing");
	return value.jobId;
}
function state(db: ReturnType<typeof fixture>, jobId: string) {
	return db.prepare("SELECT status,progress_json FROM org_jobs WHERE id=?").get(jobId);
}
test("classification batches persist cursors, queue per agent and resume rather than fail recovery", () => {
	const db = fixture(2011),
		jobId = enqueue(db),
		queued = enqueue(db);
	executeClassification(db, { op: "execute", jobId });
	expect(state(db, jobId)?.status).toBe("running");
	expect(() => db.prepare("UPDATE memories SET updated_at='later' WHERE id='batch-002011'").run()).not.toThrow();
	const first = db.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NOT NULL").get();
	expect(first?.n).toBeGreaterThan(0);
	expect(first?.n).toBeLessThanOrEqual(1024);
	executeClassification(db, { op: "execute", jobId: queued });
	expect(state(db, queued)?.status).toBe("pending");
	const cursor = state(db, jobId)?.progress_json;
	executeClassification(db, { op: "recover" });
	expect(state(db, jobId)).toMatchObject({ status: "running", progress_json: cursor });
	while (state(db, jobId)?.status !== "complete") executeClassification(db, { op: "execute", jobId });
	expect(state(db, jobId)?.status).toBe("complete");
	expect(db.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NULL").get()).toEqual({ n: 0 });
	expect(db.prepare("SELECT count(*) n FROM audit_events WHERE action='classification.apply'").get()).toEqual({ n: 1 });
	db.close();
});
test("classification has no corpus row admission ceiling", () => {
	const db = fixture(100001);
	const jobId = enqueue(db);
	while (state(db, jobId)?.status !== "complete") executeClassification(db, { op: "execute", jobId });
	expect(state(db, jobId)?.status).toBe("complete");
	expect(db.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NULL").get()).toEqual({ n: 0 });
	db.close();
}, 120000);
test("a failed batch rolls back its row moves and cursor without undoing committed batches", async () => {
	const db = fixture(2011),
		jobId = enqueue(db);
	executeClassification(db, { op: "execute", jobId });
	const before = state(db, jobId)?.progress_json;
	const beforeRows = db.prepare("SELECT id,compartment_id FROM memories ORDER BY id").all();
	db.exec(
		"CREATE TRIGGER crash_batch BEFORE UPDATE OF compartment_id ON memories WHEN new.id=(SELECT id FROM memories WHERE compartment_id IS NULL ORDER BY rowid LIMIT 1) BEGIN SELECT RAISE(ABORT,'crash batch');END",
	);
	expect(() => executeClassification(db, { op: "execute", jobId })).toThrow("crash batch");
	expect(db.prepare("SELECT id,compartment_id FROM memories ORDER BY id").all()).toEqual(beforeRows);
	expect(state(db, jobId)).toMatchObject({ status: "running", progress_json: before });
	executeClassification(db, { op: "record-error", jobId, error: "crash batch" });
	expect(db.prepare("SELECT error FROM org_jobs WHERE id=?").get(jobId)?.error).toContain("crash batch");
	expect(state(db, jobId)).toMatchObject({ status: "running" });
	const first = db.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NOT NULL").get();
	expect(first?.n).toBeGreaterThan(0);
	expect(first?.n).toBeLessThanOrEqual(1024);
	db.exec("DROP TRIGGER crash_batch");
	while (state(db, jobId)?.status !== "complete") executeClassification(db, { op: "execute", jobId });
	expect(state(db, jobId)?.status).toBe("complete");
	db.close();
});

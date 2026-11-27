import * as recovery from "./startup-recovery";
import { readScopeSql, readVisibilitySchema } from "./read-scope";
import { expect, test, spyOn } from "bun:test";
import { currentClassificationFixture } from "./test-support/classification-fixture.test";
import { executeClassification } from "./classification-owner";
import { resumeClassificationJobs, executeClassificationJob } from "./classifications";
import type { ClassificationActor, ClassificationRequest } from "./classifications";
const actor: ClassificationActor = {
	userId: "carol",
	local: false,
	groupIds: [],
	compliance: true,
	boundAgentId: null,
	allowedProjects: null,
	credential: "session:test",
};
function job(db: ReturnType<typeof currentClassificationFixture>, kind: "agent" | "memory") {
	const value = executeClassification(db, {
		op: "enqueue",
		actor,
		id: "cls_hr",
		target: { kind, id: kind === "agent" ? "default" : "m", agentId: "default" },
		remove: false,
	});
	if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string")
		throw new Error("missing job");
	return value.jobId;
}
test("five consecutive batch failures are terminal, audited, and release the agent queue", async () => {
	const db = currentClassificationFixture();
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_hr','HR');WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2011) INSERT INTO memories(id,content,agent_id,created_at,updated_at) SELECT 'batch-'||printf('%06d',x),'secret','default','now','now' FROM n",
	);
	const first = job(db, "agent");
	executeClassification(db, { op: "execute", jobId: first });
	const next = job(db, "memory");
	db.exec(
		"CREATE TRIGGER fail_batch BEFORE UPDATE OF compartment_id ON memories WHEN new.id='batch-002005' BEGIN SELECT RAISE(ABORT,'broken batch');END",
	);
	let failures = 0;
	const request = async (request: ClassificationRequest) => {
		if (request.op === "execute" && request.jobId === first) failures++;
		return executeClassification(db, request);
	};
	await expect(executeClassificationJob(first, request)).rejects.toThrow("broken batch");
	expect(failures).toBe(5);
	expect(db.prepare("SELECT status,error FROM org_jobs WHERE id=?").get(first)).toEqual({
		status: "failed",
		error: "broken batch",
	});
	expect(db.prepare("SELECT outcome FROM audit_events WHERE action='classification.failed'").all()).toEqual([
		{ outcome: "failed" },
	]);
	expect(db.prepare("SELECT json_extract(progress_json,'$.failures') n FROM org_jobs WHERE id=?").get(first)).toEqual({
		n: 5,
	});
	const scope = {
		reach: { kind: "all" as const },
		projects: null,
		...readVisibilitySchema.parse(
			executeClassification(db, { op: "visibility", subject: { userId: "bob", local: false, groupIds: [] } }),
		),
	};
	const hidden = readScopeSql("m", scope);
	expect(db.prepare(`SELECT count(*) n FROM memories m WHERE 1=1 ${hidden.sql}`).get(...hidden.args)).toEqual({ n: 0 });
	await executeClassificationJob(next, request);
	expect(db.prepare("SELECT status FROM org_jobs WHERE id=?").get(next)).toEqual({ status: "complete" });
	db.close();
});
test("recovery settles a failed job and continues the rest of its page", async () => {
	const completed: string[] = [];
	await expect(
		resumeClassificationJobs(async (request) => {
			if (request.op === "recover") return { jobs: ["broken", "two", "three", "four", "five"], nextCursor: null };
			if (request.op === "record-error") return { status: "failed", failures: 5 };
			if (request.op === "execute") {
				if (request.jobId === "broken") throw new Error("broken recovery");
				completed.push(request.jobId);
				return { status: "complete" };
			}
			throw new Error("unexpected operation");
		}),
	).resolves.toBeUndefined();
	expect(completed).toEqual(["two", "three", "four", "five"]);
});
test("startup recovery observers consume callback rejections", async () => {
	let observed = false;
	await expect(
		recovery.observeStartupRecoveryCompletion(() => {
			observed = true;
			throw new Error("observer failure");
		}),
	).resolves.toBeUndefined();
	expect(observed).toBe(true);
});
test("pending polling has a finite request budget", async () => {
	const original = setTimeout,
		delays: number[] = [];
	const timer = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
		delays.push(delay ?? 0);
		return original(callback, 0, ...args);
	});
	let calls = 0;
	try {
		await expect(
			executeClassificationJob("waiting", async (request) => {
				if (request.op === "record-error") return { status: "pending", failures: 0 };
				calls++;
				if (calls > 60) throw new Error("poll budget not enforced");
				return { status: "pending" };
			}),
		).rejects.toThrow("classification_pending_timeout");
		expect(calls).toBe(60);
		expect(delays[0]).toBe(100);
		expect(Math.max(...delays)).toBe(5000);
	} finally {
		timer.mockRestore();
	}
});
test("pending job polling backs off rather than spinning every fifty milliseconds", async () => {
	const arrivals: number[] = [];
	await executeClassificationJob("waiting", async () => {
		arrivals.push(performance.now());
		return { status: arrivals.length < 4 ? "pending" : "complete" };
	});
	expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(90);
	expect(arrivals[2] - arrivals[1]).toBeGreaterThanOrEqual(180);
	expect(arrivals[3] - arrivals[2]).toBeGreaterThanOrEqual(360);
});

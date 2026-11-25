import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { createDbOwnerClient } from "./db-owner-client";
import { runStartupRecoveryAsync } from "./startup-recovery";
import type { DbAccessor } from "./db-accessor";
import type { ClassificationRequest } from "./classifications";

test("a fresh DB owner resumes the durable cursor while foreground reads interleave", async () => {
	const directory = mkdtempSync(join(tmpdir(), "classification-resume-")),
		path = join(directory, "memory.db"),
		db = classificationFixture();
	db.exec(
		"INSERT INTO classifications(id,name) VALUES('cls_hr','HR');WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<6001) INSERT INTO memories(id,content,agent_id,created_at,updated_at) SELECT 'batch-'||x,'secret','default','now','now' FROM n",
	);
	db.prepare("VACUUM INTO ?").run(path);
	db.close();
	const first = createDbOwnerClient({ dbPath: path }),
		second = createDbOwnerClient({ dbPath: path });
	const request = (owner: typeof first) => (request: ClassificationRequest) =>
		owner.submit(
			{ kind: "classification", request },
			{
				operation: `test.resume.${request.op}`,
				lane: request.op === "readable" ? "read" : "maintenance",
				workloadClass: request.op === "readable" ? "foreground" : "maintenance",
				deadlineMs: 30000,
				estimatedWorkUnits: 2000,
			},
		).result;
	const query = (owner: typeof first) =>
		owner.submit(
			{
				kind: "query",
				statement: {
					sql: "SELECT status,(SELECT count(*) FROM memories WHERE compartment_id IS NULL) remaining FROM org_jobs LIMIT 1",
					result: "get",
					readonly: true,
				},
			},
			{ operation: "test.foreground-state", lane: "read", workloadClass: "foreground", deadlineMs: 5000 },
		).result;
	try {
		await first.start();
		const enqueue = await request(first)({
			op: "enqueue",
			id: "cls_hr",
			actor: {
				userId: "carol",
				groupIds: [],
				local: false,
				compliance: true,
				boundAgentId: null,
				allowedProjects: null,
				credential: "session:test",
			},
			target: { kind: "agent", id: "default", agentId: "default" },
			remove: false,
		});
		if (typeof enqueue !== "object" || enqueue === null || !("jobId" in enqueue) || typeof enqueue.jobId !== "string")
			throw new Error("missing job");
		await request(first)({ op: "execute", jobId: enqueue.jobId });
		expect(await query(first)).toMatchObject({ status: "running" });
		await first.close();
		await second.start();
		const observations: unknown[] = [];
		let active = true;
		const foreground = (async () => {
			while (active) {
				observations.push(await query(second));
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
			}
		})();
		try {
			const unavailable = () => {
				throw new Error("startup recovery must use its supplied DB owner");
			};
			const accessor: DbAccessor = {
				withReadDbAsync: unavailable,
				withWriteTxAsync: unavailable,
				withWriteDbAsync: unavailable,
				close: unavailable,
			};
			await runStartupRecoveryAsync(accessor, { owner: second });
		} finally {
			active = false;
			await foreground;
		}
		expect(
			observations.some(
				(value) => typeof value === "object" && value !== null && "status" in value && value.status === "running",
			),
		).toBe(true);
		expect(await query(second)).toEqual({ status: "complete", remaining: 0 });
	} finally {
		await first.close();
		await second.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 60000);

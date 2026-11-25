import { expect, test } from "bun:test";
import { classificationFixture } from "./test-support/classification-fixture.test";
import { executeClassification } from "./classification-owner";
import { readScopeSql, readVisibilitySchema, resolveReadScope, type ReadScope } from "./read-scope";
import type { ClassificationTarget } from "./classifications";

for (const kind of ["agent", "memory", "session", "source"] as const) {
	test(`in-flight ${kind} classification hides content before its first batch`, () => {
		const db = classificationFixture();
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_hr','HR');INSERT INTO classification_audience VALUES('cls_hr','user','alice');UPDATE memories SET source_id='session:s' WHERE id='m';INSERT INTO memories(id,content,agent_id,source_id,created_at,updated_at) VALUES('public','public','default','other','now','now');",
		);
		if (kind === "source") db.exec("UPDATE memories SET source_id='src' WHERE id='m'");
		db.exec(
			"INSERT INTO session_transcripts(session_key,content,agent_id,source_id,created_at) VALUES('s','session evidence','default','src','now')",
		);
		const target: ClassificationTarget = {
			kind,
			id: kind === "agent" ? "default" : kind === "memory" ? "m" : kind === "session" ? "s" : "src",
			agentId: "default",
		};
		const value = executeClassification(db, {
			op: "enqueue",
			id: "cls_hr",
			target,
			remove: false,
			actor: {
				userId: "carol",
				local: false,
				groupIds: [],
				compliance: true,
				boundAgentId: null,
				allowedProjects: null,
				credential: "session:test",
			},
		});
		if (typeof value !== "object" || value === null || !("jobId" in value) || typeof value.jobId !== "string")
			throw new Error("missing job");
		const jobId = value.jobId;
		const query = (userId: string) => {
			const scope: ReadScope = {
				reach: { kind: "all" },
				projects: null,
				...readVisibilitySchema.parse(
					executeClassification(db, { op: "visibility", subject: { userId, local: false, groupIds: [] } }),
				),
			};
			const predicate = readScopeSql("m", scope);
			return db.prepare(`SELECT id FROM memories m WHERE 1=1 ${predicate.sql} ORDER BY id`).all(...predicate.args);
		};
		expect(query("bob")).toEqual(kind === "agent" ? [] : [{ id: "public" }]);
		db.exec(
			"CREATE TRIGGER pause_batch BEFORE UPDATE OF compartment_id ON memories BEGIN SELECT RAISE(ABORT,'pause batch');END",
		);
		expect(() => executeClassification(db, { op: "execute", jobId })).toThrow("pause batch");
		expect(db.prepare("SELECT status FROM org_jobs").get()).toEqual({ status: "running" });
		expect(db.prepare("SELECT count(*) n FROM memories WHERE compartment_id IS NOT NULL").get()).toEqual({ n: 0 });
		expect(query("bob")).toEqual(kind === "agent" ? [] : [{ id: "public" }]);
		expect(query("alice")).toEqual([{ id: "m" }, { id: "public" }]);
		db.close();
	});
}
test("an empty in-flight scope preserves SQL and EXPLAIN QUERY PLAN", async () => {
	const db = classificationFixture();
	const scope: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
	const before: ReturnType<typeof readScopeSql> = {
		sql: " AND m.agent_id IN (SELECT id FROM agents WHERE archived_at IS NULL) AND m.visibility != 'archived' AND m.compartment_id IS NULL",
		args: [],
	};
	const resolved = await resolveReadScope(
		{ reach: scope.reach, projects: null },
		{ userId: "bob", local: false, groupIds: [] },
		async (subject) => readVisibilitySchema.parse(executeClassification(db, { op: "visibility", subject })),
	);
	const after = readScopeSql("m", resolved);
	expect(after).toEqual(before);
	const explain = (predicate: typeof before) =>
		db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM memories m WHERE 1=1 ${predicate.sql}`).all(...predicate.args);
	expect(explain(after)).toEqual(explain(before));
	expect(explain(after).some((row) => String(row.detail).includes("org_jobs"))).toBe(false);
	db.close();
});

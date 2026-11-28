import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { Fixture } from "./fixture";
import { request, success, text } from "./http";

test("live operator retention converges bounded recent and expired backlogs without deleting evidence", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon);
		const memory = success(
			await request(daemon.origin, "/api/memory/remember", fixture.admin, "POST", {
				content: "retention must preserve source evidence",
			}),
			"retention evidence",
		);
		const job = success(
			await request(daemon.origin, "/api/org/operator/jobs", fixture.admin, "POST", { action: "queue.requeue" }),
			"retention seed job",
		);
		await daemon.stop();
		const path = join(daemon.workspace, "data/signet.db");
		const seed = new Database(path);
		try {
			seed
				.prepare(
					"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1100) INSERT INTO org_jobs(id,kind,status,created_by,params_json,created_at,finished_at) SELECT 'retention-'||x,kind,'complete',created_by,params_json,created_at,finished_at FROM n,org_jobs WHERE id=?",
				)
				.run(text(job.jobId));
			seed
				.prepare(
					"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10100) INSERT INTO audit_events(id,at,action,outcome) SELECT 'retention-audit-'||x,?,'operator.logs_opened','ok' FROM n",
				)
				.run(new Date().toISOString());
		} finally {
			seed.close();
		}
		await daemon.start();
		for (let turn = 0; turn < 2; turn++)
			success(await request(daemon.origin, "/api/org/jobs", fixture.admin), "recent retention sweep");
		await daemon.stop();
		const check = new Database(path);
		try {
			expect(
				check
					.query<{ jobs: number; audits: number }, []>(
						"SELECT (SELECT count(*) FROM org_jobs WHERE kind='operator') jobs,(SELECT count(*) FROM audit_events WHERE action LIKE 'operator.%') audits",
					)
					.get(),
			).toEqual({ jobs: 1000, audits: 10000 });
			check.exec(
				"UPDATE org_jobs SET finished_at='2020-01-01T00:00:00.000Z' WHERE kind='operator'; UPDATE audit_events SET at='2020-01-01T00:00:00.000Z' WHERE action LIKE 'operator.%'",
			);
		} finally {
			check.close();
		}
		await daemon.start();
		for (let turn = 0; turn < 100; turn++)
			success(await request(daemon.origin, "/api/org/jobs", fixture.admin), "expired retention sweep");
		expect((await request(daemon.origin, `/api/memory/${text(memory.id)}`, fixture.admin)).status).toBe(200);
		await daemon.stop();
		const final = new Database(path, { readonly: true });
		try {
			expect(
				final
					.query<{ jobs: number; audits: number }, []>(
						"SELECT (SELECT count(*) FROM org_jobs WHERE kind='operator') jobs,(SELECT count(*) FROM audit_events WHERE action LIKE 'operator.%' AND at<'2021') audits",
					)
					.get(),
			).toEqual({ jobs: 0, audits: 0 });
		} finally {
			final.close();
		}
	} finally {
		await daemon.dispose();
	}
}, 60_000);

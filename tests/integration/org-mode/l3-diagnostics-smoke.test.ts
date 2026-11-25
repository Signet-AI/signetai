import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OrgDaemon } from "./daemon";
import { browser, record, request, success, text } from "./http";

function seed(daemon: OrgDaemon, hidden: boolean): void {
	if (daemon.child) throw new Error("Offline seeding requires the owned daemon to be stopped");
	const db = new Database(join(daemon.workspace, "data/signet.db"));
	try {
		const id = hidden ? "hidden" : "public";
		const compartment = hidden ? 1 : null;
		if (!hidden) db.exec("INSERT INTO compartments(id,key) VALUES(2,'public-fixture')");
		if (hidden)
			db.exec(
				"INSERT INTO classifications(id,name) VALUES('cls_diagnostic_secret','Secret'); INSERT INTO compartments(id,key) VALUES(1,'cls_diagnostic_secret'); INSERT INTO compartment_members VALUES(1,'cls_diagnostic_secret')",
			);
		db.prepare(
			"INSERT INTO memories(id,content,agent_id,compartment_id,created_at,updated_at) VALUES(?,?,'default',?,'2090','2090')",
		).run(id, `${id} content`, compartment);
		db.prepare(
			"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id,compartment_id) VALUES(?,?,'chunk','memory',?,?,2,'2090','default',?)",
		).run(`${id}-e`, `${id}-hash`, id, new Float32Array([1, 0]), compartment);
		db.prepare(
			"INSERT INTO session_checkpoints(id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,created_at,agent_id,compartment_id) VALUES(?,'diagnostic-session','test','atlas','atlas','manual',?,1,'2090','default',?)",
		).run(`${id}-checkpoint`, `${id} digest`, compartment);
		db.prepare(
			"INSERT INTO memory_search_telemetry(id,created_at,route,agent_id,session_key,project,query,filters_json,method,result_count,no_hits,duration_ms,timings_json,results_json,compartment_id) VALUES(?,'2090','test','default','diagnostic-session','atlas',?,'{}','hybrid',1,0,1,'{}','[]',?)",
		).run(`${id}-search`, `${id} query`, hidden ? 1 : 2);
		if (!hidden)
			for (let index = 2; index <= 3; index++) {
				const extra = `public-${index}`;
				db.prepare(
					"INSERT INTO memories(id,content,agent_id,created_at,updated_at) VALUES(?,?,'default','2090','2090')",
				).run(extra, `${extra} content`);
				db.prepare(
					"INSERT INTO embeddings(id,content_hash,chunk_text,source_type,source_id,vector,dimensions,created_at,agent_id) VALUES(?,?,'chunk','memory',?,?,2,'2090','default')",
				).run(`${extra}-e`, `${extra}-hash`, extra, new Float32Array([index, 1]));
			}
		if (hidden)
			db.exec(
				"INSERT INTO memory_jobs(id,memory_id,job_type,status,error,created_at,updated_at) VALUES('hidden-job','hidden','embed','dead','hidden error','2090','2090')",
			);
	} finally {
		db.close();
	}
}

test("real daemon diagnostics and projection preserve hidden-row isolation across restarts", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const claim = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await daemon.setupToken(),
			organizationName: "Diagnostics isolation",
			admin: { username: "diagnostic-admin", displayName: "Admin", password: "disposable diagnostic proof password" },
		});
		const admin = browser(claim);
		const userId = text(record(success(claim, "claim diagnostics fixture").user).id);
		await daemon.stop();
		seed(daemon, false);
		await daemon.start();
		const paths = [
			"/api/embeddings/projection",
			"/api/telemetry/memory-search?limit=1",
			"/api/checkpoints?project=atlas&limit=1",
			"/api/checkpoints/diagnostic-session?limit=1",
			"/api/diagnostics/database/tables/memories/sample?limit=1",
			"/api/diagnostics/queue",
		];
		const snapshot = async () => {
			const bodies = [];
			for (const path of paths) {
				const response = await request(daemon.origin, path, admin);
				expect(response.status).toBe(200);
				const body = record(response.body);
				delete body.timestamp;
				bodies.push(body);
			}
			return bodies;
		};
		const countPaths = ["/api/embeddings/status", "/api/embeddings/health"];
		const globalCounts = async () =>
			Promise.all(
				countPaths.map(async (path) => {
					const response = await request(daemon.origin, path, admin);
					expect(response.status).toBe(200);
					const body = record(response.body);
					expect(Object.keys(body).sort()).toEqual(["counts", "scope", "status"]);
					expect(body.status).toBe("global_counts");
					expect(body.scope).toBe("workspace");
					return record(body.counts);
				}),
			);
		const countBefore = await globalCounts();
		const before = await snapshot();
		expect(before[0]).toMatchObject({ count: 3, total: 3 });
		await daemon.stop();
		seed(daemon, true);
		await daemon.start();
		expect(await snapshot()).toEqual(before);
		const countAfter = await globalCounts();
		for (let index = 0; index < countPaths.length; index++) {
			expect(countAfter[index]?.embeddings).toBe(Number(countBefore[index]?.embeddings) + 1);
			expect(countAfter[index]?.memories).toBe(Number(countBefore[index]?.memories) + 1);
		}
		await daemon.stop();
		const db = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			db.exec(
				"UPDATE memories SET content='hidden edited' WHERE id='hidden'; UPDATE session_checkpoints SET digest='hidden edited' WHERE id='hidden-checkpoint'; UPDATE memory_search_telemetry SET query='hidden edited' WHERE id='hidden-search'",
			);
		} finally {
			db.close();
		}
		await daemon.start();
		expect(await snapshot()).toEqual(before);
		for (const path of [
			"/api/logs",
			"/api/logs/stream",
			"/api/telemetry/events",
			"/api/analytics/usage",
			"/api/config",
		]) {
			const response = await request(daemon.origin, path, admin);
			expect(response.status).toBe(403);
			expect(response.body).toMatchObject({ reason: "org_policy" });
		}
		const ready = record((await request(daemon.origin, "/health/ready")).body);
		expect(record(ready.checks).queue).toEqual({ status: "unavailable", reason: "Use scoped queue diagnostics" });
		await daemon.stop();
		const audience = new Database(join(daemon.workspace, "data/signet.db"));
		try {
			audience.prepare("INSERT INTO classification_audience VALUES('cls_diagnostic_secret','user',?)").run(userId);
		} finally {
			audience.close();
		}
		await daemon.start();
		const allowed = await snapshot();
		expect(allowed[0]).toMatchObject({ count: 4, total: 4 });
		expect(JSON.stringify(allowed[0])).toContain("hidden edited");
		expect(allowed.at(-1)).toMatchObject({ oldestDeadMemoryJob: { id: "hidden-job", error: "hidden error" } });
	} finally {
		await daemon.dispose();
	}
}, 180_000);

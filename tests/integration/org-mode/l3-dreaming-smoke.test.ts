import { test, expect } from "bun:test";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";
import { browser, request, success } from "./http";

test("real organization Dreaming routes scope durable passes and SSE across restart", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const claimed = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: await daemon.setupToken(),
			organizationName: "Dreaming scope proof",
			admin: { username: "admin", displayName: "Admin", password: crypto.randomUUID() + crypto.randomUUID() },
		});
		success(claimed, "claim");
		const credential = browser(claimed);
		const seed = async (audience: boolean) => {
			await daemon.stop();
			const code = `const {initDbAccessor,getDbAccessor,closeDbAccessor}=await import(${JSON.stringify(join(repo, "platform/daemon/src/db-accessor.ts"))});initDbAccessor(${JSON.stringify(join(daemon.workspace, "data/signet.db"))},{agentsDir:${JSON.stringify(daemon.workspace)}});await getDbAccessor().withWriteTxAsync(db=>{${audience ? `db.prepare("INSERT INTO classification_audience(classification_id,principal_kind,principal_id) SELECT 'cls_live','user',id FROM users WHERE username='admin'").run();` : `db.prepare("INSERT INTO classifications(id,name,created_at) VALUES('cls_live','Live hidden','now')").run();db.prepare("INSERT INTO compartments(id,key) VALUES(1,'cls_live')").run();db.prepare("INSERT INTO compartment_members(compartment_id,classification_id) VALUES(1,'cls_live')").run();db.prepare("INSERT INTO dreaming_passes(id,agent_id,status,mode,compartment_id) VALUES('live-public','default','completed','incremental',NULL),('live-hidden','default','completed','incremental',1)").run();`}});await closeDbAccessor();process.exit(0);`;
			const child = Bun.spawn([process.execPath, "-e", code], { env: daemon.env, stdout: "pipe", stderr: "pipe" });
			const error = await new Response(child.stderr).text();
			expect(await child.exited, error).toBe(0);
			await daemon.start();
		};
		await seed(false);
		const active = await request(daemon.origin, "/api/dream/status", credential);
		expect(active.status).toBe(200);
		expect(JSON.stringify(active.body)).toContain("live-public");
		expect(JSON.stringify(active.body)).not.toContain("live-hidden");
		const hidden = await request(daemon.origin, "/api/dream/passes/live-hidden/events", credential);
		const missing = await request(daemon.origin, "/api/dream/passes/missing/events", credential);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(missing.body);
		const consume = async (id: string) => {
			const response = await fetch(`${daemon.origin}/api/dream/passes/${id}/events`, {
				headers: { cookie: credential.cookie ?? "" },
				signal: AbortSignal.timeout(10_000),
			});
			expect(response.status).toBe(200);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("missing SSE body");
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(`"passId":"${id}"`);
			await reader.cancel();
		};
		await consume("live-public");
		await seed(true);
		await consume("live-hidden");
		console.log(`Verified isolated daemon ${daemon.child?.pid} at ${daemon.origin}, workspace ${daemon.workspace}`);
	} finally {
		await daemon.dispose();
	}
	expect(daemon.child).toBeUndefined();
}, 120_000);

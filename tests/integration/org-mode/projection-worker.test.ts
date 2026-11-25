import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";

test("B1 real daemon shuts down an active projection and reaps its owner", async () => {
	const daemon = await OrgDaemon.create();
	try {
		await daemon.stop();
		const configPath = join(daemon.workspace, "agent.yaml");
		const config = await readFile(configPath, "utf8");
		await writeFile(configPath, config.replace("mode: team", "mode: local"));
		const seedScript = `const {initDbAccessor,getDbAccessor,closeDbAccessor}=await import(${JSON.stringify(join(repo, "platform/daemon/src/db-accessor.ts"))});initDbAccessor(${JSON.stringify(join(daemon.workspace, "data/signet.db"))},{agentsDir:${JSON.stringify(daemon.workspace)}});
 getDbAccessor().withWriteTx(db=>{db.prepare("INSERT OR IGNORE INTO agents(id,name,created_at,updated_at) VALUES ('default','Default',datetime('now'),datetime('now'))").run();const m=db.prepare("INSERT INTO memories(id,agent_id,type,content,visibility,created_at,updated_at,updated_by) VALUES (?,'default','fact','projection','global',datetime('now'),datetime('now'),'fixture')");const e=db.prepare("INSERT INTO embeddings(id,source_type,source_id,content_hash,chunk_text,vector,dimensions,created_at,agent_id) VALUES (?,'memory',?,?,'projection',?,64,datetime('now'),'default')");for(let i=0;i<5000;i++){const id='daemon-fit-'+i;m.run(id);e.run(id,id,id,Buffer.from(Float32Array.from({length:64},(_,n)=>Math.sin(i*0.37+n*0.11)).buffer));}});await closeDbAccessor();process.exit(0);`;
		const seed = Bun.spawn([process.execPath, "-e", seedScript], { env: daemon.env, stdout: "pipe", stderr: "pipe" });
		const error = await new Response(seed.stderr).text();
		expect(await seed.exited, error).toBe(0);
		await daemon.start();
		let projectionSettled = false;
		const projection = fetch(`${daemon.origin}/api/embeddings/projection?limit=5000`)
			.then(
				(response) => response.text(),
				(error: unknown) => String(error),
			)
			.finally(() => {
				projectionSettled = true;
			});
		await Bun.sleep(1200);
		const start = performance.now();
		const memory = await fetch(`${daemon.origin}/api/memories?limit=1`);
		expect(memory.status).toBe(200);
		expect(performance.now() - start).toBeLessThan(500);
		expect(projectionSettled).toBe(false);
		await daemon.stop();
		await projection;
		expect(daemon.child).toBeUndefined();
		expect(daemon.lastStoppedPids.length).toBeGreaterThan(1);
		console.log("B1_DAEMON_PROJECTION_SHUTDOWN_REAPED", daemon.lastStoppedPids.length);
	} finally {
		await daemon.dispose();
	}
}, 120000);

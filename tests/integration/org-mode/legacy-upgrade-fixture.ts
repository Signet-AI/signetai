import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OrgDaemon, repo } from "./daemon";
import { Fixture } from "./fixture";
import { request, success, record } from "./http";

const receiptSchema = z.object({
	agentIds: z.array(z.string()),
	keys: z.array(z.object({ id: z.string(), name: z.string(), prefix: z.string(), key: z.string() })),
});
export type LegacyUpgradeFixture = Awaited<ReturnType<typeof legacyUpgradeFixture>>;
export async function legacyUpgradeFixture() {
	const daemon = await OrgDaemon.create();
	try {
		await daemon.stop();
		const credentialFile = join(daemon.root, "legacy-keys.json");
		const seed = join(daemon.root, "legacy-seed.ts");
		await writeFile(
			seed,
			`
import {writeFile} from "node:fs/promises";
import {initDbAccessor,getDbAccessor,closeDbAccessor} from ${JSON.stringify(join(repo, "platform/daemon/src/db-accessor.ts"))};
import {createApiKey} from ${JSON.stringify(join(repo, "platform/daemon/src/auth/api-keys.ts"))};
initDbAccessor(${JSON.stringify(join(daemon.workspace, "data/signet.db"))},{agentsDir:${JSON.stringify(daemon.workspace)}});
const db=getDbAccessor();
const agentIds=["legacy-user","legacy-team","legacy-fallback",...Array.from({length:189},(_,i)=>"legacy-extra-"+String(i).padStart(3,"0"))];
db.withWriteTx(tx=>{
 for(const id of agentIds) tx.prepare("INSERT INTO agents(id,name,kind,created_at,updated_at) VALUES (?,?,'legacy','2020','2020')").run(id,id);
 tx.prepare("INSERT INTO memories(id,agent_id,content,type,memory_kind,created_at,updated_at) VALUES ('legacy-public','legacy-user','Existing team evidence','fact','episodic','2020','2020'),('legacy-hidden','legacy-fallback','Classified existing evidence','fact','episodic','2020','2020'),('legacy-org-public','legacy-fallback','Organization retained evidence','fact','episodic','2020','2020')").run();
},"legacy-upgrade-fixture");
const keys=[
 createApiKey(db,{name:"Assign existing connector",role:"agent",permissions:["recall","remember"],harness:"codex",agentId:"legacy-user",scope:{agent:"legacy-user"}}),
 createApiKey(db,{name:"Revoke existing connector",role:"agent",permissions:["recall","remember"],harness:"codex"}),
 createApiKey(db,{name:"Keep bound connector until deadline",role:"agent",permissions:["recall","remember"],harness:"codex",agentId:"legacy-team",scope:{agent:"legacy-team"}}),
 createApiKey(db,{name:"Keep unbound connector until deadline",role:"agent",permissions:["recall","remember"],harness:"codex"})
];
db.withWriteTx(tx=>tx.prepare("UPDATE api_keys SET legacy=1").run(),"legacy-upgrade-fixture");
await writeFile(${JSON.stringify(credentialFile)},JSON.stringify({agentIds,keys:keys.map(({id,name,prefix,key})=>({id,name,prefix,key}))}),{mode:0o600});
await closeDbAccessor();
process.exit(0);
`,
			{ mode: 0o600 },
		);
		const child = Bun.spawn([process.execPath, seed], { cwd: repo, env: daemon.env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		assert.equal(exit, 0, stdout + stderr);
		const receipt = receiptSchema.parse(JSON.parse(await readFile(credentialFile, "utf8")));
		await rm(credentialFile);
		await daemon.start();
		assert.equal(
			record(success(await request(daemon.origin, "/api/auth/methods"), "unclaimed legacy fixture").organization)
				.claimed,
			false,
		);
		const fixture = await Fixture.create(daemon, "personal", false);
		await fixture.classify("memory", "legacy-hidden", "legacy-fallback");
		const plan = {
			mappings: receipt.agentIds
				.filter((agentId) => agentId !== "legacy-fallback")
				.map((agentId) =>
					agentId === "legacy-user"
						? { agentId, kind: "personal", ownerUserId: fixture.user("alice").id }
						: { agentId, kind: "team", ownerGroupId: fixture.engId },
				),
			keys: receipt.keys
				.slice(0, 2)
				.map((key, index) =>
					index === 0
						? { id: key.id, action: "assign", userId: fixture.user("alice").id }
						: { id: key.id, action: "revoke" },
				),
			legacyKeyDeadline: "2030-01-01T00:00:00.000Z",
		};
		return { daemon, fixture, ...receipt, plan };
	} catch (error) {
		await daemon.dispose();
		throw error;
	}
}
export async function legacyUpgradeSnapshot(daemon: OrgDaemon) {
	const snapshot = join(daemon.root, "legacy-snapshot.ts");
	await writeFile(
		snapshot,
		`import {Database} from "bun:sqlite";const db=new Database(${JSON.stringify(join(daemon.workspace, "data/signet.db"))},{readonly:true});console.log(JSON.stringify({evidence:db.query("SELECT * FROM memories WHERE id IN ('legacy-public','legacy-hidden','legacy-org-public') ORDER BY id").all(),assignments:db.query("SELECT * FROM classification_assignments WHERE target_id='legacy-hidden'").all(),jobs:db.query("SELECT id,status,progress_json FROM org_jobs WHERE kind='organization_upgrade'").all()}));db.close();`,
	);
	const child = Bun.spawn([process.execPath, snapshot], { env: daemon.env, cwd: repo, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(exit, 0, stderr);
	return z
		.object({
			evidence: z.array(z.record(z.string(), z.unknown())),
			assignments: z.array(z.record(z.string(), z.unknown())),
			jobs: z.array(z.object({ id: z.string(), status: z.string(), progress_json: z.string() })),
		})
		.parse(JSON.parse(stdout));
}

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
async function start(path: string) {
	const port = 36000 + Math.floor(Math.random() * 10000);
	const env = {
		...process.env,
		SIGNET_PATH: path,
		SIGNET_BIND: "127.0.0.1",
		SIGNET_PORT: String(port),
		SIGNET_AGENT_ID: "contract-agent",
	};
	const child = Bun.spawn([bin], { cwd: root, env, stdout: "ignore", stderr: "pipe" });
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon readiness timeout: ${await new Response(child.stderr).text()}`);
}
const headers = (agent: string, workspace: string) => ({
	"content-type": "application/json",
	"x-signet-agent": agent,
	"x-signet-workspace": workspace,
});
// biome-ignore lint/suspicious/noExplicitAny: dynamic HTTP contract payloads
async function body(r: Response): Promise<any> {
	return r.json();
}
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGTERM");
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("fresh knowledge graph boundary is scoped, bounded, durable, and explicit about unsupported aliases", async () => {
	const dir = mkdtempSync("/mnt/work/hermes-scratch/kg-contract-");
	dirs.push(dir);
	let daemon = await start(dir);
	const a = headers("agent-a", "workspace-a");
	const b = headers("agent-b", "workspace-b");
	const create = await fetch(`${daemon.origin}/api/knowledge/entities?agent_id=agent-a&workspace_id=workspace-a`, {
		method: "POST",
		headers: a,
		body: JSON.stringify({ name: "Alice", type: "person", metadata: { source: "contract" } }),
	});
	expect(create.status).toBe(201);
	const alice = await body(create);
	const bobResponse = await fetch(`${daemon.origin}/api/knowledge/entities?workspace_id=workspace-a`, {
		method: "POST",
		headers: a,
		body: JSON.stringify({ name: "Bob", type: "person", metadata: {} }),
	});
	expect(bobResponse.status).toBe(201);
	const bob = await body(bobResponse);
	const aspectResponse = await fetch(`${daemon.origin}/api/knowledge/aspects?workspace_id=workspace-a`, {
		method: "POST",
		headers: a,
		body: JSON.stringify({ entity_id: alice.id, name: "identity", weight: 0.8 }),
	});
	expect(aspectResponse.status).toBe(201);
	const aspect = await body(aspectResponse);
	const attr = await fetch(`${daemon.origin}/api/knowledge/attributes?workspace_id=workspace-a`, {
		method: "POST",
		headers: a,
		body: JSON.stringify({ aspect_id: aspect.id, kind: "fact", content: "human" }),
	});
	expect(attr.status).toBe(201);
	const relation = await fetch(`${daemon.origin}/api/knowledge/relations?workspace_id=workspace-a`, {
		method: "POST",
		headers: a,
		body: JSON.stringify({ from_id: alice.id, to_id: bob.id, relation: "knows", metadata: {} }),
	});
	expect(relation.status).toBe(201);
	const listed = await body(
		await fetch(`${daemon.origin}/api/knowledge/entities?workspace_id=workspace-a&limit=999&offset=0`, { headers: a }),
	);
	expect(listed.items).toHaveLength(2);
	expect(listed.limit).toBe(200);
	expect((await body(await fetch(`${daemon.origin}/api/knowledge/entities`, { headers: b }))).items).toHaveLength(0);
	expect(
		(
			await body(
				await fetch(`${daemon.origin}/api/knowledge/entities/${alice.id}/relations?workspace_id=workspace-a&limit=1`, {
					headers: a,
				}),
			)
		).items,
	).toHaveLength(1);
	expect(
		(
			await body(
				await fetch(
					`${daemon.origin}/api/knowledge/navigation/tree?workspace_id=workspace-a&entity_id=${alice.id}&depth=999`,
					{ headers: a },
				),
			)
		).depth,
	).toBe(3);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities`, {
				method: "POST",
				headers: a,
				body: JSON.stringify({ name: "bad", type: "person", metadata: [] }),
			})
		).status,
	).toBe(400);
	expect((await fetch(`${daemon.origin}/api/knowledge/entities/${alice.id}`, { headers: a })).status).toBe(501);
	expect((await fetch(`${daemon.origin}/api/knowledge/constellation`, { headers: a })).status).toBe(501);
	await new Promise((r) => setTimeout(r, 50));
	daemon.child.kill("SIGTERM");
	await daemon.child.exited;
	daemon = await start(dir);
	expect(
		(await body(await fetch(`${daemon.origin}/api/knowledge/entities?workspace_id=workspace-a`, { headers: a }))).items,
	).toHaveLength(2);
});

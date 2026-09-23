import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];
const dirs: string[] = [];
let port = 39_100;
const binary = Bun.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
async function start(agent: string) {
	if (!existsSync(binary)) throw new Error(`missing daemon: ${binary}`);
	const dir = mkdtempSync(join(tmpdir(), "signet-kg-"));
	dirs.push(dir);
	const child = Bun.spawn([binary], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port++),
			SIGNET_AGENT_ID: agent,
			SIGNET_API_KEY: "",
			SIGNET_TOKEN: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, dir };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("daemon not ready");
}
const headers = (agent: string) => ({ "content-type": "application/json", "x-signet-agent": agent });
afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	for (const dir of dirs.splice(0))
		try {
			Bun.spawnSync(["rm", "-rf", dir]);
		} catch {}
});

describe("fresh native knowledge graph", () => {
	it("persists scoped entities, aspects, attributes, relations and bounded tree", async () => {
		const { origin, dir } = await start("graph-a");
		const h = headers("graph-a");
		const qs = "?workspace_id=w1";
		const create = async (path: string, body: unknown) =>
			fetch(`${origin}${path}${qs}`, { method: "POST", headers: h, body: JSON.stringify(body) });
		const a = await create("/api/knowledge/entities", { name: "Alice", type: "person" });
		const b = await create("/api/knowledge/entities", { name: "Bob", type: "person" });
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		const aid = (await a.json()).id;
		const bid = (await b.json()).id;
		expect((await create("/api/knowledge/relations", { from_id: aid, to_id: bid, relation: "knows" })).status).toBe(
			201,
		);
		const aspect = await create("/api/knowledge/aspects", { entity_id: aid, name: "identity" });
		expect(aspect.status).toBe(201);
		const aspectId = (await aspect.json()).id;
		expect(
			(await create("/api/knowledge/attributes", { aspect_id: aspectId, kind: "fact", content: "human" })).status,
		).toBe(201);
		expect(
			(
				await (
					await fetch(`${origin}/api/knowledge/navigation/tree?entity_id=${aid}&workspace_id=w1`, { headers: h })
				).json()
			).aspects,
		).toHaveLength(1);
		expect(
			(await (await fetch(`${origin}/api/knowledge/entities/${aid}/relations${qs}`, { headers: h })).json()).items,
		).toHaveLength(1);
		expect(
			(await (await fetch(`${origin}/api/knowledge/entities?workspace_id=w2`, { headers: h })).json()).items,
		).toHaveLength(0);
		const malformed = await fetch(`${origin}/api/knowledge/entities`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({ name: "bad" }),
		});
		expect(malformed.status).toBeGreaterThanOrEqual(400);
		expect(malformed.status).toBeLessThan(500);
		expect(dir).toBeTruthy();
	});
});

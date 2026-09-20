import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary =
	(Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN") as string | undefined) ??
	join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const agent = "graph-completeness-agent";

async function port(): Promise<number> {
	const s = Bun.serve({ port: 0, fetch: () => new Response() });
	const p = s.port;
	s.stop();
	if (p === undefined) throw new Error("port allocation failed");
	return p;
}
async function start(workspace: string) {
	const p = await port();
	const child = Bun.spawn([binary], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(p),
			SIGNET_AGENT_ID: agent,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${p}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {}
		await Bun.sleep(10);
	}
	child.kill("SIGTERM");
	throw new Error("daemon did not start");
}

it("integrates durable graph-linked memories into bounded search results", async () => {
	if (!existsSync(binary)) throw new Error(`build daemon first: ${binary}`);
	const workspace = mkdtempSync(join(tmpdir(), "signet-retrieval-completeness-"));
	const { child, origin } = await start(workspace);
	try {
		const memoryId = "memory-graph-1";
		const db = new Database(join(workspace, "memory", "memories.db"));
		db.query("INSERT INTO agents(id,metadata) VALUES (?,?)").run(agent, "{}");
		db.query("INSERT INTO memories(id,agent_id,content,metadata,deleted) VALUES (?,?,?,?,0)").run(
			memoryId,
			agent,
			"durable graph fact",
			"{}",
		);
		db.query(
			"INSERT INTO kg_entities(id,agent_id,workspace_id,name,entity_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
		).run("entity-1", agent, "default", "Rust", "topic", "now", "now");
		db.query(
			"INSERT INTO kg_aspects(id,agent_id,workspace_id,entity_id,name,canonical_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
		).run("aspect-1", agent, "default", "entity-1", "language", "language", "now", "now");
		db.query(
			"INSERT INTO kg_attributes(id,agent_id,workspace_id,aspect_id,memory_id,kind,content,normalized_content,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			"attribute-1",
			agent,
			"default",
			"aspect-1",
			memoryId,
			"fact",
			"tokengraph",
			"tokengraph",
			"active",
			"now",
			"now",
		);
		db.close();
		const response = await fetch(`${origin}/api/memory/search?q=tokengraph&agent_id=${agent}&limit=1`, {
			headers: { "x-signet-agent-id": agent },
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.results.some((row: { id: string }) => row.id === memoryId)).toBe(true);
		expect(body.meta.channels.graph.supported).toBe(true);
		expect(body.meta.channels.graph.resultCount).toBeGreaterThan(0);
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		rmSync(workspace, { recursive: true, force: true });
	}
});

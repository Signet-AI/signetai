/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Daemon = { origin: string; workspace: string; child: ReturnType<typeof Bun.spawn>; stderr: string[] };
const binary =
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/release/signet-daemon");
const daemons: Daemon[] = [];
const workspaces: string[] = [];
let port = 39_100 + Math.floor(Math.random() * 400);

async function start(workspace = mkdtempSync(join(tmpdir(), "signet-pagination-"))): Promise<Daemon> {
	if (!existsSync(binary)) throw new Error(`missing fresh daemon binary: ${binary}`);
	if (!workspaces.includes(workspace)) workspaces.push(workspace);
	const stderr: string[] = [];
	const child = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port++) },
		stdout: "ignore",
		stderr: "pipe",
	});
	const reader = child.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			stderr.push(decoder.decode(next.value));
		}
	})();
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) {
				const daemon = { origin, workspace, child, stderr };
				daemons.push(daemon);
				return daemon;
			}
		} catch {}
		if (await Promise.race([child.exited.then(() => true), Bun.sleep(25).then(() => false)]))
			throw new Error(`daemon exited; stderr: ${stderr.join("")}`);
	}
	child.kill("SIGTERM");
	await child.exited;
	throw new Error(`daemon readiness failed; stderr: ${stderr.join("")}`);
}
async function stop(d: Daemon) {
	d.child.kill("SIGTERM");
	const code = await d.child.exited;
	expect(code).toBe(0);
}
async function request(d: Daemon, path: string, init: RequestInit = {}, agent = "agent-a") {
	const response = await fetch(d.origin + path, {
		...init,
		headers: { "x-signet-agent": agent, "content-type": "application/json", ...init.headers },
	});
	const text = await response.text();
	let body: any = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { response, body, text };
}
async function remember(d: Daemon, content: string, agent = "agent-a") {
	const result = await request(d, "/api/memory/remember", { method: "POST", body: JSON.stringify({ content }) }, agent);
	expect(result.response.status).toBe(201);
	return result.body;
}
async function page(d: Daemon, path: string, agent = "agent-a") {
	return request(d, path, {}, agent);
}

afterEach(async () => {
	for (const d of daemons.splice(0)) {
		try {
			await stop(d);
		} catch {
			d.child.kill("SIGKILL");
			await d.child.exited.catch(() => -1);
		}
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("fresh native Rust pagination", () => {
	it("pages memories and ontology with truthful cursors, isolation, bounds, and restart durability", async () => {
		let d = await start();
		try {
			for (const value of ["m-03", "m-01", "m-04", "m-02"]) await remember(d, value);
			await remember(d, "other-agent", "agent-b");
			const first = await page(d, "/api/memories?limit=2");
			expect(first.response.status).toBe(200);
			expect(first.body).toHaveProperty("memories");
			expect(first.body).not.toHaveProperty("items");
			expect(first.body.memories).toHaveLength(2);
			expect(first.body.complete).toBe(false);
			expect(typeof first.body.nextCursor).toBe("string");
			const second = await page(d, `/api/memories?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
			expect(second.body.memories).toHaveLength(2);
			expect(second.body.complete).toBe(true);
			expect(second.body.nextCursor).toBeNull();
			const ids = [...first.body.memories, ...second.body.memories].map((m: any) => m.id);
			expect(new Set(ids).size).toBe(4);
			const repeat = await page(d, "/api/memories?limit=2");
			expect(repeat.body.memories.map((m: any) => m.id)).toEqual(first.body.memories.map((m: any) => m.id));
			expect((await page(d, "/api/memories?limit=0")).response.status).toBe(400);
			expect((await page(d, "/api/memories?limit=101")).response.status).toBe(400);
			expect((await page(d, "/api/memories?limit=nope")).response.status).toBe(400);
			expect((await page(d, "/api/memories?cursor=not-a-real-cursor")).response.status).toBe(400);
			expect((await page(d, "/api/memories?limit=2", "agent-b")).body.memories).toHaveLength(1);

			for (const [id, name] of [
				["z", "zeta"],
				["a", "alpha"],
				["m", "mu"],
			]) {
				const saved = await request(d, "/api/ontology/entity?workspace_id=workspace-a", {
					method: "POST",
					body: JSON.stringify({ id, name }),
				});
				expect(saved.response.status).toBe(200);
			}
			const op1 = await page(d, "/api/ontology/entity?workspace_id=workspace-a&limit=2");
			expect(op1.response.status).toBe(200);
			expect(op1.body).toHaveProperty("items");
			expect(op1.body.items).toHaveLength(2);
			expect(op1.body.complete).toBe(false);
			expect(typeof op1.body.nextCursor).toBe("string");
			const op2 = await page(
				d,
				`/api/ontology/entity?workspace_id=workspace-a&limit=2&cursor=${encodeURIComponent(op1.body.nextCursor)}`,
			);
			expect(op2.body.items).toHaveLength(1);
			expect(op2.body.complete).toBe(true);
			expect(op2.body.nextCursor).toBeNull();
			expect(new Set([...op1.body.items, ...op2.body.items].map((x: any) => x.id))).toEqual(new Set(["a", "m", "z"]));
			const opRepeat = await page(d, "/api/ontology/entity?workspace_id=workspace-a&limit=2");
			expect(opRepeat.body.items.map((x: any) => x.id)).toEqual(op1.body.items.map((x: any) => x.id));
			expect((await page(d, "/api/ontology/entity?workspace_id=workspace-b&limit=2")).body.items).toEqual([]);
			expect((await page(d, "/api/ontology/entity?workspace_id=workspace-a&limit=0")).response.status).toBe(400);
			expect((await page(d, "/api/ontology/entity?workspace_id=workspace-a&limit=201")).response.status).toBe(400);
			expect((await page(d, "/api/ontology/entity?workspace_id=workspace-a&cursor=bad")).response.status).toBe(400);

			const workspace = d.workspace;
			const cursor = op1.body.nextCursor;
			await stop(d);
			daemons.splice(daemons.indexOf(d), 1);
			d = await start(workspace);
			const resumed = await page(
				d,
				`/api/ontology/entity?workspace_id=workspace-a&limit=2&cursor=${encodeURIComponent(cursor)}`,
			);
			expect(resumed.response.status).toBe(200);
			expect(resumed.body.items.map((x: any) => x.id)).toEqual(["z"]);
			expect(resumed.body.complete).toBe(true);
			const memories = await page(d, "/api/memories?limit=10");
			expect(new Set(memories.body.memories.map((m: any) => m.content))).toEqual(
				new Set(["m-01", "m-02", "m-03", "m-04"]),
			);
		} finally {
			await stop(d);
		}
	});
});

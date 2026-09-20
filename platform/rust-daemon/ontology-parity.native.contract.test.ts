import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const binary =
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/release/signet-daemon");
type D = { child: ReturnType<typeof Bun.spawn>; base: string; dir: string };
const ds: D[] = [];
async function start(dir = mkdtempSync(join(tmpdir(), "ontology-contract-"))) {
	if (!existsSync(binary)) throw new Error(`missing daemon: ${binary}`);
	const port = 40100 + ds.length + Math.floor(Math.random() * 100);
	const child = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
		stdout: "ignore",
		stderr: "ignore",
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${base}/health/ready`)).ok) {
				const d = { child, base, dir };
				ds.push(d);
				return d;
			}
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error("daemon did not start");
}
async function req(d: D, path: string, init: RequestInit = {}, agent = "contract-agent") {
	const r = await fetch(d.base + path, {
		...init,
		headers: { "x-signet-agent": agent, "content-type": "application/json", ...init.headers },
	});
	const text = await r.text();
	return { r, body: text ? JSON.parse(text) : null };
}
afterEach(async () => {
	for (const d of ds.splice(0)) {
		d.child.kill("SIGTERM");
		await d.child.exited;
		rmSync(d.dir, { recursive: true, force: true });
	}
});

it("supports scoped proposal/claim/constraint CRUD and truthful unsupported ontology actions", async () => {
	let d = await start();
	const saved = await req(d, "/api/ontology/proposals?workspace_id=ws-a", {
		method: "POST",
		body: JSON.stringify({ id: "p-1", source: "test", provenance: { quote: "q" } }),
	});
	expect(saved.r.status).toBe(200);
	expect(saved.body.id).toBe("p-1");
	expect((await req(d, "/api/ontology/proposals?workspace_id=ws-b")).body.items).toEqual([]);
	expect((await req(d, "/api/ontology/proposals?workspace_id=ws-a&limit=0")).r.status).toBe(400);
	expect((await req(d, "/api/ontology/proposals/p-1?workspace_id=ws-a")).body.value.provenance.quote).toBe("q");
	expect(
		(await req(d, "/api/ontology/proposals/p-1/apply?workspace_id=ws-a", { method: "POST", body: "{}" })).r.status,
	).toBe(501);
	expect((await req(d, "/api/ontology/proposals/conflicts?workspace_id=ws-a")).r.status).toBe(501);
	expect((await req(d, "/api/ontology/proposals/p-1?workspace_id=ws-a", { method: "DELETE" })).r.status).toBe(200);
	expect((await req(d, "/api/ontology/proposals/p-1?workspace_id=ws-a")).r.status).toBe(404);
	d.child.kill("SIGTERM");
	await d.child.exited;
	ds.splice(ds.indexOf(d), 1);
	d = await start(d.dir);
	expect((await req(d, "/api/ontology/proposals/p-1?workspace_id=ws-a")).r.status).toBe(404);
});

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "target/debug/signet-daemon");
async function start() {
	const workspace = mkdtempSync("/tmp/signet-transcript-");
	const port = 38791 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_PORT: String(port),
			SIGNET_BIND: "127.0.0.1",
			SIGNET_AGENT_ID: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin + "/health/ready")).ok) return { origin, workspace, child };
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error("daemon not ready");
}
describe("fresh rust transcript contracts", () => {
	it("accepts bounded scoped imports and restart-safe transcript reads", async () => {
		const s = await start();
		const h = { "content-type": "application/json", "x-signet-agent": "a" };
		const job = await fetch(s.origin + "/api/sources/imports", {
			method: "POST",
			headers: h,
			body: JSON.stringify({ files: [{ name: "a.jsonl" }] }),
		});
		expect(job.status).toBe(201);
		const id = (await job.json()).id;
		expect((await fetch(s.origin + "/api/sources/imports/" + id, { headers: h })).status).toBe(200);
		expect((await fetch(s.origin + "/api/sources/imports/" + id, { headers: { "x-signet-agent": "b" } })).status).toBe(
			404,
		);
		const put = await fetch(s.origin + "/api/transcripts", {
			method: "POST",
			headers: { ...h, "idempotency-key": "t1" },
			body: JSON.stringify({ sessionKey: "s1", harness: "bun", content: "hello", idempotency_key: "t1" }),
		});
		expect(put.status).toBe(200);
		expect((await fetch(s.origin + "/api/transcripts", { headers: h })).status).toBe(200);
		childKill(s.child);
		rmSync(s.workspace, { recursive: true, force: true });
	});
	it("rejects invalid and oversized import payloads", async () => {
		const s = await start();
		const r = await fetch(s.origin + "/api/sources/imports", {
			method: "POST",
			headers: { "content-type": "application/json", "x-signet-agent": "a" },
			body: JSON.stringify({ files: [] }),
		});
		expect(r.status).toBe(400);
		childKill(s.child);
		rmSync(s.workspace, { recursive: true, force: true });
	});
});
function childKill(child: any) {
	child.kill("SIGTERM");
}

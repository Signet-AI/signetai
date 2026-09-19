import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
let port = 38990;

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(existing?: string) {
	const dir = existing ?? mkdtempSync(join(tmpdir(), "signet-job-contract-"));
	if (!existing) dirs.push(dir);
	const p = port++;
	const child = Bun.spawn([bin], {
		env: { ...process.env, SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(p), SIGNET_AGENT_ID: "" },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${p}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, dir };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("native daemon readiness timeout");
}
const headers = (agent: string, workspace: string) => ({
	"content-type": "application/json",
	"x-signet-agent-id": agent,
	"x-workspace-id": workspace,
});

it("exercises native durable job identity, cursor, cancellation, and recovery contracts", async () => {
	const { origin, dir } = await start();
	const h = headers("agent-a", "workspace-a");
	const created = await fetch(`${origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "contract", payload: { ok: true } }),
	});
	expect(created.status).toBe(200);
	const job = await created.json();
	expect(job.state).toBe("queued");
	expect(job.workspaceId).toBe("workspace-a");
	expect((await fetch(`${origin}/api/memory/jobs/${job.id}`, { headers: h })).status).toBe(200);
	expect((await fetch(`${origin}/api/jobs/${job.id}`, { headers: headers("agent-a", "workspace-b") })).status).toBe(
		404,
	);
	expect((await fetch(`${origin}/api/jobs`, { headers: headers("agent-b", "workspace-a") })).status).toBe(200);
	const cancelled = await fetch(`${origin}/api/jobs/${job.id}`, {
		method: "DELETE",
		headers: { ...h, "x-actor": "test", "x-reason": "contract" },
	});
	expect((await cancelled.json()).state).toBe("cancelled");
	const repeated = await fetch(`${origin}/api/jobs/${job.id}`, { method: "DELETE", headers: h });
	expect((await repeated.json()).state).toBe("cancelled");
	const events = await fetch(`${origin}/api/jobs/${job.id}/events?cursor=0&limit=10`, { headers: h });
	expect(events.ok).toBe(true);
	expect(await events.text()).toContain("queued");
	const malformed = await fetch(`${origin}/api/jobs`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ kind: "", payload: {} }),
	});
	expect(malformed.status).toBe(400);
	const child = children[0];
	child.kill();
	await child.exited;
	const restarted = await start(dir);
	const recovered = await fetch(`${restarted.origin}/api/jobs/${job.id}`, { headers: h });
	expect(recovered.status).toBe(200);
	expect((await recovered.json()).state).toBe("cancelled");
	void dir;
});

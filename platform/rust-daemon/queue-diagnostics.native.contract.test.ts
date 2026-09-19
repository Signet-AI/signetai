import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract accepts an explicit binary override
const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
let port = 39100;
const b64 = (v: string) => Buffer.from(v).toString("base64url");
function token(secret: Buffer, role: string, agent: string, workspace: string) {
	const p = b64(
		JSON.stringify({
			sub: "queue-contract",
			role,
			scope: { agent, workspace },
			permissions: ["diagnostics"],
			iat: Math.floor(Date.now() / 1000) - 1,
			exp: Math.floor(Date.now() / 1000) + 3600,
		}),
	);
	return `${p}.${createHmac("sha256", secret).update(p).digest("base64url")}`;
}
async function start(dir = mkdtempSync(`/mnt/work/hermes-scratch/queue-${Date.now()}-`)) {
	dirs.push(dir);
	mkdirSync(join(dir, ".daemon"), { recursive: true });
	const secret = randomBytes(32);
	writeFileSync(join(dir, ".daemon/auth-secret"), secret);
	const p = port++;
	const child = Bun.spawn([bin], {
		env: { SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: `${p}`, SIGNET_API_KEY: "", SIGNET_TOKEN: "" },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${p}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child, secret, dir };
		} catch {}
		await Bun.sleep(25);
	}
	throw Error("readiness timeout");
}
async function stop(child: Bun.Subprocess) {
	child.kill();
	await child.exited;
}
const h = (t: string, agent: string, workspace: string) => ({
	authorization: `Bearer ${t}`,
	"x-signet-agent-id": agent,
	"x-workspace-id": workspace,
});
afterEach(async () => {
	for (const c of children.splice(0)) await stop(c);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("serves scoped native queue diagnostics without legacy fallback or repair", async () => {
	const s = await start();
	const admin = token(s.secret, "admin", "agent-a", "workspace-a");
	const readonly = token(s.secret, "readonly", "agent-a", "workspace-a");
	expect((await fetch(`${s.origin}/api/diagnostics/queue`)).status).toBe(401);
	expect(
		(await fetch(`${s.origin}/api/diagnostics/queue`, { headers: h(readonly, "agent-a", "workspace-a") })).status,
	).toBe(403);
	const job = await fetch(`${s.origin}/api/jobs`, {
		method: "POST",
		headers: { ...h(admin, "agent-a", "workspace-a"), "content-type": "application/json" },
		body: JSON.stringify({ kind: "diagnostic", payload: { ok: true } }),
	});
	expect(job.ok).toBe(true);
	const url = `${s.origin}/api/diagnostics/queue?agentId=agent-a&workspaceId=workspace-a&limit=1`;
	const first = await fetch(url, { headers: h(admin, "agent-a", "workspace-a") });
	expect(first.status).toBe(200);
	const body = await first.json();
	expect(body.jobs.count).toBe(1);
	expect(body.jobs.items).toHaveLength(1);
	expect(body.metadata.unsupported.memory).toBe("unsupported");
	expect(body.metadata.unsupported.summary).toBe("unsupported");
	expect(body.metadata.unsupported.repair).toBe("unsupported");
	expect(
		(
			await fetch(`${s.origin}/api/diagnostics/queue?agentId=agent-a&workspaceId=workspace-a&limit=0`, {
				headers: h(admin, "agent-a", "workspace-a"),
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${s.origin}/api/diagnostics/queue?agentId=agent-a&workspaceId=workspace-a&bogus=1`, {
				headers: h(admin, "agent-a", "workspace-a"),
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${s.origin}/api/diagnostics/queue/repair`, {
				method: "POST",
				headers: h(admin, "agent-a", "workspace-a"),
				body: "{}",
			})
		).status,
	).toBe(501);
	const other = await fetch(`${s.origin}/api/diagnostics/queue?agentId=agent-b&workspaceId=workspace-b`, {
		headers: h(admin, "agent-a", "workspace-a"),
	});
	expect(other.status).toBe(403);
	const dir = s.dir;
	await stop(s.child);
	const restarted = await start(dir);
	const persisted = await fetch(`${restarted.origin}/api/diagnostics/queue?agentId=agent-a&workspaceId=workspace-a`, {
		headers: h(admin, "agent-a", "workspace-a"),
	});
	expect((await persisted.json()).jobs.count).toBe(1);
});

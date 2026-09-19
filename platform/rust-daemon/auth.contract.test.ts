import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const secret = "12345678901234567890123456789012";

async function daemon() {
	if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
	const workspace = mkdtempSync(join(tmpdir(), "signet-auth-"));
	mkdirSync(join(workspace, ".daemon"));
	writeFileSync(join(workspace, ".daemon", "auth-secret"), secret);
	const port = 39100 + Math.floor(Math.random() * 500);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "controlled-admin",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) break;
		} catch {}
		await Bun.sleep(25);
	}
	return { origin, child, workspace };
}

async function request(origin: string, path: string, init: RequestInit = {}) {
	const response = await fetch(origin + path, {
		...init,
		headers: {
			authorization: "Bearer controlled-admin",
			"x-signet-agent": "agent-a",
			"content-type": "application/json",
			...init.headers,
		},
	});
	return { response, body: await response.json().catch(() => ({})) };
}

describe("fresh Rust auth boundary", () => {
	it("keeps durable keys and refuses authority escalation, leakage, and cross-agent access", async () => {
		const d = await daemon();
		try {
			expect((await request(d.origin, "/api/auth/methods")).response.status).toBe(200);
			const created = await request(d.origin, "/api/auth/api-keys", {
				method: "POST",
				body: JSON.stringify({
					name: "agent key",
					role: "agent",
					scope: { agent: "agent-a", workspace: "scratch" },
					permissions: ["recall"],
				}),
			});
			expect(created.response.status).toBe(201);
			expect(created.body.apiKey.key).toMatch(/^sig_sk_/);
			const key = created.body.apiKey.key;
			expect(JSON.stringify(await request(d.origin, "/api/auth/api-keys")).includes(key)).toBe(false);
			const deniedRole = await request(d.origin, "/api/auth/token", {
				method: "POST",
				body: JSON.stringify({ role: "admin", scope: { agent: "agent-a" } }),
			});
			expect(deniedRole.response.status).toBe(403);
			const deniedAgent = await request(d.origin, "/api/auth/api-keys", {
				method: "POST",
				body: JSON.stringify({ name: "bad", agentId: "agent-b" }),
			});
			expect(deniedAgent.response.status).toBe(400);
			expect(
				(await request(d.origin, "/api/auth/api-keys", { headers: { "x-signet-agent": "agent-b" } })).body.apiKeys,
			).toEqual([]);
			const malformed = await request(d.origin, "/api/auth/token", { method: "POST", body: "{" });
			expect(malformed.response.status).toBe(400);
			expect(JSON.stringify(malformed.body)).not.toContain("controlled-admin");
			const revoke = await request(d.origin, `/api/auth/api-keys/${created.body.apiKey.id}`, { method: "DELETE" });
			expect(revoke.response.status).toBe(200);
			const verify = await request(d.origin, "/api/auth/whoami", { headers: { authorization: `Bearer ${key}` } });
			expect(verify.response.status).toBe(401);
		} finally {
			d.child.kill("SIGTERM");
			await d.child.exited;
			rmSync(d.workspace, { recursive: true, force: true });
		}
	});
});

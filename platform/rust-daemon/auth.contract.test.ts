/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const admin = "fixture-admin-authority";
type Daemon = { origin: string; child: ReturnType<typeof Bun.spawn>; workspace: string; stderr: string[] };

async function daemon(workspace?: string, port = 39100 + Math.floor(Math.random() * 500)): Promise<Daemon> {
	if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
	const root = workspace ?? mkdtempSync(join(tmpdir(), "signet-auth-"));
	mkdirSync(join(root, ".daemon"), { recursive: true });
	writeFileSync(join(root, ".daemon", "auth-secret"), secret);
	const stderr: string[] = [];
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: root,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: admin,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const reader = child.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			stderr.push(decoder.decode(next.value));
		}
	})();
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child, workspace: root, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	child.kill("SIGTERM");
	await child.exited;
	throw new Error(`daemon readiness failed; stderr: ${stderr.join("")}`);
}
async function stop(d: Daemon) {
	d.child.kill("SIGTERM");
	expect(await d.child.exited).toBe(0);
	expect(d.stderr.join("")).not.toContain(admin);
}
async function request(origin: string, path: string, init: RequestInit = {}, credential = admin, agent = "agent-a") {
	const response = await fetch(origin + path, {
		...init,
		headers: {
			authorization: "Bearer " + credential, // biome-ignore lint/style/useTemplate: avoid secret-like literal interpolation in fixture
			"x-signet-agent": agent,
			"content-type": "application/json",
			...init.headers,
		},
	});
	const text = await response.text();
	let body = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { response, body, text };
}

describe("fresh Rust auth boundary", () => {
	it("persists, scopes, expires, revokes, and keeps secrets private", async () => {
		let d = await daemon();
		try {
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
			const key = (created.body as any).apiKey.key as string;
			expect(key).toMatch(/^sig_sk_/);
			expect(created.text).not.toContain(admin);
			expect(JSON.stringify((await request(d.origin, "/api/auth/api-keys")).body)).not.toContain(key);
			expect((await request(d.origin, "/api/auth/whoami", {}, key)).response.status).toBe(200);
			expect((await request(d.origin, "/api/auth/api-keys", {}, key, "agent-b")).response.status).toBe(200);
			expect((await request(d.origin, "/api/auth/api-keys", {}, admin, "agent-b")).body.apiKeys).toEqual([]);
			expect(
				(
					await request(
						d.origin,
						"/api/auth/token",
						{ method: "POST", body: JSON.stringify({ role: "admin", scope: { agent: "agent-a" } }) },
						key,
					)
				).response.status,
			).toBe(403);
			expect([401, 403]).toContain(
				(
					await request(
						d.origin,
						"/api/auth/token",
						{ method: "POST", body: JSON.stringify({ role: "agent", scope: { agent: "agent-b" } }) },
						key,
					)
				).response.status,
			);
			const token = await request(d.origin, "/api/auth/token", {
				method: "POST",
				body: JSON.stringify({ role: "readonly", scope: { agent: "agent-a" }, ttlSeconds: 1 }),
			});
			expect(token.response.status).toBe(200);
			expect((token.body as any).token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
			await Bun.sleep(1200);
			const expired = await request(d.origin, "/api/auth/whoami", {}, (token.body as any).token);
			expect(expired.response.status).toBe(200);
			expect((expired.body as any).authenticated).toBe(false);
			await stop(d);
			d = await daemon(d.workspace);
			expect((await request(d.origin, "/api/auth/whoami", {}, key)).response.status).toBe(200);
			expect(
				(await request(d.origin, `/api/auth/api-keys/${(created.body as any).apiKey.id}`, { method: "DELETE" }))
					.response.status,
			).toBe(200);
			const revokedWhoami = await request(d.origin, "/api/auth/whoami", {}, key);
			expect(revokedWhoami.response.status).toBe(200);
			expect((revokedWhoami.body as any).authenticated).toBe(false);
			const malformed = await request(d.origin, "/api/auth/token", { method: "POST", body: "{" });
			expect(malformed.response.status).toBe(400);
			expect(malformed.text).not.toContain(admin);
			expect(
				(
					await request(d.origin, "/api/auth/token", {
						method: "POST",
						body: JSON.stringify({ role: "agent", padding: "x".repeat(70_000) }),
					})
				).response.status,
			).toBe(400);
		} finally {
			await stop(d);
			rmSync(d.workspace, { recursive: true, force: true });
		}
	});
});

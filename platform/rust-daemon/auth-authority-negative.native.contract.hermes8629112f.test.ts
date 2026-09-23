import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const admin = "fixture-admin-authority";
const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

it("rejects missing credentials, narrowed-scope omissions, overrides, and read-only mutation", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-auth-negative-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	writeFileSync(join(workspace, ".daemon", "auth-secret"), secret);
	const port = 39700 + Math.floor(Math.random() * 200);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: admin,
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	const origin = `http://127.0.0.1:${port}`;
	const call = (path: string, init: RequestInit = {}, credential?: string, agent = "agent-a") =>
		fetch(origin + path, {
			...init,
			headers: {
				authorization: credential ? `Bearer ${credential}` : "",
				"x-signet-agent": agent,
				"content-type": "application/json",
				...init.headers,
			},
		});
	try {
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(origin + "/health/ready")).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		expect((await call("/api/auth/api-keys", { method: "POST", body: "{}" })).status).toBe(401);
		const parent = await call(
			"/api/auth/api-keys",
			{
				method: "POST",
				body: JSON.stringify({
					name: "parent",
					role: "agent",
					scope: { agent: "agent-a", workspace: "scratch" },
					permissions: ["recall"],
				}),
			},
			admin,
		);
		expect(parent.status).toBe(201);
		const key = (await parent.json()).apiKey.key;
		expect(
			(
				await call(
					"/api/auth/token",
					{ method: "POST", body: JSON.stringify({ role: "agent", scope: { agent: "agent-a" } }) },
					key,
				)
			).status,
		).toBeGreaterThanOrEqual(401);
		expect(
			(
				await call(
					"/api/auth/token",
					{
						method: "POST",
						body: JSON.stringify({ role: "agent", scope: { agent: "agent-b", workspace: "scratch" } }),
					},
					key,
				)
			).status,
		).toBeGreaterThanOrEqual(401);
		const readonly = await call(
			"/api/auth/token",
			{ method: "POST", body: JSON.stringify({ role: "readonly", scope: { agent: "agent-a", workspace: "scratch" } }) },
			admin,
		);
		expect(readonly.status).toBe(200);
		const readonlyToken = (await readonly.json()).token;
		expect(
			(await call("/api/auth/api-keys", { method: "POST", body: JSON.stringify({ name: "nope" }) }, readonlyToken))
				.status,
		).toBe(403);
		expect((await call("/api/auth/whoami", {}, "not-a-credential")).status).toBe(200);
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		rmSync(workspace, { recursive: true, force: true });
	}
});

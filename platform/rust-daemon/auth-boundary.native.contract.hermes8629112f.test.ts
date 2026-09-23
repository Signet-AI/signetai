import { expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const admin = "boundary-admin";
const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 17 + 3) & 0xff);
const token = (claims: Record<string, unknown>) => {
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = createHmac("sha256", secret).update(payload).digest("base64url");
	return `${payload}.${signature}`;
};

it("requires admin permission for API-key listing and creation, and rejects malformed permissions claims", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-auth-boundary-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	writeFileSync(join(workspace, ".daemon", "auth-secret"), secret);
	const port = 39900 + Math.floor(Math.random() * 100);
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
	const call = (path: string, credential: string, init: RequestInit = {}) =>
		fetch(origin + path, {
			...init,
			headers: {
				authorization: `Bearer ${credential}`,
				"x-signet-agent": "agent-a",
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
		const readonly = await call("/api/auth/token", admin, {
			method: "POST",
			body: JSON.stringify({ role: "readonly", scope: { agent: "agent-a" } }),
		});
		expect(readonly.status).toBe(200);
		const readonlyToken = (await readonly.json()).token as string;
		expect((await call("/api/auth/api-keys", readonlyToken)).status).toBe(403);
		expect(
			(await call("/api/auth/api-keys", readonlyToken, { method: "POST", body: JSON.stringify({ name: "blocked" }) }))
				.status,
		).toBe(403);
		const malformed = token({
			sub: "malformed",
			role: "readonly",
			scope: { agent: "agent-a" },
			permissions: { recall: true },
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
		});
		expect((await call("/api/auth/api-keys", malformed)).status).toBe(401);
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		rmSync(workspace, { recursive: true, force: true });
	}
});

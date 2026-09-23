import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN") ??
	join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

describe("fresh Rust auth methods contract", () => {
	it("matches the current auth provider metadata contract", async () => {
		if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
		const workspace = mkdtempSync(join(tmpdir(), "signet-auth-methods-"));
		const port = 42000 + Math.floor(Math.random() * 1000);
		const child = Bun.spawn([bin], {
			env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
			stdout: "ignore",
			stderr: "pipe",
		});
		const origin = `http://127.0.0.1:${port}`;
		try {
			for (let i = 0; i < 160; i++) {
				try {
					if ((await fetch(`${origin}/health/ready`)).ok) break;
				} catch {}
				await Bun.sleep(25);
			}
			const response = await fetch(`${origin}/api/auth/methods`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				mode: "local",
				providers: [
					{ id: "password", type: "password", enabled: false, username: "admin" },
					{ id: "sso", type: "oidc", enabled: false, startPath: "/api/auth/sso/start" },
					{ id: "saml", type: "saml", enabled: false, startPath: "/api/auth/saml/start" },
				],
			});
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const bin =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

describe("fresh Rust auth/secrets/inference boundary", () => {
	it("exposes auth metadata and explicit unsupported provider/credential mutations", async () => {
		if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
		const workspace = mkdtempSync(join(tmpdir(), "signet-auth-boundary-"));
		const port = 41000 + Math.floor(Math.random() * 1000);
		const child = Bun.spawn([bin], {
			env: {
				...process.env,
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
				SIGNET_API_KEY: "admin",
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		const origin = `http://127.0.0.1:${port}`;
		try {
			for (let i = 0; i < 160; i++) {
				try {
					if ((await fetch(`${origin}/health/ready`)).ok) break;
				} catch {}
				await Bun.sleep(25);
			}
			const headers = {
				authorization: "Bearer admin",
				"x-signet-agent": "a",
				"x-signet-agent-id": "a",
				"content-type": "application/json",
			};
			const methods = await fetch(`${origin}/api/auth/methods`, { headers });
			expect(methods.status).toBe(200);
			expect((await methods.json()).providers).toEqual([{ id: "api-key", type: "api-key", enabled: true }]);
			const sso = await fetch(`${origin}/api/auth/sso/start`, { headers });
			expect(sso.status).toBe(501);
			const provider = await fetch(`${origin}/api/secrets/bitwarden/status`, {
				headers: { authorization: "Bearer admin", "x-signet-agent-id": "a" },
			});
			expect(provider.status).toBe(501);
			const inference = await fetch(`${origin}/api/inference/execute`, {
				method: "POST",
				headers: { authorization: "Bearer admin", "x-signet-agent": "a", "content-type": "application/json" },
				body: JSON.stringify({ prompt: "x" }),
			});
			expect(inference.status).toBe(501);
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});

/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
/* biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override */
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

it("matches the public whoami contract in local mode", async () => {
	const bin =
		process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
	const workspace = mkdtempSync(join(tmpdir(), "signet-whoami-"));
	const port = 40000 + Math.floor(Math.random() * 20000);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AUTH_MODE: "local",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	let stderr = "";
	const reader = child.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			stderr += decoder.decode(item.value);
		}
	})();
	const origin = `http://127.0.0.1:${port}`;
	try {
		for (let i = 0; i < 160; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const response = await fetch(`${origin}/api/auth/whoami?agentId=spoofed`, {
			headers: { authorization: "Bearer invalid" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			authenticated: false,
			trustedLocal: false,
			effectiveAccess: true,
			claims: null,
			mode: "local",
		});
		expect(body).not.toHaveProperty("agentId");
		expect(body).not.toHaveProperty("workspace");
		expect(Array.isArray(body.providers)).toBe(true);
	} finally {
		child.kill("SIGTERM");
		await Promise.race([
			child.exited,
			Bun.sleep(1000).then(() => {
				child.kill("SIGKILL");
			}),
		]);
		rmSync(workspace, { recursive: true, force: true });
	}
});

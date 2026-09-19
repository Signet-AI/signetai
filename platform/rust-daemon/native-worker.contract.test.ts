import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("runs DreamTrigger jobs through durable worker failure without provider", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-native-worker-"));
	const port = 39080 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: { ...process.env, SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		const origin = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const headers = { "content-type": "application/json", "x-signet-agent-id": "worker-contract" };
		const response = await fetch(`${origin}/api/dream/trigger`, {
			method: "POST",
			headers,
			body: JSON.stringify({ reason: "contract" }),
		});
		expect(response.ok).toBe(true);
		const created = (await response.json()) as { id: string; state: string };
		expect(created.state).toBe("queued");
		let terminal: Record<string, unknown> | undefined;
		for (let i = 0; i < 80; i++) {
			const current = await fetch(`${origin}/api/jobs/${created.id}`, { headers });
			if (current.ok) {
				const value = (await current.json()) as Record<string, unknown>;
				if (value.state === "failed") {
					terminal = value;
					break;
				}
			}
			await Bun.sleep(25);
		}
		expect(terminal?.state).toBe("failed");
		expect(String(terminal?.error)).toContain("unsupported external provider");
	} finally {
		child.kill();
		await child.exited;
	}
});

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract runner override
const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
async function run(payload: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "signet-native-worker-"));
	const port = 39080 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_MODE: "local",
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		const origin = `http://127.0.0.1:${port}`;
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(25);
		}
		expect(ready).toBe(true);
		const headers = {
			"content-type": "application/json",
			"x-signet-agent-id": "worker-contract",
			"x-workspace-id": "worker-workspace",
		};
		const response = await fetch(`${origin}/api/dream/trigger`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		expect(response.ok).toBe(true);
		const created = (await response.json()) as { id: string; state: string };
		expect(created.state).toBe("queued");
		for (let i = 0; i < 100; i++) {
			const current = await fetch(`${origin}/api/jobs/${created.id}`, { headers });
			if (current.ok) {
				const value = (await current.json()) as Record<string, unknown>;
				if (value.state === "completed" || value.state === "failed") return value;
			}
			await Bun.sleep(25);
		}
		throw new Error("job did not reach terminal state");
	} finally {
		child.kill();
		await child.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}
it("executes fixture DreamTrigger and persists scoped result/provenance", async () => {
	const value = await run({ provider: "fixture", content: "deterministic dream output" });
	expect(value.state).toBe("completed");
	expect(value.workspaceId).toBe("worker-workspace");
	expect(JSON.stringify(value.result)).toContain("provenance");
});
it("fails unavailable providers explicitly", async () => {
	const value = await run({ provider: "unavailable", content: "no-op" });
	expect(value.state).toBe("failed");
	expect(String(value.error)).toContain("provider unavailable");
});

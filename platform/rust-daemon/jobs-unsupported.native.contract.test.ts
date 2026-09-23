import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test override for compiled daemon
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(repoRoot, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
let port = 39270;

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000)]);
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("rejects provider-backed job execution explicitly instead of admitting a durable fake", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-job-unsupported-"));
	dirs.push(dir);
	const origin = `http://127.0.0.1:${port++}`;
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port - 1),
			SIGNET_AGENT_ID: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) break;
		} catch {}
		await Bun.sleep(25);
	}
	const response = await fetch(`${origin}/api/jobs`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-signet-agent-id": "agent-contract",
			"x-workspace-id": "workspace-contract",
		},
		body: JSON.stringify({ kind: "provider.inference", payload: { prompt: "must not run" } }),
	});
	expect(response.status).toBe(501);
	const body = await response.json();
	expect(body.error).toContain("unsupported");
});

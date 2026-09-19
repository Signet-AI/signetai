import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("keeps pipeline scope, pause admission, durable linkage, and unsupported execution explicit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-pipeline-contract-"));
	const port = 39180 + Math.floor(Math.random() * 100);
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
			} catch {
				/* starting */
			}
			await Bun.sleep(25);
		}
		const headers = {
			"content-type": "application/json",
			"x-signet-agent-id": "pipeline-contract",
			"x-workspace-id": "scope-a",
		};
		const paused = await fetch(`${origin}/api/pipeline/pause`, { method: "POST", headers });
		expect(paused.ok).toBe(true);
		const rejected = await fetch(`${origin}/api/dream/trigger`, { method: "POST", headers, body: "{}" });
		expect(rejected.status).toBe(400);
		expect((await rejected.json()).error).toContain("pipeline is paused");
		await fetch(`${origin}/api/pipeline/resume`, { method: "POST", headers });
		const created = await fetch(`${origin}/api/dream/trigger`, {
			method: "POST",
			headers,
			body: JSON.stringify({ contract: true }),
		});
		expect(created.ok).toBe(true);
		const job = (await created.json()) as { id: string; jobId: string; workspaceId: string; state: string };
		expect(job).toMatchObject({ jobId: job.id, workspaceId: "scope-a", state: "queued" });
		const otherScope = await fetch(`${origin}/api/jobs/${job.id}`, {
			headers: { ...headers, "x-workspace-id": "scope-b" },
		});
		expect(otherScope.status).toBe(404);
		let terminal: Record<string, unknown> | undefined;
		for (let i = 0; i < 100; i++) {
			const current = await fetch(`${origin}/api/jobs/${job.id}`, { headers });
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

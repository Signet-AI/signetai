import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = join(import.meta.dir, "target/debug/signet-daemon");

it("returns explicit unsupported responses for unbacked MCP analytics", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "signet-mcp-boundary-"));
	const port = 3967;
	const child = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
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
		const response = await fetch(`${origin}/api/mcp/analytics`, {
			headers: { "x-signet-agent-id": "boundary-agent" },
		});
		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({ error: "unsupported", operation: "mcp analytics" });
	} finally {
		child.kill();
		await child.exited.catch(() => {});
		await rm(workspace, { recursive: true, force: true });
	}
});

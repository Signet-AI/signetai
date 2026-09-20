import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = join(import.meta.dir, "target/debug/signet-daemon");

it("returns explicit unsupported responses for unbacked MCP analytics", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "signet-mcp-boundary-"));
	const port = 3967;
	const child = Bun.spawn([binary], {
		env: {
			...process.env,
			SIGNET_API_KEY: "boundary-api-key",
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
		},
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
		const unauthenticated = await fetch(`${origin}/api/mcp/analytics`);
		expect(unauthenticated.status).toBe(401);
		expect(await unauthenticated.json()).toMatchObject({ code: "unauthorized" });

		const authorized = await fetch(`${origin}/api/mcp/analytics`, {
			headers: { Authorization: "Bearer boundary-api-key" },
		});
		expect(authorized.status).toBe(501);
		expect(await authorized.json()).toMatchObject({ error: "unsupported", operation: "mcp analytics" });
	} finally {
		child.kill();
		await child.exited.catch(() => {});
		await rm(workspace, { recursive: true, force: true });
	}
});
